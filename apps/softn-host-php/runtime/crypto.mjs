import {createHash,createHmac,randomBytes,randomInt,timingSafeEqual,createCipheriv,createDecipheriv} from 'node:crypto';
const digest=text=>createHash('sha256').update(String(text)).digest('hex');
export function createCrypto(key,cryptoDomains) {
  if(!Buffer.isBuffer(key)||key.length!==32) throw new Error('A 32-byte key is required');
  const domains=cryptoDomains;
  const hmacKey=createHmac('sha256',key).update(domains.hmac).digest();
  const encKey=createHmac('sha256',key).update(domains.seal).digest();
  return Object.freeze({
    sha256: text=>digest(String(text)),
    hmac: text=>createHmac('sha256',hmacKey).update(String(text)).digest('hex'),
    randomHex: n=>{ if(!Number.isInteger(n)||n<1||n>64) throw new Error('Invalid random byte count'); return randomBytes(n).toString('hex'); },
    randomInt: max=>randomInt(max),
    equal:(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);},
    seal:text=>{const iv=randomBytes(12), c=createCipheriv('aes-256-gcm',encKey,iv);const encrypted=Buffer.concat([c.update(String(text),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),encrypted]).toString('base64');},
    unseal:text=>{const b=Buffer.from(text,'base64');if(b.length<29)throw new Error('Invalid sealed payload');const d=createDecipheriv('aes-256-gcm',encKey,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}
  });
}
