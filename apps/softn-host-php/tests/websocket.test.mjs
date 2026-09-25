import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const root=process.env.SOFTN_PHP_TEST_BACKEND;
const skip=root?false:'Set SOFTN_PHP_TEST_BACKEND to an extracted backend';
// Without the backend fixture these tests are SKIPPED, visibly, not thrown
// out of: the suite runs in every checkout and CI, and the fixture-bound
// cases report why they did not run.
if(skip)console.warn(`WARNING: tests/websocket.test.mjs skipped: ${skip}. See apps/softn-host-php/README.md, Validation.`);
const test=(name,...rest)=>{const fn=rest.pop();return nodeTest(name,{...(rest[0]??{}),skip},fn);};
const {createLiveServer}=skip?{}:await import(pathToFileURL(join(root,'websocket.mjs')));
const {default:WebSocket}=skip?{}:await import(pathToFileURL(join(root,'vendor/ws/wrapper.mjs')));
test('optional WebSocket bridge checks auth on every poll, delivers changes and closes revoked sessions',{timeout:10000},async t=>{
  let revoked=false,checks=0;
  const upstream=http.createServer((req,res)=>{
    checks++;
    if(req.headers.authorization!=='Bearer fixture'||revoked){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"private rejection"}');return;}
    assert.equal(req.headers.origin,'https://app.example');
    if(req.headers['if-none-match']==='"one"'){res.writeHead(304);res.end();return;}
    res.writeHead(200,{'Content-Type':'application/json',ETag:'"one"'});res.end('{"value":1}');
  });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>upstream.close());
  const live=createLiveServer({upstream:'http://127.0.0.1:'+upstream.address().port,origins:['https://app.example'],routes:[{path:'/api/counter',method:'GET',transaction:'read',poll:true}],intervalMs:20});
  live.server.listen(0,'127.0.0.1');await once(live.server,'listening');t.after(()=>live.close());
  const url='ws://127.0.0.1:'+live.server.address().port+'/events';
  const socket=new WebSocket(url,{origin:'https://app.example'});await once(socket,'open');
  const messages=[];
  socket.on('message',bytes=>{const m=JSON.parse(bytes);messages.push(m);if(m.type==='unchanged')revoked=true;});
  socket.send(JSON.stringify({type:'subscribe',path:'/api/counter',authorization:'Bearer fixture'}));await once(socket,'close');
  assert.deepEqual(messages[0],{type:'update',body:{value:1}});assert.ok(messages.some(m=>m.type==='unchanged'));assert.deepEqual(messages.at(-1),{type:'error',status:401});assert.ok(checks>=3);
  const invalid=new WebSocket(url,{origin:'https://app.example'});await once(invalid,'open');invalid.send(JSON.stringify({type:'subscribe',path:'/api/private',authorization:'Bearer fixture'}));const [code]=await once(invalid,'close');assert.equal(code,1008);
  await new Promise((resolve,reject)=>{const foreign=new WebSocket(url,{origin:'https://evil.example'});foreign.on('unexpected-response',(req,res)=>{assert.equal(res.statusCode,403);req.destroy();resolve();});foreign.on('error',()=>{});setTimeout(()=>reject(Error('Origin check timeout')),1000).unref();});
});
test('WebSocket upstream refuses remote plaintext and embedded credentials',()=>{
  for(const upstream of ['http://example.com','https://user:secret@example.com','https://example.com/path'])assert.throws(()=>createLiveServer({upstream,origins:[],routes:[]}));
});

test('the bridge accepts its own HTTPS site without a listing, and still refuses others',{timeout:5000},async t=>{
  const live=createLiveServer({upstream:'https://app.example',origins:[],routes:[]});
  live.server.listen(0,'127.0.0.1');await once(live.server,'listening');t.after(()=>live.close());
  const url='ws://127.0.0.1:'+live.server.address().port+'/events';
  const own=new WebSocket(url,{origin:'https://app.example'});await once(own,'open');own.close();
  await new Promise((resolve,reject)=>{const other=new WebSocket(url,{origin:'https://evil.example'});other.on('unexpected-response',(req,res)=>{assert.equal(res.statusCode,403);req.destroy();resolve();});other.on('error',()=>{});setTimeout(()=>reject(Error('Origin check timeout')),1000).unref();});
});
test('one visitor cannot hold every connection, and a closed one frees its slot',{timeout:10000},async t=>{
  const live=createLiveServer({upstream:'http://127.0.0.1:9',origins:['https://app.example'],routes:[],maxClients:8,maxPerClient:2});
  live.server.listen(0,'127.0.0.1');await once(live.server,'listening');t.after(()=>live.close());
  const url='ws://127.0.0.1:'+live.server.address().port+'/events';
  // The bridge sits behind the site's proxy on loopback; X-Forwarded-For names the visitor.
  const open=xff=>new Promise(resolve=>{const ws=new WebSocket(url,{origin:'https://app.example',headers:{'X-Forwarded-For':xff}});ws.on('open',()=>resolve({ok:true,ws}));ws.on('unexpected-response',(req,res)=>{req.destroy();resolve({ok:false,status:res.statusCode});});ws.on('error',()=>{});});
  const a1=await open('203.0.113.9'),a2=await open('203.0.113.9'),a3=await open('203.0.113.9'),b1=await open('198.51.100.4');
  assert.equal(a1.ok,true);assert.equal(a2.ok,true);assert.deepEqual(a3,{ok:false,status:403});assert.equal(b1.ok,true);
  a1.ws.close();await once(a1.ws,'close');await new Promise(resolve=>setTimeout(resolve,100));
  const a4=await open('203.0.113.9');assert.equal(a4.ok,true);
  for(const c of [a2,b1,a4])c.ws.terminate();
});
