import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const root=process.env.SOFTN_PHP_TEST_BACKEND;
if(!root)throw Error('Set SOFTN_PHP_TEST_BACKEND to an extracted backend');
const {createLiveServer}=await import(pathToFileURL(join(root,'websocket.mjs')));
const {default:WebSocket}=await import(pathToFileURL(join(root,'vendor/ws/wrapper.mjs')));
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
