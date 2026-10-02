import { createClient } from 'redis';
import pino from 'pino';
import { Registry, collectDefaultMetrics } from 'prom-client';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { cipher, verifier } from './security.js';
import { Notifications } from './notifications.js';
import { createApp } from './app.js';

const logger = pino();
const config = {
  port: Number(process.env.PORT ?? 8080), cloud: process.env.CLOUD_SERVICE_URL ?? 'http://localhost:8081',
  origins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map(s => s.trim()),
  devAuth: process.env.DEV_AUTH_BYPASS === 'true',
  issuer: process.env.JWT_ISSUER_URI ?? 'http://localhost:8180/realms/room-care',
  jwks: process.env.JWT_JWK_SET_URI ?? 'http://localhost:8180/realms/room-care/protocol/openid-connect/certs',
  audience: process.env.JWT_AUDIENCE ?? 'room-care-api', timeout: 5000, heartbeat: 15000
};
if (config.devAuth && process.env.NODE_ENV !== 'development') throw new Error('DEV_AUTH_BYPASS requires NODE_ENV=development');
if (config.devAuth) logger.warn('Development authentication bypass enabled; ADMIN APIs remain forbidden');
const encryption = cipher(process.env.DATA_ENCRYPTION_KEY_BASE64);
const redis = createClient({url: process.env.REDIS_URL ?? 'redis://localhost:6379'});
redis.on('error', () => logger.error('Redis connection error'));
await redis.connect();
let sender = async () => ({status: 'dry-run', successCount: 0});
if (process.env.FCM_ENABLED === 'true') {
  initializeApp({credential: applicationDefault()});
  sender = async (tokens, event) => {
    if (!tokens.length) return {status: 'no-targets', successCount: 0};
    const result = await getMessaging().sendEachForMulticast({tokens, notification: {title: event.title, body: event.body}, data: event.data ?? {}});
    const invalidTokens = result.responses.flatMap((r, i) => ['messaging/invalid-registration-token','messaging/registration-token-not-registered'].includes(r.error?.code) ? [tokens[i]] : []);
    return {status: result.failureCount ? 'partial-failure' : 'sent', successCount: result.successCount, invalidTokens};
  };
} else logger.warn('FCM disabled: notification delivery is dry-run');
const registry = new Registry(); collectDefaultMetrics({register: registry});
const notifications = new Notifications(redis, encryption, sender);
const {server, wss} = createApp({config, verify: verifier(config), notifications, logger, registry});
server.listen(config.port, () => logger.info({port: config.port}, 'Gateway ready'));
async function stop() {
  for (const client of wss.clients) client.terminate();
  server.close(); wss.close();
  await redis.quit();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
