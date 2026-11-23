import {isIP} from 'node:net';
// Which visitor a live-updates connection counts against; see websocket.mjs.
// Dependency-free so it can be tested without the packaged ws vendor tree.
// The visitor a connection comes from. The bridge binds to loopback behind the
// site's own proxy (LIVE_UPDATES.md), so a loopback peer is that proxy and the
// last valid X-Forwarded-For IP entry is the address it appended; anything else
// is the peer itself. IPv6 counts by /64, as the PHP host's rate limits do.
export function clientKey(req) {
  const peer=String(req.socket?.remoteAddress??'').replace(/^::ffff:/,'');
  const loopback=peer==='127.0.0.1'||peer==='::1';
  const rawForwarded=loopback?String(req.headers['x-forwarded-for']??'').split(',').map(s=>s.trim()).filter(Boolean).at(-1):undefined;
  const candidate=rawForwarded?rawForwarded.replace(/^::ffff:/,''):undefined;
  const forwarded=candidate&&isIP(candidate)!==0?candidate:undefined;
  const address=(forwarded||peer).replace(/^::ffff:/,'').toLowerCase();
  if(!address.includes(':'))return address;
  const [head]=address.split('%');const parts=head.split('::');
  const left=parts[0]?parts[0].split(':'):[],right=parts.length>1&&parts[1]?parts[1].split(':'):[];
  const full=[...left,...Array(Math.max(0,8-left.length-right.length)).fill('0'),...right];
  return full.slice(0,4).map(h=>h.replace(/^0+(?=.)/,'')).join(':')+'::/64';
}
