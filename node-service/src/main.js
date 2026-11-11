import { createClient } from 'redis';
import pino from 'pino';
import { Registry, collectDefaultMetrics } from 'prom-client';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { cipher } from './security.js';
import { Notifications } from './notifications.js';
import { cloudCheck, createApp } from './app.js';

const logger = pino();
const config = {
  port: Number(process.env.PORT ?? 8080), cloud: process.env.CLOUD_SERVICE_URL ?? 'http://localhost:8081',
  origins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map(s => s.trim()),
  // There is no user login: every browser request acts as this single room user.
  roomUser: process.env.ROOM_USER_ID ?? 'room-user',
  // Shared secret the Cloud Server sends as X-Internal-Key to POST /internal/notifications.
  internalKey: process.env.INTERNAL_API_KEY ?? '',
  trustProxy: process.env.TRUST_PROXY ?? false,
  timeout: 5000, heartbeat: 15000,
  cloudHealthPath: process.env.CLOUD_HEALTH_PATH ?? '/health'
};
if (config.internalKey && config.internalKey.length < 32) throw new Error('INTERNAL_API_KEY must be at least 32 characters');
if (!config.internalKey) logger.warn('INTERNAL_API_KEY not set: POST /internal/notifications is disabled');
logger.warn({roomUser: config.roomUser}, 'No user login: expose the gateway only through the Compose nginx on a trusted network');
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
const checks = {
  redis: async () => { if (!redis.isReady) throw new Error('Redis not ready'); await redis.ping(); },
  cloud: cloudCheck(config)
};
const {server, wss} = createApp({config, notifications, logger, registry, checks});
server.listen(config.port, () => logger.info({port: config.port}, 'Gateway ready'));
async function stop() {
  for (const client of wss.clients) client.terminate();
  server.close(); wss.close();
  await redis.quit();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
