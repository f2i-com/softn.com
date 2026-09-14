import {createServer} from 'node:http';
import {readFile,stat,realpath} from 'node:fs/promises';
import {resolve,join,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.xml':'application/xml; charset=utf-8'};
/** Local-only preview. Missing routes return real 404s rather than an SPA fallback. */
export function createPreviewServer(root) {
  root=resolve(root);
  return createServer(async(req,res)=>{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'});res.end();return;}
    try {
      const url=new URL(req.url,'http://localhost');
      const pathname=decodeURIComponent(url.pathname);
      if(pathname.includes('\0')||pathname.includes('\\'))throw Object.assign(new Error('Invalid path'),{code:'ENOENT'});
      let target=resolve(root,'.'+pathname);
      if(target!==root&&!target.startsWith(root+sep))throw Object.assign(new Error('Invalid path'),{code:'ENOENT'});
      const actual=await realpath(target),actualRoot=await realpath(root);
      if(actual!==actualRoot&&!actual.startsWith(actualRoot+sep))throw Object.assign(new Error('Invalid path'),{code:'ENOENT'});
      if((await stat(target)).isDirectory()) {
        if(!pathname.endsWith('/')){res.writeHead(308,{Location:url.pathname+'/'+url.search});res.end();return;}
        target=join(target,'index.html');
      }
      const finalTarget=await realpath(target);
      if(finalTarget!==actualRoot&&!finalTarget.startsWith(actualRoot+sep))throw Object.assign(new Error('Invalid path'),{code:'ENOENT'});
      const data=await readFile(finalTarget);
      res.writeHead(200,{'Content-Type':MIME[extname(target)]??'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(req.method==='HEAD'?undefined:data);
    }catch(error){const missing=['ENOENT','ENOTDIR','EISDIR'].includes(error.code)||error instanceof URIError;res.writeHead(missing?404:500,{'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff'});res.end(missing?'Not found':'Preview server error');}
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=resolve(process.argv[2]??fileURLToPath(new URL('../dist/',import.meta.url)));
  const port=Number(process.argv[3]??4173);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Port must be an integer from 1 to 65535');
  const server=createPreviewServer(root);
  server.on('error',error=>{console.error(error.message);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`Preview: http://127.0.0.1:${port}/docs/\nServing ${root}`));
}
