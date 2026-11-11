import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {WebSocket, WebSocketServer} from 'ws';
import {Registry} from 'prom-client';
import {cipher} from '../src/security.js';
import {Notifications} from '../src/notifications.js';
import {createApp} from '../src/app.js';

const logger = {info(){}, error(){}};
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
function close(server) { server.closeAllConnections?.(); server.close(); }
const INTERNAL_KEY = 'k'.repeat(40);
const config = {origins: ['http://localhost:5173'], roomUser: 'room-user', internalKey: INTERNAL_KEY, heartbeat: 30, timeout: 200};

test('AES-GCM round trip, randomized IV and tampering rejection', () => {
  const encryption = cipher(Buffer.alloc(32, 1).toString('base64'));
  const one = encryption.encrypt('private-token');
  assert.equal(encryption.decrypt(one), 'private-token');
  assert.notEqual(one, encryption.encrypt('private-token'));
  const data = Buffer.from(one, 'base64'); data[28] ^= 1;
  assert.throws(() => encryption.decrypt(data.toString('base64')));
  assert.throws(() => cipher('invalid'));
});

test('REST works without login as the room user, forwards to C without identity headers', async t => {
  let forwarded;
  const cloud = createServer((req,res) => {
    forwarded = {url:req.url, auth:req.headers.authorization, spoof:req.headers['x-user-id'], key:req.headers['idempotency-key']};
    res.setHeader('content-type','application/json');
    res.statusCode = req.url.includes('range=bad') ? 400 : 200;
    res.end(JSON.stringify({range:'1h', bucketSeconds:60, points:[]}));
  });
  const cloudUrl = await listen(cloud); t.after(() => close(cloud));
  const calls=[];
  const notifications={register:async(...args)=>calls.push(args), list:async user=>[{user}], remove:async()=>{}};
  const {server,wss}=createApp({config:{...config,cloud:cloudUrl},notifications,logger,registry:new Registry()});
  const base=await listen(server); t.after(()=>{wss.close();close(server);});
  const headers={Origin:config.origins[0]};
  const cors=await fetch(base+'/api/sensors/latest',{method:'OPTIONS',headers:{Origin:config.origins[0],'Access-Control-Request-Method':'GET'}});
  assert.equal(cors.status,204); assert.equal(cors.headers.get('access-control-allow-origin'),config.origins[0]);
  const preflight=await fetch(base+'/api/devices/window-1/commands',{method:'OPTIONS',headers:{Origin:config.origins[0],'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,idempotency-key'}});
  assert.equal(preflight.status,204); assert.match(preflight.headers.get('access-control-allow-headers'),/Idempotency-Key/);
  const response=await fetch(base+'/api/sensors/history?range=1h',{headers:{...headers,'X-User-Id':'spoof',Authorization:'Bearer spoof'}});
  assert.equal(response.status,200); assert.deepEqual((await response.json()).points,[]);
  assert.deepEqual(forwarded,{url:'/api/sensors/history?range=1h',auth:undefined,spoof:undefined,key:undefined});
  const command=await fetch(base+'/api/devices/window-1/commands',{method:'POST',headers:{...headers,'content-type':'application/json','Idempotency-Key':'3f2b9c1e-key'},body:JSON.stringify({action:'CLOSE'})});
  assert.equal(command.status,200); assert.equal(forwarded.key,'3f2b9c1e-key'); assert.equal(forwarded.url,'/api/devices/window-1/commands');
  forwarded=undefined;
  const badKey=await fetch(base+'/api/devices/window-1/commands',{method:'POST',headers:{...headers,'content-type':'application/json','Idempotency-Key':'x'.repeat(201)},body:'{}'});
  assert.equal(badKey.status,400); assert.equal(forwarded,undefined);
  assert.equal((await fetch(base+'/api/sensors/history?range=bad',{headers})).status,400);
  assert.equal((await fetch(base+'/api/push/token',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({token:'fcm-1',userId:'spoof'})})).status,204);
  assert.deepEqual(calls,[['room-user','fcm-1']]);
  assert.deepEqual(await (await fetch(base+'/api/notifications',{headers})).json(),[{user:'room-user'}]);
  // The removed public send API now falls through to C instead of sending a notification.
  forwarded=undefined; await fetch(base+'/api/notifications/send',{method:'POST',headers});
  assert.equal(forwarded.url,'/api/notifications/send');
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
  const {server,wss}=createApp({config:{...config,cloud:cloudUrl},notifications:{},logger,registry:new Registry()});
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

test('WS needs no auth message, sends no token upstream and rejects disallowed Origins', async t => {
  const cloud=createServer((_req,res)=>res.end(JSON.stringify({online:false,offlineMode:false,lastSeenAt:new Date().toISOString()})));
  const upstream=new WebSocketServer({server:cloud,path:'/ws'});
  let upstreamAuth='unset'; upstream.on('connection',(_ws,req)=>{upstreamAuth=req.headers.authorization;});
  const cloudUrl=await listen(cloud);
  const {server,wss}=createApp({config:{...config,cloud:cloudUrl},notifications:{},logger,registry:new Registry()});
  const base=await listen(server);
  t.after(()=>{for(const s of wss.clients)s.terminate();for(const s of upstream.clients)s.terminate();wss.close();upstream.close();close(server);close(cloud);});
  const ws=new WebSocket(base.replace('http','ws')+'/ws',{origin:config.origins[0]});
  const message=once(ws,'message');
  assert.equal(JSON.parse((await message)[0].toString()).type,'edge.status');
  for(let i=0;i<20&&upstreamAuth==='unset';i++) await new Promise(r=>setTimeout(r,10));
  assert.equal(upstreamAuth,undefined); ws.terminate();
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

test('internal notifications need X-Internal-Key, target the room user, broadcast notification.new; metrics use bounded labels', async t => {
  let fail=false; const sent=[];
  const notifications={send:async event=>{if(fail)throw Error('redis');sent.push(event);
    return event.eventId==='dup'?{eventId:'dup',status:'duplicate'}:{eventId:event.eventId,id:event.eventId,title:event.title,body:event.body,data:event.data??{},createdAt:'2026-11-11T00:00:00.000Z',status:'dry-run',targetCount:0,successCount:0};}};
  const registry=new Registry();
  const cloud=createServer((_req,res)=>res.end(JSON.stringify({online:true,offlineMode:false,lastSeenAt:new Date().toISOString()})));
  const upstream=new WebSocketServer({server:cloud,path:'/ws'});
  const cloudUrl=await listen(cloud);
  const {server,wss}=createApp({config:{...config,cloud:cloudUrl},notifications,logger,registry});
  const base=await listen(server);
  t.after(()=>{for(const s of wss.clients)s.terminate();for(const s of upstream.clients)s.terminate();wss.close();upstream.close();close(server);close(cloud);});
  const ws=new WebSocket(base.replace('http','ws')+'/ws',{origin:config.origins[0]});
  await once(ws,'message');
  const event={eventId:'automation-1',title:'자동 제어 완료',body:'제습기를 켰습니다',data:{deviceId:'dehumidifier-1'}};
  const post=(key,body)=>fetch(base+'/internal/notifications',{method:'POST',headers:{...(key?{'X-Internal-Key':key}:{}),'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post(undefined,event)).status,401);
  assert.equal((await post('wrong-key',event)).status,401);
  assert.equal((await post(INTERNAL_KEY,{title:'t'})).status,400);
  const pushed=new Promise(resolve=>ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='notification.new')resolve(m);}));
  const ok=await post(INTERNAL_KEY,{...event,userId:'spoofed'});
  assert.equal(ok.status,200); assert.equal((await ok.json()).status,'dry-run');
  assert.equal(sent[0].userId,'room-user');
  assert.deepEqual((await pushed).payload,{id:'automation-1',title:event.title,body:event.body,data:event.data,createdAt:'2026-11-11T00:00:00.000Z',status:'dry-run',targetCount:0,successCount:0});
  assert.equal((await (await post(INTERNAL_KEY,{...event,eventId:'dup'})).json()).status,'duplicate');
  fail=true; assert.equal((await post(INTERNAL_KEY,{...event,eventId:'automation-2'})).status,503);
  const {server:disabled,wss:disabledWss}=createApp({config:{...config,internalKey:''},notifications,logger,registry:new Registry()});
  const disabledBase=await listen(disabled); t.after(()=>{disabledWss.close();close(disabled);});
  assert.equal((await fetch(disabledBase+'/internal/notifications',{method:'POST',headers:{'X-Internal-Key':'x'}})).status,503);
  close(cloud);
  assert.equal((await fetch(base+'/api/edge/status')).status,502);
  await fetch(base+'/api/random-'+Math.random());
  await fetch(base+'/internal/random-'+Math.random(),{method:'POST'});
  const text=await (await fetch(base+'/actuator/prometheus')).text();
  assert.match(text,/gateway_notifications_total\{status="dry-run"\} 1/);
  assert.match(text,/gateway_notifications_total\{status="duplicate"\} 1/);
  assert.match(text,/gateway_notifications_total\{status="error"\} 1/);
  assert.match(text,/http_server_request_duration_seconds_count\{method="POST",route="\/internal\/notifications",status_code="200"\} 2/);
  assert.match(text,/method="POST",route="\/internal\/notifications",status_code="401"/);
  assert.match(text,/route="\/api\/edge",status_code="502"/);
  assert.match(text,/route="\/api\/other"/);
  assert.match(text,/route="\/internal\/other"/);
  assert.doesNotMatch(text,/random-/);
});

test('Compose publishes only nginx (80) and Mosquitto TLS (8883); nginx never proxies /internal', async () => {
  const {readFile}=await import('node:fs/promises');
  const compose=await readFile(new URL('../../compose.yaml',import.meta.url),'utf8');
  const published=[...compose.matchAll(/^\s+- "(\d+):(\d+)"$/gm)].map(m=>`${m[1]}:${m[2]}`);
  assert.deepEqual(published.sort(),['80:80','8883:8883']);
  assert.doesNotMatch(compose,/keycloak/i);
  const nginx=await readFile(new URL('../../infra/nginx/nginx.conf',import.meta.url),'utf8');
  assert.match(nginx,/location \^~ \/internal \{\s*return 404;/);
  assert.match(nginx,/location \^~ \/actuator \{\s*return 404;/);
});

test('readiness reports Redis/C server status, times out hung checks and exports dependency gauge', async t => {
  let cloudStatus=200;
  const cloud=createServer((req,res)=>{res.statusCode=req.url==='/health'?cloudStatus:404;res.end();});
  const cloudUrl=await listen(cloud); t.after(()=>close(cloud));
  const {cloudCheck}=await import('../src/app.js');
  let redisUp=true;
  const checks={redis:async()=>{if(!redisUp)return new Promise(()=>{});}, cloud:cloudCheck({cloud:cloudUrl,cloudHealthPath:'/health',timeout:200})};
  const {server,wss}=createApp({config:{...config,cloud:cloudUrl},notifications:{},logger,registry:new Registry(),checks});
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
