import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {WebSocket, WebSocketServer} from 'ws';
import {Registry} from 'prom-client';
import {cipher, verifier} from '../src/security.js';
import {Notifications} from '../src/notifications.js';
import {createApp} from '../src/app.js';

const logger = {info(){}, error(){}};
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
function close(server) { server.closeAllConnections?.(); server.close(); }
const config = {origins: ['http://localhost:5173'], devAuth: true, heartbeat: 30, timeout: 200};

test('AES-GCM round trip, randomized IV and tampering rejection', () => {
  const encryption = cipher(Buffer.alloc(32, 1).toString('base64'));
  const one = encryption.encrypt('private-token');
  assert.equal(encryption.decrypt(one), 'private-token');
  assert.notEqual(one, encryption.encrypt('private-token'));
  const data = Buffer.from(one, 'base64'); data[28] ^= 1;
  assert.throws(() => encryption.decrypt(data.toString('base64')));
  assert.throws(() => cipher('invalid'));
});

test('JWT verifies issuer, audience, expiry and signature through JWKS', async t => {
  const {privateKey, publicKey} = await generateKeyPair('RS256');
  const key = await exportJWK(publicKey); key.kid = 'test-key';
  const jwks = createServer((_req,res) => {res.setHeader('content-type','application/json'); res.end(JSON.stringify({keys:[key]}));});
  const issuer = await listen(jwks); t.after(() => close(jwks));
  const verify = verifier({issuer, jwks:issuer, audience:'room-care-api'});
  const token = async (aud='room-care-api', exp='1m') => new SignJWT({roles:['USER']}).setProtectedHeader({alg:'RS256',kid:key.kid}).setSubject('user-1').setIssuer(issuer).setAudience(aud).setExpirationTime(exp).sign(privateKey);
  assert.equal((await verify(await token())).sub, 'user-1');
  await assert.rejects(verify(await token('other-api')));
  await assert.rejects(verify(await token('room-care-api','-1s')));
  await assert.rejects(verify('invalid'));
});

test('REST forwards monitoring routes, CORS, credentials; D APIs are scoped and send requires ADMIN', async t => {
  let forwarded;
  const cloud = createServer((req,res) => {
    forwarded = {url:req.url, auth:req.headers.authorization, spoof:req.headers['x-user-id']};
    res.setHeader('content-type','application/json');
    res.statusCode = req.url.includes('range=bad') ? 400 : 200;
    res.end(JSON.stringify({range:'1h', bucketSeconds:60, points:[]}));
  });
  const cloudUrl = await listen(cloud); t.after(() => close(cloud));
  const calls=[];
  const notifications={register:async(...args)=>calls.push(args), list:async user=>[{user}], remove:async()=>{}, send:async()=>({status:'sent'})};
  const verify=async token=> {
    if(!['test-token','admin-token'].includes(token)) throw Error('bad token');
    return {sub:'user-1', roles:token==='admin-token'?['ADMIN']:['USER'], exp:Math.floor(Date.now()/1000)+60};
  };
  const {server,wss}=createApp({config:{...config,devAuth:false,cloud:cloudUrl},verify,notifications,logger,registry:new Registry()});
  const base=await listen(server); t.after(()=>{wss.close();close(server);});
  const headers={Authorization:'Bearer test-token',Origin:config.origins[0]};
  const cors=await fetch(base+'/api/sensors/latest',{method:'OPTIONS',headers:{Origin:config.origins[0],'Access-Control-Request-Method':'GET'}});
  assert.equal(cors.status,204); assert.equal(cors.headers.get('access-control-allow-origin'),config.origins[0]);
  assert.equal((await fetch(base+'/api/edge/status')).status,401);
  const response=await fetch(base+'/api/sensors/history?range=1h',{headers:{...headers,'X-User-Id':'spoof'}});
  assert.equal(response.status,200); assert.deepEqual((await response.json()).points,[]);
  assert.deepEqual(forwarded,{url:'/api/sensors/history?range=1h',auth:'Bearer test-token',spoof:undefined});
  assert.equal((await fetch(base+'/api/sensors/history?range=bad',{headers})).status,400);
  assert.equal((await fetch(base+'/api/push/token',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({token:'fcm-1',userId:'spoof'})})).status,204);
  assert.deepEqual(calls,[['user-1','fcm-1']]);
  assert.deepEqual(await (await fetch(base+'/api/notifications',{headers})).json(),[{user:'user-1'}]);
  assert.equal((await fetch(base+'/api/notifications/send',{method:'POST',headers})).status,403);
  const admin={Authorization:'Bearer admin-token','content-type':'application/json'};
  assert.equal((await fetch(base+'/api/notifications/send',{method:'POST',headers:admin,body:'{}'})).status,400);
  assert.equal((await fetch(base+'/api/notifications/send',{method:'POST',headers:admin,body:JSON.stringify({eventId:'e',userId:'u',title:'t',body:'b'})})).status,200);
  close(cloud);
  assert.equal((await fetch(base+'/api/edge/status',{headers})).status,502);
});

test('WS sends initial status, heartbeat/ping and forwards sensor/recovery frames', async t => {
  const state={online:true,offlineMode:false,lastSeenAt:new Date().toISOString()};
  const cloud=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(state));});
  const upstream=new WebSocketServer({server:cloud,path:'/ws'});
  const cloudUrl=await listen(cloud);
  const recovery={offlineSince:new Date().toISOString(),recoveredAt:new Date().toISOString(),localActions:[]};
  upstream.on('connection',ws=>{
    ws.send(JSON.stringify({type:'sensor.update',payload:{temperature:23,humidity:50,measuredAt:state.lastSeenAt}}));
    ws.send(JSON.stringify({type:'edge.recovered',payload:recovery}));
  });
  const {server,wss}=createApp({config:{...config,cloud:cloudUrl},verify:verifier(config),notifications:{},logger,registry:new Registry()});
  const base=await listen(server);
  const client=new WebSocket(base.replace('http','ws')+'/ws',{origin:config.origins[0]});
  t.after(()=>{client.terminate();for(const s of wss.clients)s.terminate();for(const s of upstream.clients)s.terminate();wss.close();upstream.close();close(server);close(cloud);});
  const frames=[];
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('missing WebSocket frames')),2000);
    client.on('message',raw=>{
      const msg=JSON.parse(raw.toString());frames.push(msg);
      if(msg.type==='edge.status')client.send(JSON.stringify({type:'ping'}));
      if(['edge.status','sensor.update','edge.recovered','heartbeat'].every(type=>frames.some(f=>f.type===type)) && frames.filter(f=>f.type==='heartbeat').length >= 2){clearTimeout(timeout);resolve();}
    });client.on('error',reject);
  });
  assert.deepEqual(frames[0],{type:'edge.status',payload:state});
  assert.deepEqual(frames.find(f=>f.type==='edge.recovered').payload,recovery);
});

test('production WS waits for first-message auth and rejects disallowed Origins', async t => {
  const cloud=createServer((_req,res)=>res.end(JSON.stringify({online:false,offlineMode:false,lastSeenAt:new Date().toISOString()})));
  const upstream=new WebSocketServer({server:cloud,path:'/ws'});
  const cloudUrl=await listen(cloud);
  const verify=async token=>{if(token!=='valid')throw Error();return{sub:'u',exp:Math.floor(Date.now()/1000)+60};};
  const {server,wss}=createApp({config:{...config,devAuth:false,cloud:cloudUrl},verify,notifications:{},logger,registry:new Registry()});
  const base=await listen(server);
  t.after(()=>{for(const s of wss.clients)s.terminate();for(const s of upstream.clients)s.terminate();wss.close();upstream.close();close(server);close(cloud);});
  const ws=new WebSocket(base.replace('http','ws')+'/ws',{origin:config.origins[0]});
  const message=once(ws,'message');
  await once(ws,'open');ws.send(JSON.stringify({type:'auth',payload:{token:'valid'}}));
  assert.equal(JSON.parse((await message)[0].toString()).type,'edge.status');ws.terminate();
  const denied=new WebSocket(base.replace('http','ws')+'/ws',{origin:'https://evil.example'});
  await once(denied,'error');
});

class FakeRedis {
  hashes=new Map(); values=new Map(); lists=new Map();
  async hExists(k,f){return this.hashes.get(k)?.has(f)??false;}
  async hLen(k){return this.hashes.get(k)?.size??0;}
  async hSet(k,f,v){if(!this.hashes.has(k))this.hashes.set(k,new Map());this.hashes.get(k).set(f,v);}
  async hDel(k,f){this.hashes.get(k)?.delete(f);}
  async hVals(k){return [...(this.hashes.get(k)?.values()??[])];}
  async set(k,v){if(this.values.has(k))return null;this.values.set(k,v);return 'OK';}
  async lRange(k){return this.lists.get(k)??[];}
  async eval(_script,{keys,arguments:args}){if(this.values.get(keys[0])===args[0])this.values.delete(keys[0]);}
  multi(){const self=this;return{lPush(k,v){self.lists.set(k,[v,...(self.lists.get(k)??[])]);return this;},lTrim(k){self.lists.set(k,self.lists.get(k).slice(0,100));return this;},async exec(){}};}
}
test('notifications encrypt tokens, isolate users, deduplicate and release failed claims', async()=>{
  const redis=new FakeRedis();const encryption=cipher(Buffer.alloc(32,2).toString('base64'));
  let calls=0,fail=false;
  const service=new Notifications(redis,encryption,async tokens=>{calls++;assert.deepEqual(tokens,['secret-fcm']);if(fail)throw Error('FCM');return{status:'sent',successCount:1};});
  await service.register('u1','secret-fcm');
  assert.ok(!(await redis.hVals(service.userKey('u1')+':tokens'))[0].includes('secret-fcm'));
  const event={eventId:'event-1',userId:'u1',title:'제어 완료',body:'습도 72%'};
  assert.equal((await service.send(event)).status,'sent');
  assert.equal((await service.send(event)).status,'duplicate');assert.equal(calls,1);
  assert.equal((await service.list('u1')).length,1);assert.deepEqual(await service.list('u2'),[]);
  fail=true;await assert.rejects(service.send({...event,eventId:'retry'}));
  fail=false;assert.equal((await service.send({...event,eventId:'retry'})).status,'sent');
});

test('client-credentials NOTIFICATION_SENDER may send; metrics use bounded labels', async t => {
  const tokens={'sender-token':['NOTIFICATION_SENDER'],'user-token':['USER']};
  const verify=async token=>{if(!tokens[token])throw Error('bad token');return{sub:'svc',roles:tokens[token],exp:Math.floor(Date.now()/1000)+60};};
  let fail=false;
  const notifications={send:async event=>{if(fail)throw Error('redis');return{eventId:event.eventId,status:'dry-run'};}};
  const registry=new Registry();
  const {server,wss}=createApp({config:{...config,devAuth:false,cloud:'http://127.0.0.1:9'},verify,notifications,logger,registry});
  const base=await listen(server); t.after(()=>{wss.close();close(server);});
  const event={eventId:'automation-1',userId:'user-1',title:'자동 제어 완료',body:'제습기를 켰습니다'};
  const post=(token,body)=>fetch(base+'/api/notifications/send',{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('user-token',event)).status,403);
  const sent=await post('sender-token',event);
  assert.equal(sent.status,200); assert.equal((await sent.json()).status,'dry-run');
  fail=true; assert.equal((await post('sender-token',{...event,eventId:'automation-2'})).status,503);
  assert.equal((await fetch(base+'/api/edge/status',{headers:{Authorization:'Bearer user-token'}})).status,502);
  await fetch(base+'/api/random-'+Math.random(),{headers:{Authorization:'Bearer user-token'}});
  assert.equal((await fetch(base+'/api/notifications/send',{method:'POST'})).status,401);
  const text=await (await fetch(base+'/actuator/prometheus')).text();
  assert.match(text,/gateway_notifications_total\{status="dry-run"\} 1/);
  assert.match(text,/gateway_notifications_total\{status="error"\} 1/);
  assert.match(text,/gateway_cloud_upstream_failures_total\{transport="rest"\} 2/);
  assert.match(text,/http_server_request_duration_seconds_count\{method="POST",route="\/api\/notifications\/send",status_code="200"\} 1/);
  assert.match(text,/route="\/api\/edge",status_code="502"/);
  assert.match(text,/route="\/api\/other"/);
  assert.match(text,/method="POST",route="\/api\/notifications\/send",status_code="401"/);
  assert.doesNotMatch(text,/random-/);
  assert.match(text,/gateway_websocket_clients 0/);
});

test('realm grants NOTIFICATION_SENDER only to the automation service account', async () => {
  const {readFile}=await import('node:fs/promises');
  const realm=JSON.parse(await readFile(new URL('../../infra/keycloak/room-care-realm.json',import.meta.url),'utf8'));
  const client=realm.clients.find(c=>c.clientId==='room-care-automation');
  assert.ok(client.serviceAccountsEnabled && !client.publicClient && !client.standardFlowEnabled && !client.directAccessGrantsEnabled);
  assert.equal(client.secret,'${AUTOMATION_CLIENT_SECRET}');
  assert.equal(client.fullScopeAllowed,false);
  assert.ok(client.protocolMappers.some(m=>m.config['included.custom.audience']==='room-care-api'));
  assert.deepEqual(realm.users.find(u=>u.serviceAccountClientId==='room-care-automation').realmRoles,['NOTIFICATION_SENDER']);
  assert.ok(!realm.clients.find(c=>c.clientId==='room-care-web').serviceAccountsEnabled);
});

test('readiness reports Redis/C server status, times out hung checks and exports dependency gauge', async t => {
  let cloudStatus=200;
  const cloud=createServer((req,res)=>{res.statusCode=req.url==='/health'?cloudStatus:404;res.end();});
  const cloudUrl=await listen(cloud); t.after(()=>close(cloud));
  const {cloudCheck}=await import('../src/app.js');
  let redisUp=true;
  const checks={redis:async()=>{if(!redisUp)return new Promise(()=>{});}, cloud:cloudCheck({cloud:cloudUrl,cloudHealthPath:'/health',timeout:200})};
  const {server,wss}=createApp({config:{...config,devAuth:false,cloud:cloudUrl},verify:async()=>{throw Error();},notifications:{},logger,registry:new Registry(),checks});
  const base=await listen(server); t.after(()=>{wss.close();close(server);});
  const ready=await fetch(base+'/actuator/health/readiness');
  assert.equal(ready.status,200);
  assert.deepEqual(await ready.json(),{status:'UP',components:{redis:{status:'UP'},cloud:{status:'UP'}}});
  redisUp=false; cloudStatus=503;
  const down=await fetch(base+'/actuator/health/readiness');
  assert.equal(down.status,503);
  assert.deepEqual(await down.json(),{status:'DOWN',components:{redis:{status:'DOWN'},cloud:{status:'DOWN'}}});
  assert.equal((await fetch(base+'/actuator/health/liveness')).status,200);
  redisUp=true; close(cloud);
  const text=await (await fetch(base+'/actuator/prometheus')).text();
  assert.match(text,/gateway_dependency_up\{dependency="redis"\} 1/);
  assert.match(text,/gateway_dependency_up\{dependency="cloud"\} 0/);
  assert.match(text,/route="\/actuator\/health\/liveness",status_code="200"/);
  assert.match(text,/route="\/actuator\/health\/readiness",status_code="503"/);
  assert.doesNotMatch(text,/route="[^"]*,/);
});
