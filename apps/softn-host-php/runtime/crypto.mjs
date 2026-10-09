import {createHash,createHmac,randomBytes,randomInt,timingSafeEqual,createCipheriv,createDecipheriv} from 'node:crypto';
const digest=text=>createHash('sha256').update(String(text)).digest('hex');
/**
 * A bound or a count a script gave: a whole number, or text that spells one
 * (`softn.crypto.randomInt(req.query.sides)`), which is how the Rust host
 * reads these arguments; its preamble hands every argument over as text.
 * Null when it is neither. Only a number used to do here, so a handler that
 * worked on that host was a failed call on this one.
 */
const whole=value=>{const text=String(value);if(!/^\+?[0-9]+$/.test(text))return null;const n=Number(text);return Number.isSafeInteger(n)?n:null;};
/**
 * A whole number from 0 up to but not including `bound`, every one as likely
 * as the next. Node's randomInt stops at a range of 2^48 and the Rust host's
 * bound goes to 2^53-1, so past Node's limit the number is drawn here: 53
 * random bits, drawn again when they fall in the uneven tail at the top
 * (which is what keeps small results from being favoured).
 */
function below(bound) {
  if(bound<2**48)return randomInt(bound);
  const fair=2**53-2**53%bound;
  for(;;){const bytes=randomBytes(7),drawn=(bytes.readUIntBE(0,3)&0x1fffff)*2**32+bytes.readUInt32BE(3);if(drawn<fair)return drawn%bound;}
}
export function createCrypto(key,cryptoDomains) {
  if(!Buffer.isBuffer(key)||key.length!==32) throw new Error('A 32-byte key is required');
  const domains=cryptoDomains;
  const hmacKey=createHmac('sha256',key).update(domains.hmac).digest();
  const encKey=createHmac('sha256',key).update(domains.seal).digest();
  return Object.freeze({
    sha256: text=>digest(String(text)),
    hmac: text=>createHmac('sha256',hmacKey).update(String(text)).digest('hex'),
    randomHex: n=>{ const count=whole(n); if(count===null||count<1||count>64) throw new Error('Invalid random byte count'); return randomBytes(count).toString('hex'); },
    randomInt: max=>{ const bound=whole(max); if(bound===null||bound<1) throw new Error('Invalid random integer bound'); return below(bound); },
    equal:(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);},
    seal:text=>{const iv=randomBytes(12), c=createCipheriv('aes-256-gcm',encKey,iv);const encrypted=Buffer.concat([c.update(String(text),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),encrypted]).toString('base64');},
    unseal:text=>{const b=Buffer.from(text,'base64');if(b.length<29)throw new Error('Invalid sealed payload');const d=createDecipheriv('aes-256-gcm',encKey,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}
  });
}
