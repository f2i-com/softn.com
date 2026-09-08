// Optional persistent transport for authenticated HTTP polling routes.
// Not launched by PHP/setup, and never evaluates application code itself.
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {WebSocketServer} from './vendor/ws/wrapper.mjs';

export function createLiveServer({upstream,origins,routes,intervalMs=5000,maxClients=8,fetchImpl=fetch}) {
  const target=new URL(upstream);
  if(target.username||target.password||target.search||target.hash||target.pathname!=='/'||!(target.protocol==='https:'||target.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(target.hostname)))throw Error('Use an HTTPS origin or loopback HTTP upstream');
  const allowed=new Set(origins),paths=new Set(routes.filter(r=>r.poll===true&&r.method==='GET'&&r.transaction==='read'&&/^\/api\/[a-zA-Z0-9/_-]+$/.test(r.path)).map(r=>r.path));
  const server=http.createServer((req,res)=>{res.writeHead(404);res.end();});
  const sockets=new WebSocketServer({noServer:true,maxPayload:8192,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/events'||!allowed.has(req.headers.origin)||sockets.clients.size>=maxClients){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    sockets.handleUpgrade(req,socket,head,ws=>sockets.emit('connection',ws,req));
  });
  sockets.on('connection',(ws,req)=>{
    let subscription=null,timer=null,controller=null,closed=false;
    const admission=setTimeout(()=>ws.close(1008,'Subscribe required'),10000);
    function send(value){if(ws.readyState!==1)return;if(ws.bufferedAmount>65536){ws.close(1013,'Client too slow');return;}ws.send(JSON.stringify(value));}
    async function poll(){
      if(closed||!subscription)return;
      controller=new AbortController();const deadline=setTimeout(()=>controller.abort(),10000);
      let keep=true;
      try {
        const headers={Origin:req.headers.origin,Authorization:subscription.authorization};
        if(subscription.etag)headers['If-None-Match']=subscription.etag;
        const r=await fetchImpl(new URL(subscription.path,target),{headers,redirect:'error',signal:controller.signal});
        if(r.status===304){await r.body?.cancel();send({type:'unchanged'});}
        else {
          const reader=r.body.getReader();let size=0;const chunks=[];
          try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>3*1024*1024)throw Error('Response limit');chunks.push(Buffer.from(part.value));}}finally{await reader.cancel();}
          const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if(r.status===200){subscription.etag=r.headers.get('etag');send({type:'update',body});}
          else {send({type:'error',status:r.status});if([401,403,404].includes(r.status)){keep=false;ws.close(1008,'Subscription unavailable');}}
        }
      }catch{send({type:'error',status:503});}
      finally{clearTimeout(deadline);controller=null;if(keep&&!closed)timer=setTimeout(poll,intervalMs);}
    }
    ws.on('message',(data,binary)=>{
      if(subscription||binary){ws.close(1008,'One subscription per connection');return;}
      try {
        const m=JSON.parse(data.toString());
        if(m.type!=='subscribe'||typeof m.path!=='string'||!paths.has(m.path)||typeof m.authorization!=='string'||!/^Bearer [\x21-\x7e]{1,2048}$/.test(m.authorization))throw Error('Invalid subscription');
        subscription={path:m.path,authorization:m.authorization,etag:null};clearTimeout(admission);poll();
      }catch{ws.close(1008,'Invalid subscription');}
    });
    ws.on('error',()=>{});
    ws.on('close',()=>{closed=true;clearTimeout(admission);clearTimeout(timer);controller?.abort();subscription=null;});
  });
  return {server,close:()=>{for(const ws of sockets.clients)ws.terminate();sockets.close();server.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
  const manifest=JSON.parse(readFileSync(new URL('./app/manifest.json',import.meta.url),'utf8'));
  const live=createLiveServer({upstream:option('--upstream','http://127.0.0.1'),origins:manifest.config?.server?.allowedOrigins||[],routes:manifest.server?.routes||[]});
  const port=Number(option('--port','8788'));if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
  live.server.listen(port,'127.0.0.1',()=>console.log('Optional live bridge listening on loopback port '+port));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>live.close());
}
