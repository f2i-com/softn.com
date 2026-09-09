// The checksum-pinned inputs every PHP backend archive is built from: the
// official Linux x64 Node, the ws package for the optional WebSocket bridge,
// the vendored ZIPP WASM with its upstream licence, and the notices that go
// beside them. Shared by package-single-backend.mjs (the static runtime with
// a backend) and package-private-single-php.mjs (the PHP-served runtime with
// a backend), so the two archives cannot disagree about a version or a hash.
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {unzipSync} from 'fflate';
export const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cache=join(root,'.cache/single-backend');
const sha=b=>createHash('sha256').update(b).digest('hex');
export const nodeVersion='24.20.0';
const nodeName='node-v'+nodeVersion+'-linux-x64';
const nodeHash='2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2';
const wsVersion='8.21.3',wsHash='df3454ef205791ce50b5b9241762dcf9bfe1aa9f7f01d3057229be7dac0c2dc3';
async function download(url,file,digest) {
  if(existsSync(file)&&sha(readFileSync(file))===digest)return readFileSync(file);
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error('Dependency download failed: '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(sha(bytes)!==digest)throw Error('Dependency checksum mismatch');
  writeFileSync(file,bytes);return bytes;
}
/** @returns {Promise<{nodeDir:string,wasmDir:string,notices:string,websocketDir:string,version:string}>} */
export async function prepareBackendInputs() {
  mkdirSync(cache,{recursive:true});
  const tar=join(cache,nodeName+'.tar.xz');
  await download('https://nodejs.org/dist/v'+nodeVersion+'/'+nodeName+'.tar.xz',tar,nodeHash);
  // Only two named files from a checksum-pinned official archive are extracted.
  // Relative names from the cache directory: GNU tar reads a `C:` in an
  // absolute Windows path as a remote host, and bsdtar accepts either form.
  execFileSync('tar',['-xf',nodeName+'.tar.xz',nodeName+'/bin/node',nodeName+'/LICENSE'],{cwd:cache});
  const wsDir=join(cache,'ws');mkdirSync(wsDir,{recursive:true});
  const wsArchive='ws-'+wsVersion+'.tgz';
  await download('https://registry.npmjs.org/ws/-/ws-'+wsVersion+'.tgz',join(cache,wsArchive),wsHash);
  execFileSync('tar',['-xf','../'+wsArchive],{cwd:wsDir});
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
  writeFileSync(join(notices,'WS-SOURCE.json'),JSON.stringify({version:wsVersion,url:'https://registry.npmjs.org/ws/-/ws-'+wsVersion+'.tgz',sha256:wsHash,license:'MIT'},null,2));
  const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
  return {nodeDir:join(cache,nodeName),wasmDir,notices,websocketDir:join(wsDir,'package'),version};
}
