import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { Counter, Gauge, Histogram } from 'prom-client';
const API_SEGMENTS = new Set(['sensors', 'devices', 'edge', 'forecast', 'decisions', 'settings']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
// Command deduplication key generated per button press by the web app; C rejects live commands without it.
const IDEMPOTENCY_KEY = /^[!-~]{1,200}$/;

// Bounded route label so arbitrary request paths cannot explode Prometheus cardinality.
export function routeLabel(path) {
  if (['/actuator/health', '/actuator/health/liveness', '/actuator/health/readiness', '/actuator/prometheus', '/ws', '/api/push/token', '/api/notifications', '/internal/notifications'].includes(path)) return path;
  if (path.startsWith('/internal/')) return '/internal/other';
  const match = /^\/api\/([^/]+)/.exec(path);
  if (!match) return 'other';
  return API_SEGMENTS.has(match[1]) ? `/api/${match[1]}` : '/api/other';
}

// Readiness check for the C cloud server: any non-5xx HTTP answer means it is reachable.
export function cloudCheck(config) {
  return async () => {
    const response = await fetch(new URL(config.cloudHealthPath ?? '/', config.cloud), {signal: AbortSignal.timeout(config.timeout), redirect: 'manual'});
    await response.body?.cancel();
    if (response.status >= 500) throw new Error(`Cloud server returned ${response.status}`);
  };
}

// Runs every dependency check with a deadline; failures are reported as DOWN without error details.
async function runChecks(checks, timeout) {
  const entries = await Promise.all(Object.entries(checks).map(async ([name, check]) => {
    let timer;
    try {
      await Promise.race([check(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeout); })]);
      return [name, {status: 'UP'}];
    } catch { return [name, {status: 'DOWN'}]; }
    finally { clearTimeout(timer); }
  }));
  return {status: entries.every(([, c]) => c.status === 'UP') ? 'UP' : 'DOWN', components: Object.fromEntries(entries)};
}

function createMetrics(registry, readiness) {
  const registers = [registry];
  return {
    // Evaluated on each Prometheus scrape so alerts see Redis/C server outages without traffic.
    dependencyUp: new Gauge({name: 'gateway_dependency_up', help: 'Gateway dependency readiness (1 = up)',
      labelNames: ['dependency'], registers, async collect() {
        for (const [name, c] of Object.entries((await readiness()).components)) this.set({dependency: name}, c.status === 'UP' ? 1 : 0);
      }}),
    http: new Histogram({name: 'http_server_request_duration_seconds', help: 'Gateway HTTP request duration',
      labelNames: ['method', 'route', 'status_code'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers}),
    wsClients: new Gauge({name: 'gateway_websocket_clients', help: 'Open browser WebSocket connections', registers}),
    upstreamFailures: new Counter({name: 'gateway_cloud_upstream_failures_total', help: 'Failed calls to the C cloud server',
      labelNames: ['transport'], registers}),
    notifications: new Counter({name: 'gateway_notifications_total', help: 'Notification send results by status',
      labelNames: ['status'], registers})
  };
}

const keyDigest = value => createHash('sha256').update(value).digest();

export function createApp({config, notifications, logger, registry, checks = {}}) {
  const readiness = () => runChecks(checks, config.timeout);
  const metrics = createMetrics(registry, readiness);
  const internalKey = config.internalKey ? keyDigest(config.internalKey) : null;
  const app = express();
  app.disable('x-powered-by');
  // Behind the Compose nginx: rate limits use the browser address from X-Forwarded-For.
  app.set('trust proxy', config.trustProxy ?? false);
  app.use((req, res, next) => {
    req.id = randomUUID(); res.set('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      // Array-registered routes expose every alias in route.path, so label those by the requested path.
      const route = typeof req.route?.path === 'string' ? (req.baseUrl ?? '') + req.route.path : routeLabel(req.originalUrl.split('?')[0]);
      metrics.http.observe({method: METHODS.has(req.method) ? req.method : 'OTHER', route, status_code: String(res.statusCode)}, seconds);
      logger.info({requestId: req.id, method: req.method, route, status: res.statusCode, durationMs: Math.round(seconds*1000)}, 'HTTP request');
    });
    next();
  });
  app.use(cors({origin: config.origins, credentials: true,
    allowedHeaders: ['Content-Type', 'Idempotency-Key'], exposedHeaders: ['X-Request-Id']}));
  // Liveness only: the process is serving. Readiness additionally requires Redis and the C server.
  app.get(['/actuator/health', '/actuator/health/liveness'], (_req, res) => res.json({status: 'UP'}));
  app.get('/actuator/health/readiness', async (_req, res) => {
    const result = await readiness();
    res.status(result.status === 'UP' ? 200 : 503).json(result);
  });
  app.get('/actuator/prometheus', async (_req, res) => {
    res.type(registry.contentType).send(await registry.metrics());
  });
  app.use(rateLimit({windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false}));
  app.use(express.json({limit: '64kb'}));
  // No user login (SAD v1.2 single household): every browser request belongs to the single room user.
  const user = config.roomUser;
  app.post('/api/push/token', async (req, res) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || !token.trim() || token.length > 4096) return res.status(400).json({message: 'token must be a nonempty string'});
    await notifications.register(user, token); res.sendStatus(204);
  });
  app.delete('/api/push/token', async (req, res) => {
    if (typeof req.body?.token !== 'string' || !req.body.token) return res.status(400).json({message: 'token is required'});
    await notifications.remove(user, req.body.token); res.sendStatus(204);
  });
  app.get('/api/notifications', async (_req, res) => res.json(await notifications.list(user)));
  // Cloud Server only: Compose-internal network, shared secret header. nginx never proxies /internal.
  app.post('/internal/notifications', async (req, res) => {
    if (!internalKey) return res.status(503).json({message: 'INTERNAL_API_KEY is not configured'});
    const key = req.get('x-internal-key');
    if (typeof key !== 'string' || !timingSafeEqual(keyDigest(key), internalKey)) return res.status(401).json({message: 'Invalid internal key'});
    const event = req.body;
    if (!event || ['eventId','title','body'].some(k => typeof event[k] !== 'string' || !event[k].trim() || event[k].length > 4096)
      || (event.data !== undefined && (event.data === null || Array.isArray(event.data) || typeof event.data !== 'object' || Object.values(event.data).some(v => typeof v !== 'string')))) {
      return res.status(400).json({message: 'Invalid notification event'});
    }
    let result;
    try { result = await notifications.send({eventId: event.eventId, userId: user, title: event.title, body: event.body, data: event.data}); }
    catch (error) { metrics.notifications.inc({status: 'error'}); throw error; }
    metrics.notifications.inc({status: result.status});
    if (result.status !== 'duplicate') {
      const {eventId: _eventId, ...notification} = result;
      broadcast({type: 'notification.new', payload: notification});
    }
    res.json(result);
  });
  app.use('/api', async (req, res) => {
    if (!['GET','POST','PUT','PATCH','DELETE'].includes(req.method)) return res.sendStatus(405);
    try {
      // Fixed destination; never honor caller-supplied host or identity headers.
      const url = new URL(config.cloud);
      url.pathname = req.originalUrl.split('?')[0];
      url.search = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      const headers = {'x-request-id': req.id};
      const idempotencyKey = req.get('idempotency-key');
      if (idempotencyKey !== undefined) {
        if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return res.status(400).json({message: 'Invalid Idempotency-Key', requestId: req.id});
        headers['idempotency-key'] = idempotencyKey;
      }
      let body;
      if (!['GET','HEAD'].includes(req.method) && req.body !== undefined) {
        headers['content-type'] = 'application/json'; body = JSON.stringify(req.body);
      }
      const response = await fetch(url, {method: req.method, headers, body, signal: AbortSignal.timeout(config.timeout), redirect: 'manual'});
      res.status(response.status);
      if (response.headers.get('content-type')) res.set('Content-Type', response.headers.get('content-type'));
      res.send(Buffer.from(await response.arrayBuffer()));
    } catch {
      metrics.upstreamFailures.inc({transport: 'rest'});
      res.status(502).json({message: 'Cloud service unavailable', requestId: req.id});
    }
  });
  app.use((_req, res) => res.sendStatus(404));
  app.use((err, req, res, _next) => {
    logger.error({requestId: req.id, errorType: err.name}, 'Request failed');
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 503;
    res.status(status).json({message: status < 500 ? 'Invalid request' : 'Service unavailable', requestId: req.id});
  });
  const server = createServer(app);
  const wss = new WebSocketServer({noServer: true, maxPayload: 64*1024});
  // Gateway-originated events (notification.new) go to every open browser socket, with or without FCM.
  function broadcast(message) {
    const text = JSON.stringify(message);
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(text);
  }
  server.on('upgrade', (req, socket, head) => {
    // Allowed: configured dev origins (Vite) or the same origin the Compose nginx serves the web app from.
    const origin = req.headers.origin;
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === req.headers.host; } catch { /* Missing or invalid Origin. */ }
    if (req.url !== '/ws' || !(config.origins.includes(origin) || sameOrigin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', client => {
    metrics.wsClients.inc();
    let upstream, heartbeat;
    const send = value => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
    const start = async () => {
      try {
        const response = await fetch(new URL('/api/edge/status', config.cloud), {signal: AbortSignal.timeout(config.timeout)});
        if (!response.ok) throw new Error('Edge status unavailable');
        const status = await response.json();
        if (typeof status.online !== 'boolean' || typeof status.offlineMode !== 'boolean' || typeof status.lastSeenAt !== 'string') throw new Error('Invalid EdgeStatus');
        if (client.readyState !== WebSocket.OPEN) return;
        send({type: 'edge.status', payload: status});
        heartbeat = setInterval(() => send({type: 'heartbeat'}), config.heartbeat);
        const url = new URL('/ws', config.cloud); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        upstream = new WebSocket(url, {handshakeTimeout: config.timeout});
        upstream.on('message', (data, binary) => {
          if (binary || client.readyState !== WebSocket.OPEN) return;
          try {
            const message = JSON.parse(data.toString());
            if (['edge.status','sensor.update','device.state','edge.recovered','command.ack'].includes(message.type)) client.send(data.toString());
          } catch { /* Ignore malformed upstream frames. */ }
        });
        upstream.on('error', () => { metrics.upstreamFailures.inc({transport: 'ws'}); client.close(1011, 'Cloud WebSocket unavailable'); });
        upstream.on('close', () => client.close(1011, 'Cloud WebSocket disconnected'));
      } catch {
        metrics.upstreamFailures.inc({transport: 'ws'});
        client.close(1011, 'Cloud connection failed');
      }
    };
    client.on('message', (raw, binary) => {
      if (binary) return;
      try {
        if (JSON.parse(raw.toString()).type === 'ping' && heartbeat) send({type: 'heartbeat'});
      } catch { /* Ignore malformed client frames. */ }
    });
    client.on('error', () => client.close());
    client.on('close', () => {
      metrics.wsClients.dec();
      clearInterval(heartbeat);
      upstream?.close();
    });
    void start();
  });
  return {app, server, wss};
}
