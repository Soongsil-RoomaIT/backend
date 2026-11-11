// Verifies the running Compose stack (docker compose up -d --build) from the host.
// Public traffic goes through nginx on :80; internal-only endpoints are exercised inside the gateway container.
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const base = process.env.SMOKE_BASE_URL ?? 'http://localhost';
const root = new URL('../../', import.meta.url);

async function call(path, {method = 'GET', body, expected = 200} = {}) {
  const response = await fetch(base + path, {method, headers: body ? {'content-type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000)});
  assert.equal(response.status, expected, `${method} ${path}: unexpected HTTP status`);
  const text = await response.text();
  return text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
}
// Runs a fetch from inside the gateway container (Compose network) and returns {status, body}.
function insideGateway(path, {method = 'GET', body, headers = {}} = {}) {
  const script = `fetch('http://127.0.0.1:8080${path}',{method:${JSON.stringify(method)},headers:Object.assign(${JSON.stringify(headers)},` +
    `process.env.SMOKE_INTERNAL?{'x-internal-key':process.env.INTERNAL_API_KEY,'content-type':'application/json'}:{}),` +
    `body:${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'}}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()})))`;
  const output = execFileSync('docker', ['compose', 'exec', '-T', '-e', `SMOKE_INTERNAL=${body ? '1' : ''}`, 'gateway-service', 'node', '-e', script],
    {cwd: root, encoding: 'utf8'});
  return JSON.parse(output.trim().split('\n').at(-1));
}

const deadline = Date.now() + 60_000;
let ready = false;
while (Date.now() < deadline) {
  try { if ((await fetch(`${base}/api/notifications`, {signal: AbortSignal.timeout(2000)})).ok) { ready = true; break; } }
  catch { /* nginx or gateway may still be starting. */ }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(ready, 'nginx → gateway did not become ready within 60 seconds');

assert.ok(Array.isArray(await call('/api/notifications')));
await call('/internal/notifications', {method: 'POST', expected: 404, body: {}});
await call('/actuator/prometheus', {expected: 404});
console.log('PASS nginx serves /api without login and hides /internal and /actuator');

const rejected = insideGateway('/internal/notifications', {method: 'POST', headers: {'x-internal-key': 'wrong-key'}});
assert.equal(rejected.status, 401);
const event = {eventId: `smoke-${randomUUID()}`, title: 'Local smoke test', body: 'Docker Redis dry-run verification', data: {source: 'smoke'}};
await call('/api/push/token', {method: 'POST', expected: 204, body: {token: 'local-smoke-not-a-real-fcm-token'}});
const sent = insideGateway('/internal/notifications', {method: 'POST', body: event});
assert.equal(sent.status, 200);
const result = JSON.parse(sent.body);
assert.equal(result.status, 'dry-run'); assert.ok(result.targetCount >= 1);
assert.equal(JSON.parse(insideGateway('/internal/notifications', {method: 'POST', body: event}).body).status, 'duplicate');
assert.ok((await call('/api/notifications')).some(n => n.id === event.eventId));
await call('/api/push/token', {method: 'DELETE', expected: 204, body: {token: 'local-smoke-not-a-real-fcm-token'}});
console.log('PASS internal notification with X-Internal-Key, dry-run, deduplication, history and token removal');

const readiness = JSON.parse(insideGateway('/actuator/health/readiness').body);
assert.equal(readiness.components.redis.status, 'UP');
console.log(`PASS readiness (redis UP, cloud ${readiness.components.cloud.status})`);
const metrics = insideGateway('/actuator/prometheus').body;
assert.ok(metrics.includes('gateway_notifications_total{status="dry-run"}'));
assert.ok(metrics.includes('gateway_dependency_up{dependency="redis"} 1'));
console.log('PASS Prometheus metrics');
