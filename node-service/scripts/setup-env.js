import {randomBytes} from 'node:crypto';
import {writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = new URL('../../', import.meta.url);
const values = [
  `KEYCLOAK_ADMIN_PASSWORD=${randomBytes(24).toString('hex')}`,
  `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
  `DATA_ENCRYPTION_KEY_BASE64=${randomBytes(32).toString('base64')}`,
  'CLOUD_SERVICE_URL=http://host.docker.internal:8081',
  'NODE_ENV=production', 'DEV_AUTH_BYPASS=false',
  'CORS_ORIGINS=http://localhost:5173', 'FCM_ENABLED=false'
];
try {
  writeFileSync(new URL('.env',root),values.join('\n')+'\n',{flag:'wx',mode:0o600});
  console.log('Created local .env with random credentials (values are not printed).');
} catch(error) {
  if(error.code!=='EEXIST')throw error;
  console.log('Existing .env preserved.');
}
mkdirSync(fileURLToPath(new URL('secrets/',root)),{recursive:true});
