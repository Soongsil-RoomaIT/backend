import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const env = Object.fromEntries(readFileSync(new URL('../../.env',import.meta.url),'utf8').trim().split(/\r?\n/).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
const auth='http://localhost:8180';
const gateway='http://localhost:8080';
const clientId=`local-smoke-${randomUUID()}`;
const clientSecret=randomUUID();
let adminToken, clientUuid;
async function call(url,{token,body,method='GET',expected=200,form=false}={}) {
  const response=await fetch(url,{method,headers:{...(token?{authorization:`Bearer ${token}`}:{}) ,...(body?{'content-type':form?'application/x-www-form-urlencoded':'application/json'}:{})},body:body?(form?new URLSearchParams(body):JSON.stringify(body)):undefined,signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,expected,`${method} ${new URL(url).pathname}: unexpected HTTP status`);
  const text=await response.text();return text?JSON.parse(text):null;
}
async function token(realm,body){return(await call(`${auth}/realms/${realm}/protocol/openid-connect/token`,{method:'POST',form:true,body})).access_token;}
const adminPath=`${auth}/admin/realms/room-care`;
const deadline=Date.now()+60_000;
let ready=false;
while(Date.now()<deadline){
  try {
    const response=await fetch(`${auth}/realms/room-care/.well-known/openid-configuration`,{signal:AbortSignal.timeout(2000)});
    if(response.ok){ready=true;break;}
  } catch { /* Keycloak may still be importing the realm. */ }
  await new Promise(resolve=>setTimeout(resolve,1000));
}
assert.ok(ready,'Keycloak room-care realm did not become ready within 60 seconds');
try {
  adminToken=await token('master',{grant_type:'password',client_id:'admin-cli',username:'admin',password:env.KEYCLOAK_ADMIN_PASSWORD});
  console.log('PASS Keycloak administrator login');
  await call(`${adminPath}/clients`,{token:adminToken,method:'POST',expected:201,body:{clientId,secret:clientSecret,enabled:true,serviceAccountsEnabled:true,standardFlowEnabled:false,protocolMappers:[
    {name:'api-audience',protocol:'openid-connect',protocolMapper:'oidc-audience-mapper',config:{'included.custom.audience':'room-care-api','access.token.claim':'true'}},
    {name:'roles',protocol:'openid-connect',protocolMapper:'oidc-usermodel-realm-role-mapper',config:{'claim.name':'roles','jsonType.label':'String',multivalued:'true','access.token.claim':'true'}}
  ]}});
  clientUuid=(await call(`${adminPath}/clients?clientId=${clientId}`,{token:adminToken}))[0].id;
  const getToken=()=>token('room-care',{grant_type:'client_credentials',client_id:clientId,client_secret:clientSecret});
  let access=await getToken();
  await call(`${gateway}/api/notifications`,{expected:401});
  const headers={token:access};
  assert.deepEqual(await call(`${gateway}/api/notifications`,headers),[]);
  await call(`${gateway}/api/notifications/send`,{...headers,method:'POST',expected:403,body:{}});
  console.log('PASS real JWT validation and non-ADMIN rejection');
  const user=await call(`${adminPath}/clients/${clientUuid}/service-account-user`,{token:adminToken});
  const role=await call(`${adminPath}/roles/ADMIN`,{token:adminToken});
  await call(`${adminPath}/users/${user.id}/role-mappings/realm`,{token:adminToken,method:'POST',expected:204,body:[role]});
  access=await getToken();
  const event={eventId:`smoke-${randomUUID()}`,userId:user.id,title:'Local smoke test',body:'Docker Redis dry-run verification',data:{source:'smoke'}};
  await call(`${gateway}/api/push/token`,{token:access,method:'POST',expected:204,body:{token:'local-smoke-not-a-real-fcm-token'}});
  const sent=await call(`${gateway}/api/notifications/send`,{token:access,method:'POST',body:event});
  assert.equal(sent.status,'dry-run');assert.equal(sent.targetCount,1);
  const duplicate=await call(`${gateway}/api/notifications/send`,{token:access,method:'POST',body:event});
  assert.equal(duplicate.status,'duplicate');
  const history=await call(`${gateway}/api/notifications`,{token:access});
  assert.equal(history.length,1);assert.equal(history[0].id,event.eventId);
  await call(`${gateway}/api/push/token`,{token:access,method:'DELETE',expected:204,body:{token:'local-smoke-not-a-real-fcm-token'}});
  console.log('PASS Redis-backed token registration, ADMIN dry-run, deduplication, history and removal');
  const health=await call(`${gateway}/actuator/health`);assert.equal(health.status,'UP');
  const metrics=await fetch(`${gateway}/actuator/prometheus`);assert.equal(metrics.status,200);assert.ok((await metrics.text()).includes('process_cpu'));
  console.log('PASS health and Prometheus metrics');
} finally {
  if(clientUuid&&adminToken){await call(`${adminPath}/clients/${clientUuid}`,{token:adminToken,method:'DELETE',expected:204});console.log('Removed temporary Keycloak smoke-test client');}
}
