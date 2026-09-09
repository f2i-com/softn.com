import {openBundleArchive} from '../bundle/zip';
/** Small text-only archives. Check declared sizes BEFORE any inflation. */
export function readZipText(bytes: Uint8Array): Record<string,string> {
  if(bytes.length>262144)throw Error('ZIP exceeds 256 KiB');
  const archive=openBundleArchive(bytes),names=archive.names();
  if(names.length>32)throw Error('ZIP exceeds 32 files');
  let total=0;
  for(const name of names){
    if(!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,119}$/.test(name)||name.split('/').some(p=>p==='..'||p==='.'||!p))throw Error('Invalid ZIP filename');
    const size=archive.declaredSize(name)!;
    total+=size;if(size>65536||total>262144)throw Error('Expanded ZIP exceeds text limits');
  }
  const out:Record<string,string>=Object.create(null),decoder=new TextDecoder('utf-8',{fatal:true});
  for(const name of names)out[name]=decoder.decode(archive.read(name));
  return out;
}
