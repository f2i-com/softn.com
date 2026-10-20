// The checksum-pinned inputs every PHP backend archive is built from: the
// official Linux x64 Node, the ws package for the optional WebSocket bridge,
// the installed ZIPP WASM with its upstream licence, and the notices that go
// beside them. Shared by package-single-backend.mjs (the static runtime with
// a backend) and package-private-single-php.mjs (the PHP-served runtime with
// a backend), so the two archives cannot disagree about a version or a hash.
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync,rmSync} from 'node:fs';
import { join } from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {unzipSync} from 'fflate';
import {startHere} from './release-explainers.mjs';
import { repoRoot as root } from './lib/paths.mjs';

export { root };
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
/** Package local-build provenance without assuming an upstream release ZIP exists. `notices` is this function's own directory. */
export async function prepareZippNotices(wasmDir, notices) {
  const source=JSON.parse(readFileSync(join(wasmDir,'SOURCE.json'),'utf8'));
  if(source.artifact!=='zipp_wasm_bg.wasm'||!source.sha256||sha(readFileSync(join(wasmDir,source.artifact)))!==source.sha256)throw Error('ZIPP WASM provenance mismatch');
  // A release install records its notices, file and digest; a local build may just carry THIRD_PARTY_LICENSES.txt.
  const noticesFile=join(wasmDir,source.notices?.file??'THIRD_PARTY_LICENSES.txt');
  if(source.notices&&!(existsSync(noticesFile)&&sha(readFileSync(noticesFile))===source.notices.sha256))throw Error('ZIPP notices provenance mismatch: '+source.notices.file+' is not the recorded '+source.notices.sha256);
  let license;
  if(existsSync(join(wasmDir,'LICENSE-APACHE'))) {
    license=readFileSync(join(wasmDir,'LICENSE-APACHE'));
  } else {
    // A release's licence is in its embed kit (fetch-zipp-release.mjs records it under `kit`).
    if(!source.release||!source.kit?.bundle||!source.kit?.bundleSha256)throw Error('Local ZIPP build is missing LICENSE-APACHE; rebuild the local engine.');
    const upstream=await download(source.repository+'/releases/download/'+source.release+'/'+source.kit.bundle,join(cache,source.kit.bundle),source.kit.bundleSha256);
    const files=unzipSync(upstream),name=Object.keys(files).find(n=>n.endsWith('/LICENSE-APACHE'));
    if(!name)throw Error('Upstream WASM license missing');
    license=files[name];
  }
  // Everything in `notices` is packaged, and the directory outlives a run: it
  // is emptied here so that what ships is this engine's and nothing an earlier
  // one left (its third-party notices, when this engine carries none).
  rmSync(notices,{recursive:true,force:true});
  mkdirSync(notices,{recursive:true});
  writeFileSync(join(notices,'ZIPP-LICENSE-APACHE'),license);
  copyFileSync(join(wasmDir,'SOURCE.json'),join(notices,'ZIPP-SOURCE.json'));
  if(existsSync(noticesFile))copyFileSync(noticesFile,join(notices,'ZIPP-THIRD-PARTY-LICENSES.txt'));
}
/**
 * Refuse a single-app dist/ that is not the standalone build. The site build
 * (build-site.mjs) builds the same app with VITE_BASE=/play/ into the same
 * folder; that page loads its scripts from /play/assets/ and so runs nowhere
 * but under softn.com, while the archive is for any directory of any host.
 * The standalone build's URLs are relative.
 */
export function requireStandaloneBuild(dist) {
  const page=join(dist,'index.html');
  if(!existsSync(page))throw Error('Build the single-app runtime first.');
  const fixed=readFileSync(page,'utf8').match(/\s(?:src|href)="(\/[^"]*)"/);
  if(fixed)throw Error('apps/softn-single/dist was built for '+fixed[1]+', a fixed path (the site build leaves it so, for /play/). The standalone runtime loads its files by relative URL: run `npm run build -w @softn/single` and package again.');
}
/** The README.md for a backend archive, written where packagePhp can read it. */
export function explainerFile(id,version) {
  mkdirSync(cache,{recursive:true});
  const file=join(cache,'README-'+id+'.md');
  writeFileSync(file,startHere(id,{tag:'v'+version}));
  return file;
}
/**
 * Unpack `archive`, a file in `dir`, into `dir/into`, emptied first: the
 * whole directory is packaged, and one kept from an earlier version of the
 * archive would add the files that version had and this one does not. The
 * name is relative, from inside the target: GNU tar reads a `C:` in an
 * absolute Windows path as a remote host, and bsdtar accepts either form.
 */
export function unpackPinned(dir,archive,into) {
  const target=join(dir,into);
  rmSync(target,{recursive:true,force:true});
  mkdirSync(target,{recursive:true});
  execFileSync('tar',['-xf','../'+archive],{cwd:target});
  return target;
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
  const wsArchive='ws-'+wsVersion+'.tgz';
  await download('https://registry.npmjs.org/ws/-/ws-'+wsVersion+'.tgz',join(cache,wsArchive),wsHash);
  const wsDir=unpackPinned(cache,wsArchive,'ws');
  const wasmDir=join(root,'packages/@softn/core/wasm-zipp');
  const notices=join(cache,'notices');
  await prepareZippNotices(wasmDir,notices);
  writeFileSync(join(notices,'NODE-SOURCE.json'),JSON.stringify({version:nodeVersion,url:'https://nodejs.org/dist/v'+nodeVersion+'/'+nodeName+'.tar.xz',sha256:nodeHash},null,2));
  writeFileSync(join(notices,'WS-SOURCE.json'),JSON.stringify({version:wsVersion,url:'https://registry.npmjs.org/ws/-/ws-'+wsVersion+'.tgz',sha256:wsHash,license:'MIT'},null,2));
  const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
  return {nodeDir:join(cache,nodeName),wasmDir,notices,websocketDir:join(wsDir,'package'),version};
}
