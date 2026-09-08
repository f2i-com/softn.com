import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {unzipSync} from 'fflate';
import {packagePhp} from '../apps/softn-php/package.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cache=join(root,'.cache/single-backend');mkdirSync(cache,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
const nodeVersion='24.12.0',nodeName='node-v'+nodeVersion+'-linux-x64';
const nodeHash='bdebee276e58d0ef5448f3d5ac12c67daa963dd5e0a9bb621a53d1cefbc852fd';
async function download(url,file,digest) {
  if(existsSync(file)&&sha(readFileSync(file))===digest)return readFileSync(file);
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error('Dependency download failed: '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(sha(bytes)!==digest)throw Error('Dependency checksum mismatch');
  writeFileSync(file,bytes);return bytes;
}
const tar=join(cache,nodeName+'.tar.xz');
await download('https://nodejs.org/dist/v'+nodeVersion+'/'+nodeName+'.tar.xz',tar,nodeHash);
// Only two named files from a checksum-pinned official archive are extracted.
execFileSync('tar',['-xf',tar,'-C',cache,nodeName+'/bin/node',nodeName+'/LICENSE']);
const wsDir=join(cache,'ws');mkdirSync(wsDir,{recursive:true});
const wsArchive=join(cache,'ws-8.21.3.tgz');
await download('https://registry.npmjs.org/ws/-/ws-8.21.3.tgz',wsArchive,'df3454ef205791ce50b5b9241762dcf9bfe1aa9f7f01d3057229be7dac0c2dc3');
execFileSync('tar',['-xf',wsArchive,'-C',wsDir]);
const wasmDir=join(root,'packages/@softn/core/wasm-zipp');
const source=JSON.parse(readFileSync(join(wasmDir,'SOURCE.json'),'utf8'));
if(sha(readFileSync(join(wasmDir,source.artifact)))!==source.sha256)throw Error('Vendored WASM provenance mismatch');
const upstream=await download(source.repository+'/releases/download/'+source.release+'/'+source.bundle,join(cache,source.bundle),source.bundleSha256);
const files=unzipSync(upstream),license=Object.keys(files).find(n=>n.endsWith('/LICENSE-APACHE'));
if(!license)throw Error('Upstream WASM license missing');
const notices=join(cache,'notices');mkdirSync(notices,{recursive:true});
writeFileSync(join(notices,'ZIPP-LICENSE-APACHE'),files[license]);
copyFileSync(join(wasmDir,'SOURCE.json'),join(notices,'ZIPP-SOURCE.json'));
writeFileSync(join(notices,'NODE-SOURCE.json'),JSON.stringify({version:nodeVersion,url:'https://nodejs.org/dist/v'+nodeVersion+'/'+nodeName+'.tar.xz',sha256:nodeHash},null,2));
writeFileSync(join(notices,'WS-SOURCE.json'),JSON.stringify({version:'8.21.3',url:'https://registry.npmjs.org/ws/-/ws-8.21.3.tgz',sha256:'df3454ef205791ce50b5b9241762dcf9bfe1aa9f7f01d3057229be7dac0c2dc3',license:'MIT'},null,2));
const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
packagePhp({runtime:join(root,'apps/softn-single/dist'),nodeDir:join(cache,nodeName),wasmDir,notices,template:true,templateClient:true,websocketDir:join(wsDir,'package'),
  out:join(root,'release','softn-single-php-linux-x64-v'+version+'.zip')});
