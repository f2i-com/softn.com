/**
 * Who a request is from (runtime/client-ip.php): the socket peer, unless the
 * operator listed that peer in private/config.json trustedProxies, in which
 * case X-Forwarded-For is walked from the right past every listed hop. Behind
 * a CDN the host used to see only the CDN's address, so every visitor shared
 * one rate-limit bucket; trusting the header blindly would have let any
 * client pick a fresh identity per request.
 *
 * Runs the PHP function on the command line; skipped, with the reason, when
 * PHP is not on PATH.
 */
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const file=fileURLToPath(new URL('../runtime/client-ip.php',import.meta.url));
const skip=spawnSync('php',['-v']).status===0?false:'php is not on PATH (install PHP 8.1+ to run this test)';
if(skip)console.warn('WARNING: tests/client-ip.test.mjs skipped: '+skip);
const test=(name,...rest)=>{const fn=rest.pop();return nodeTest(name,{...(rest[0]??{}),skip},fn);};

function resolve(cases) {
  const script=`require ${JSON.stringify(file)};$out=[];foreach(json_decode(stream_get_contents(STDIN),true) as $c)$out[]=softn_client_ip($c[0],$c[1],$c[2]);echo json_encode($out);`;
  const r=spawnSync('php',['-r',script],{input:JSON.stringify(cases),encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  return JSON.parse(r.stdout);
}

test('X-Forwarded-For is believed only from a listed proxy, walked from the right',()=>{
  const many=Array.from({length:20},()=>'10.0.0.2').join(', ');
  const cases=[
    // [REMOTE_ADDR, X-Forwarded-For, trustedProxies, expected, why]
    ['203.0.113.9','198.51.100.1',undefined,'203.0.113.9','no setting: the header is never read'],
    ['203.0.113.9','198.51.100.1',[],'203.0.113.9','an empty list trusts nobody'],
    ['203.0.113.9','198.51.100.1',['10.0.0.0/8'],'203.0.113.9','an unlisted peer cannot name its client'],
    ['10.0.0.7','198.51.100.1',['10.0.0.0/8'],'198.51.100.1','a listed peer names the client it saw'],
    ['10.0.0.7','198.51.100.1, 10.0.0.8',['10.0.0.0/8'],'198.51.100.1','listed hops are skipped'],
    ['10.0.0.7','1.1.1.1, 198.51.100.1',['10.0.0.0/8'],'198.51.100.1','what the client prepended is ignored'],
    ['10.0.0.7',`1.1.1.1, ${many}, 198.51.100.1`,['10.0.0.0/8'],'198.51.100.1','forged hops cannot push the real entry out of reach'],
    ['10.0.0.7',many,['10.0.0.0/8'],'10.0.0.7','an overlong chain of hops: the peer'],
    ['10.0.0.7','unknown, 10.0.0.8',['10.0.0.0/8'],'10.0.0.7','a malformed entry: the peer'],
    ['10.0.0.7',null,['10.0.0.0/8'],'10.0.0.7','no header: the peer'],
    ['10.0.0.7','198.51.100.1:5555',['10.0.0.7'],'198.51.100.1','a single address, and a port dropped'],
    ['2001:db8::10','[2001:db8:1234::5]:443, 2001:db8::11',['2001:db8::/48'],'2001:db8:1234::5','IPv6 ranges and hops'],
    ['::ffff:10.0.0.7','198.51.100.1',['10.0.0.0/8'],'198.51.100.1','an IPv4-mapped peer matches its IPv4 range'],
    ['10.0.0.7','198.51.100.1',['not-a-range','10.0.0.0/33','10.0.0.0/8 '],'198.51.100.1','malformed ranges are skipped, the rest stand'],
    ['10.0.0.7','198.51.100.1','10.0.0.0/8','10.0.0.7','a setting that is not a list trusts nobody'],
    ['not-an-address','198.51.100.1',['0.0.0.0/0'],'0.0.0.0','a REMOTE_ADDR that is no address is nobody'],
  ];
  const got=resolve(cases.map(c=>c.slice(0,3)));
  cases.forEach((c,i)=>assert.equal(got[i],c[3],c[4]));
});

test('the host hands the resolved address, not REMOTE_ADDR, to its rate limit and to the app',()=>{
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8');
  assert.match(http,/require_once __DIR__\.'\/client-ip\.php'/);
  assert.match(http,/'client_ip'=>\$clientIp/);
  assert.doesNotMatch(http,/'client_ip'=>\$_SERVER\['REMOTE_ADDR'\]/);
});
