<?php
declare(strict_types=1);
// Shared hosts may disable any of these; a disabled function is a fatal
// error in PHP 8, so each is called only when present.
if(function_exists('ini_set')){ini_set('display_errors','0');ini_set('memory_limit','256M');}
if(function_exists('set_time_limit'))set_time_limit(35);
if(function_exists('ignore_user_abort'))ignore_user_abort(true); // Always reap the runner, even after a browser disconnects.
require_once __DIR__.'/client-ip.php';
require_once __DIR__.'/request.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
// JSON is never a page: nothing in it may load, run or be framed.
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
function reply(int $status, array $body): never { http_response_code($status); echo json_encode($body, JSON_INVALID_UTF8_SUBSTITUTE); exit; }
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if (!is_string($path) || !str_starts_with($path, '/api/') || strlen($path)>256) reply(404, ['error'=>'Not found.']);
$manifest=json_decode(@file_get_contents($backend.'/app/manifest.json')?:'null',true);
if(!is_array($manifest))reply(503,['error'=>'Application bundle is unavailable.']);
// Operator settings, read before any request data is believed: trustedProxies
// decides both who the client is and whether X-Forwarded-Proto names its scheme.
$operator=json_decode((string)@file_get_contents($backend.'/private/config.json'),true);
$trustedProxies=is_array($operator)?($operator['trustedProxies']??[]):[];
$remoteAddr=(string)($_SERVER['REMOTE_ADDR']??'');
// A browser page may call this API from this site itself, or from an origin
// listed in config.server.allowedOrigins. Authentication is the app's bearer
// session, never a cookie, so a request without Origin is not a CSRF vector.
$origin=$_SERVER['HTTP_ORIGIN']??null;
$ownOrigin=softn_own_origin($_SERVER,softn_peer_is_trusted_proxy($remoteAddr,$trustedProxies));
$originAllowed=softn_origin_allowed($origin,$manifest['config']['server']['allowedOrigins']??[],$ownOrigin);
if($origin!==null)header('Vary: Origin');
if($origin!==null&&$originAllowed)header('Access-Control-Allow-Origin: '.$origin);
// OPTIONS is answered as the Rust host's CORS layer answers it (that sends 200):
// an ok status, never a handler. A browser's preflight carries Origin, and only an allowed
// one gets Access-Control-Allow-Origin back, so a foreign page's preflight
// fails in the browser. An OPTIONS with no Origin is not a CORS request at
// all (a probe or a tool), and learns only the methods.
if ($method==='OPTIONS') {
    header('Allow: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: '.softn_preflight_headers($_SERVER['HTTP_ACCESS_CONTROL_REQUEST_HEADERS']??null));
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Max-Age: 600');
    http_response_code(204); exit;
}
if(!$originAllowed)reply(403,['error'=>'Origin not allowed.','code'=>'origin_not_allowed']);
header('Access-Control-Expose-Headers: ETag, X-SoftN-Poll-Interval');
if (!in_array($method,['GET','POST','PUT','DELETE'],true)) reply(405,['error'=>'Method not allowed.']);
$routes=$manifest['server']['routes']??[];
$route=null;foreach(is_array($routes)?$routes:[] as $r)if(is_array($r)&&($r['path']??null)===$path&&($r['method']??null)===$method){$route=$r;break;}
if($route===null && !($path==='/api/meta'&&$method==='GET'))reply(404,['error'=>'Endpoint not found.']);
$upload=($route['upload']??null)==='photo' && $method==='POST';
$limit=softn_body_limit($route['maxBodySize']??null,$manifest['config']['server']['maxBodySize']??null,$upload);
if($limit===null)reply(503,['error'=>'Invalid body limit configuration.']);
if ((int)($_SERVER['CONTENT_LENGTH']??0)>$limit) reply(413,['error'=>'Request too large.','code'=>'payload_too_large']);
$raw=file_get_contents('php://input',false,null,0,$limit+1);
if ($raw===false || strlen($raw)>$limit) reply(413,['error'=>'Request too large.','code'=>'payload_too_large']);
if ($raw!=='' && strtolower(trim(explode(';',$_SERVER['CONTENT_TYPE']??'')[0]))!=='application/json') reply(415,['error'=>'Use application/json','code'=>'unsupported_media_type']);
// No body is an empty object, as on the Rust host, so `req.body.x` never throws.
// Depth 64 is that host's MAX_JSON_DEPTH.
try {$body=$raw===''?new stdClass():json_decode($raw,false,64,JSON_THROW_ON_ERROR);} catch(Throwable $e){reply(400,['error'=>'Request body must be a JSON object','code'=>'invalid_request']);}
if (!is_object($body)) reply(400,['error'=>'Request body must be a JSON object','code'=>'invalid_request']);
if (!function_exists('proc_open') || !function_exists('proc_get_status') || !function_exists('proc_terminate')) reply(503,['error'=>'This host must enable PHP process execution (proc_open, proc_get_status, proc_terminate).','code'=>'backend_unavailable','diagnostic'=>'php_process_functions']);
$backend=realpath($backend);
if (!$backend || !is_file($backend.'/private/config.json') || !is_executable($backend.'/bin/node')) reply(503,['error'=>'Run the private backend setup first.','code'=>'backend_unavailable','diagnostic'=>'setup_required']);
$public=realpath($_SERVER['DOCUMENT_ROOT']??__DIR__);
if ($public && ($backend===$public || str_starts_with($backend,rtrim($public,'/').'/'))) reply(503,['error'=>'The backend must be outside the public document root.','code'=>'backend_unavailable','diagnostic'=>'backend_public']);
// How many requests may run at once, each a Node process: config.server.workers
// in the manifest, four when unset, at most sixteen on this host. A slot file
// setup did not make is made here.
$workers=(int)($manifest['config']['server']['workers']??4);$workers=max(1,min(16,$workers));
$slot=null;
for($i=0;$i<$workers;$i++) {
    $candidate=@fopen($backend.'/private/slot-'.$i.'.lock','c');
    if($candidate && flock($candidate,LOCK_EX|LOCK_NB)){$slot=$candidate;break;}
    if($candidate)fclose($candidate);
}
if(!$slot)reply(503,['error'=>'The server is busy. Please retry.','code'=>'database_busy']);
// Only HTTP metadata from Apache is trusted. Never accept a caller's client_ip,
// upload flags, executable path or script source. X-Forwarded-For is read only
// from a peer the operator listed in private/config.json trustedProxies
// (client-ip.php); with none listed, the client is REMOTE_ADDR.
$clientIp=softn_client_ip($remoteAddr,$_SERVER['HTTP_X_FORWARDED_FOR']??null,$trustedProxies);
$request=['path'=>$path,'method'=>$method,'query'=>(object)softn_query((string)($_SERVER['QUERY_STRING']??'')),
    'headers'=>(object)softn_request_headers($_SERVER),'body'=>$body,
    'client_ip'=>$clientIp,'rate_key'=>softn_rate_key($clientIp),'photos'=>extension_loaded('gd')];
if($upload) {
    if(!extension_loaded('gd'))reply(503,['error'=>'Enable PHP GD for photo uploads.']);
    require_once $backend.'/photos.php';
    try{$request['upload']=sanitize_photo($body->data_url??null);$request['body']=new stdClass();}
    catch(Throwable $e){reply(400,['error'=>'Photo rejected. Use a still JPEG, PNG or WebP under 4 MB, 16 megapixels and 8192 pixels a side.']);}
}
$process=null;$pipes=[];
try {
    // Array command bypasses the shell; no request data becomes an argument.
    $process=proc_open([$backend.'/bin/node','--max-old-space-size=128','--disable-proto=throw',$backend.'/runner.mjs'],
        [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes,$backend,
        ['PATH'=>'/usr/bin:/bin','TZ'=>'UTC','NODE_NO_WARNINGS'=>'1']);
    if(!is_resource($process))throw new RuntimeException('spawn');
    foreach($pipes as $pipe)stream_set_blocking($pipe,false);
    // Invalid UTF-8 in a header or the query becomes U+FFFD rather than failing the request.
    $input=json_encode($request,JSON_THROW_ON_ERROR|JSON_INVALID_UTF8_SUBSTITUTE);$offset=0;$output='';$errorBytes=0;$exitCode=null;
    $deadline=hrtime(true)+25_000_000_000;
    while(true) {
        if(hrtime(true)>$deadline)throw new RuntimeException('timeout');
        $read=[];foreach([1,2] as $i)if(is_resource($pipes[$i])&&!feof($pipes[$i]))$read[]=$pipes[$i];
        $write=is_resource($pipes[0])?[$pipes[0]]:[];$except=[];
        if($read || $write)@stream_select($read,$write,$except,0,20000);else usleep(10000);
        foreach($write as $pipe) {
            $n=fwrite($pipe,substr($input,$offset,65536));if($n===false)throw new RuntimeException('write');$offset+=$n;
            if($offset===strlen($input)){fclose($pipes[0]);$pipes[0]=null;}
        }
        foreach($read as $pipe) {
            $chunk=fread($pipe,65536);if($chunk===false)throw new RuntimeException('read');
            if($pipe===$pipes[1])$output.=$chunk;else $errorBytes+=strlen($chunk);
            if(strlen($output)>3*1024*1024+64 || $errorBytes>65536)throw new RuntimeException('output limit');
        }
        $status=proc_get_status($process);
        if(!$status['running']) {
            if($exitCode===null)$exitCode=$status['exitcode'];
            if(feof($pipes[1])&&feof($pipes[2]))break;
        }
    }
    if($exitCode!==0)throw new RuntimeException('runner failure');
    $result=softn_runner_result($output);
    if($result===null)throw new RuntimeException('protocol');
} catch(Throwable $e) {
    $result=['status'=>503,'body'=>json_encode(['error'=>'The request could not be completed. Please retry.','code'=>'runner_unavailable'])];
} finally {
    if(is_resource($process)) {
        if(proc_get_status($process)['running'])proc_terminate($process,9);
        foreach($pipes as $pipe)if(is_resource($pipe))fclose($pipe);
        proc_close($process);
    }
    flock($slot,LOCK_UN);fclose($slot);
}
$responseBody=$result['body'];
// Always run the authenticated handler first, including on conditional polls.
// No server-side user-response cache and no bypass of revocation checks.
if(($route['poll']??false)===true && $method==='GET' && $result['status']===200) {
    $etag='"'.hash('sha256',$responseBody).'"';
    header('ETag: '.$etag);header('X-SoftN-Poll-Interval: 5000');
    if(softn_etag_matches((string)($_SERVER['HTTP_IF_NONE_MATCH']??''),$etag)){http_response_code(304);exit;}
}
http_response_code($result['status']);echo $responseBody;
