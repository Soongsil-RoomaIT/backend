import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { bearer } from './security.js';

export function createApp({config, verify, notifications, logger, registry}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.id = randomUUID(); res.set('X-Request-Id', req.id);
    const start = Date.now();
    res.on('finish', () => logger.info({requestId: req.id, method: req.method, status: res.statusCode, durationMs: Date.now()-start}, 'HTTP request'));
    next();
  });
  app.use(cors({origin: config.origins, credentials: true}));
  app.get('/actuator/health', (_req, res) => res.json({status: 'UP'}));
  app.get('/actuator/prometheus', async (_req, res) => {
    res.type(registry.contentType).send(await registry.metrics());
  });
  app.use(rateLimit({windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false}));
  app.use(express.json({limit: '64kb'}));
  app.use(async (req, res, next) => {
    try { req.user = await verify(bearer(req)); next(); }
    catch { res.status(401).json({message: 'Invalid or missing access token'}); }
  });
  app.post('/api/push/token', async (req, res) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || !token.trim() || token.length > 4096) return res.status(400).json({message: 'token must be a nonempty string'});
    await notifications.register(req.user.sub, token); res.sendStatus(204);
  });
  app.delete('/api/push/token', async (req, res) => {
    if (typeof req.body?.token !== 'string' || !req.body.token) return res.status(400).json({message: 'token is required'});
    await notifications.remove(req.user.sub, req.body.token); res.sendStatus(204);
  });
  app.get('/api/notifications', async (req, res) => res.json(await notifications.list(req.user.sub)));
  app.post('/api/notifications/send', async (req, res) => {
    const roles = req.user.roles ?? req.user.realm_access?.roles ?? [];
    if (!roles.includes('ADMIN')) return res.status(403).json({message: 'ADMIN role required'});
    const event = req.body;
    if (!event || ['eventId','userId','title','body'].some(key => typeof event[key] !== 'string' || !event[key].trim() || event[key].length > 4096)
      || (event.data !== undefined && (event.data === null || Array.isArray(event.data) || typeof event.data !== 'object' || Object.values(event.data).some(v => typeof v !== 'string')))) {
      return res.status(400).json({message: 'Invalid notification event'});
    }
    res.json(await notifications.send(event));
  });
  app.use('/api', async (req, res) => {
    if (!['GET','POST','PUT','PATCH','DELETE'].includes(req.method)) return res.sendStatus(405);
    try {
      // Fixed destination; never honor caller-supplied host or identity headers.
      const url = new URL(config.cloud);
      url.pathname = req.originalUrl.split('?')[0];
      url.search = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      const headers = {'x-request-id': req.id};
      if (bearer(req)) headers.authorization = `Bearer ${bearer(req)}`;
      let body;
      if (!['GET','HEAD'].includes(req.method) && req.body !== undefined) {
        headers['content-type'] = 'application/json'; body = JSON.stringify(req.body);
      }
      const response = await fetch(url, {method: req.method, headers, body, signal: AbortSignal.timeout(config.timeout), redirect: 'manual'});
      res.status(response.status);
      if (response.headers.get('content-type')) res.set('Content-Type', response.headers.get('content-type'));
      res.send(Buffer.from(await response.arrayBuffer()));
    } catch { res.status(502).json({message: 'Cloud service unavailable', requestId: req.id}); }
  });
  app.use((_req, res) => res.sendStatus(404));
  app.use((err, req, res, _next) => {
    logger.error({requestId: req.id, errorType: err.name}, 'Request failed');
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 503;
    res.status(status).json({message: status < 500 ? 'Invalid request' : 'Service unavailable', requestId: req.id});
  });
  const server = createServer(app);
  const wss = new WebSocketServer({noServer: true, maxPayload: 64*1024});
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !config.origins.includes(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', client => {
    let upstream, heartbeat, expiry, started = false;
    const authTimeout = setTimeout(() => client.close(1008, 'Authentication timeout'), 5000);
    const send = value => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
    const start = async token => {
      if (started) return;
      started = true;
      try {
        const user = await verify(token);
        clearTimeout(authTimeout);
        expiry = setTimeout(() => client.close(1008, 'Token expired'), Math.min((user.exp*1000-Date.now()), 2147483647));
        const headers = token ? {authorization: `Bearer ${token}`} : {};
        const response = await fetch(new URL('/api/edge/status', config.cloud), {headers, signal: AbortSignal.timeout(config.timeout)});
        if (!response.ok) throw new Error('Edge status unavailable');
        const status = await response.json();
        if (typeof status.online !== 'boolean' || typeof status.offlineMode !== 'boolean' || typeof status.lastSeenAt !== 'string') throw new Error('Invalid EdgeStatus');
        if (client.readyState !== WebSocket.OPEN) return;
        send({type: 'edge.status', payload: status});
        heartbeat = setInterval(() => send({type: 'heartbeat'}), config.heartbeat);
        const url = new URL('/ws', config.cloud); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        upstream = new WebSocket(url, {headers, handshakeTimeout: config.timeout});
        upstream.on('message', (data, binary) => {
          if (binary || client.readyState !== WebSocket.OPEN) return;
          try {
            const message = JSON.parse(data.toString());
            if (['edge.status','sensor.update','device.state','edge.recovered','command.ack'].includes(message.type)) client.send(data.toString());
          } catch { /* Ignore malformed upstream frames. */ }
        });
        upstream.on('error', () => client.close(1011, 'Cloud WebSocket unavailable'));
        upstream.on('close', () => client.close(1011, 'Cloud WebSocket disconnected'));
      } catch { client.close(1011, 'Authentication or cloud connection failed'); }
    };
    client.on('message', (raw, binary) => {
      if (binary) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'auth' && typeof message.payload?.token === 'string') void start(message.payload.token);
        else if (message.type === 'ping' && heartbeat) send({type: 'heartbeat'});
      } catch { /* Ignore malformed client frames. */ }
    });
    client.on('error', () => client.close());
    client.on('close', () => {
      clearTimeout(authTimeout); clearTimeout(expiry); clearInterval(heartbeat);
      upstream?.close();
    });
    if (config.devAuth) void start();
  });
  return {app, server, wss};
}
