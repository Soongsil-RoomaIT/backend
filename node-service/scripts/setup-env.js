import {randomBytes} from 'node:crypto';
import {writeFileSync, appendFileSync, readFileSync, mkdirSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = new URL('../../', import.meta.url);
const envFile = new URL('.env', root);
const defaults = {
  KEYCLOAK_ADMIN_PASSWORD: () => randomBytes(24).toString('hex'),
  POSTGRES_PASSWORD: () => randomBytes(24).toString('hex'),
  DATA_ENCRYPTION_KEY_BASE64: () => randomBytes(32).toString('base64'),
  AUTOMATION_CLIENT_SECRET: () => randomBytes(32).toString('hex'),
  GRAFANA_ADMIN_PASSWORD: () => randomBytes(18).toString('hex'),
  CLOUD_SERVICE_URL: () => 'http://host.docker.internal:8081',
  NODE_ENV: () => 'production', DEV_AUTH_BYPASS: () => 'false',
  CORS_ORIGINS: () => 'http://localhost:5173', FCM_ENABLED: () => 'false'
};
if (!existsSync(envFile)) {
  const lines = Object.entries(defaults).map(([key, make]) => `${key}=${make()}`);
  writeFileSync(envFile, lines.join('\n') + '\n', {flag: 'wx', mode: 0o600});
  console.log('Created local .env with random credentials (values are not printed).');
} else {
  // Keep every existing value; only append keys introduced by newer versions.
  const text = readFileSync(envFile, 'utf8');
  const present = new Set(text.split(/\r?\n/).map(line => line.split('=')[0].trim()).filter(Boolean));
  const missing = Object.keys(defaults).filter(key => !present.has(key));
  if (missing.length) {
    appendFileSync(envFile, (text.endsWith('\n') || !text ? '' : '\n') + missing.map(key => `${key}=${defaults[key]()}`).join('\n') + '\n');
    console.log(`Existing .env preserved; added missing keys: ${missing.join(', ')}`);
  } else console.log('Existing .env preserved.');
}
mkdirSync(fileURLToPath(new URL('secrets/', root)), {recursive: true});
