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
// HEAD on a GET route is that GET with the body left off the answer, as on
// the Rust host: the runner is asked for the GET. It was refused here, 405.
$head=$method==='HEAD';if($head)$method='GET';
$routes=$manifest['server']['routes']??[];
// A path nobody declared is not found, whatever the method; a declared path
// asked with a method it does not declare is 405, as the Rust host answers
// it. That used to be 404 here, as though the path were not there, and a
// method this host does not serve was 405 even where there was no such path.
$route=null;$declared=$path==='/api/meta'?['GET']:[];
foreach(is_array($routes)?$routes:[] as $r) {
    if(!is_array($r)||($r['path']??null)!==$path||!is_string($r['method']??null))continue;
    $declared[]=$r['method'];
    if($route===null&&$r['method']===$method)$route=$r;
}
if($declared===[])reply(404,['error'=>'Endpoint not found.']);
if(!in_array($method,['GET','POST','PUT','DELETE'],true)||($route===null&&!($path==='/api/meta'&&$method==='GET'))) {
    $allow=softn_allowed_methods($declared);if($allow!=='')header('Allow: '.$allow);
    reply(405,['error'=>'Method not allowed.','code'=>'method_not_allowed']);
}
// Only HTTP metadata from Apache is trusted. Never accept a caller's client_ip,
// upload flags, executable path or script source. X-Forwarded-For is read only
// from a peer the operator listed in private/config.json trustedProxies
// (client-ip.php); with none listed, the client is REMOTE_ADDR.
$clientIp=softn_client_ip($remoteAddr,$_SERVER['HTTP_X_FORWARDED_FOR']??null,$trustedProxies);
$rateKey=softn_rate_key($clientIp);
// A bucket the runner has refused this minute is answered here, before the
// body is read: no worker slot, no photo decode, no Node process. The runner
// leaves the note and stays the one that counts (request-worker.mjs
// markLimited); the Rust host checks its limit at this point too.
if(is_file(softn_rate_marker($backend,$rateKey,time()))){header('Retry-After: '.softn_retry_after(time()));reply(429,['error'=>'Too many requests.','code'=>'rate_limited']);}
$upload=($route['upload']??null)==='photo' && $method==='POST';
$limit=softn_body_limit($route['maxBodySize']??null,$manifest['config']['server']['maxBodySize']??null,$upload);
if($limit===null)reply(503,['error'=>'Invalid body limit configuration.']);
if ((int)($_SERVER['CONTENT_LENGTH']??0)>$limit) reply(413,['error'=>'Request too large.','code'=>'payload_too_large']);
$raw=file_get_contents('php://input',false,null,0,$limit+1);
if ($raw===false || strlen($raw)>$limit) reply(413,['error'=>'Request too large.','code'=>'payload_too_large']);
if ($raw!=='' && strtolower(trim(explode(';',$_SERVER['CONTENT_TYPE']??'')[0]))!=='application/json') reply(415,['error'=>'Use application/json','code'=>'unsupported_media_type']);
$body=softn_request_body($raw);
if ($body===null) reply(400,['error'=>'Request body must be a JSON object','code'=>'invalid_request']);
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
    // 'e': not inherited by the runner, which would otherwise keep the slot
    // locked for as long as it lived, after this request had gone.
    $candidate=@fopen($backend.'/private/slot-'.$i.'.lock','ce');
    if($candidate && flock($candidate,LOCK_EX|LOCK_NB)){$slot=$candidate;break;}
    if($candidate)fclose($candidate);
}
if(!$slot)reply(503,['error'=>'The server is busy. Please retry.','code'=>'database_busy']);
$request=['path'=>$path,'method'=>$method,'query'=>(object)softn_query((string)($_SERVER['QUERY_STRING']??'')),
    'headers'=>(object)softn_request_headers($_SERVER),'body'=>$body,
    'client_ip'=>$clientIp,'rate_key'=>$rateKey,'photos'=>extension_loaded('gd')];
if($upload) {
    if(!extension_loaded('gd'))reply(503,['error'=>'Enable PHP GD for photo uploads.']);
    require_once $backend.'/photos.php';
    // A photo this host will not take is still a request the caller made: the
    // runner counts it against their rate limit and answers the refusal. It
    // was answered here, with a worker slot held and the image decoded, and
    // never counted, so refused uploads could keep every slot busy for ever.
    try{$request['upload']=sanitize_photo($body->data_url??null);}
    catch(Throwable $e){$request['refused']='photo';}
    // The image itself is not sent on, taken or refused.
    $request['body']=new stdClass();
}
$process=null;$pipes=[];$errors='';$exitCode=null;
try {
    // Array command bypasses the shell; no request data becomes an argument.
    $process=proc_open([$backend.'/bin/node','--max-old-space-size=128','--disable-proto=throw',$backend.'/runner.mjs'],
        [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes,$backend,
        ['PATH'=>'/usr/bin:/bin','TZ'=>'UTC','NODE_NO_WARNINGS'=>'1']);
    if(!is_resource($process))throw new RuntimeException('spawn');
    foreach($pipes as $pipe)stream_set_blocking($pipe,false);
    // Invalid UTF-8 in a header or the query becomes U+FFFD rather than failing the request.
    // Text goes through as itself: escaped to \uXXXX, a 2 MiB body of
    // two-byte characters was 6 MB by the time the runner measured it, and
    // was refused there with "please retry".
    $input=json_encode($request,JSON_THROW_ON_ERROR|JSON_INVALID_UTF8_SUBSTITUTE|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);$offset=0;$output='';$errorBytes=0;
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
            if($pipe===$pipes[1])$output.=$chunk;else{$errorBytes+=strlen($chunk);if(strlen($errors)<4096)$errors.=substr($chunk,0,4096-strlen($errors));}
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
    // Which step failed, as one of a fixed set of words: never what it said.
    $reason=in_array($e->getMessage(),['spawn','timeout','write','read','output limit','runner failure','protocol'],true)?str_replace(' ','_',$e->getMessage()):($e instanceof JsonException?'request_encoding':'unexpected');
    $result=['status'=>503,'body'=>json_encode(['error'=>'The request could not be completed. Please retry.','code'=>'runner_unavailable','diagnostic'=>$reason])];
    $errors="softn: runner $reason".($exitCode===null||$exitCode===0?'':" (exit $exitCode)")."\n".$errors;
} finally {
    if(is_resource($process)) {
        if(proc_get_status($process)['running'])proc_terminate($process,9);
        foreach($pipes as $pipe)if(is_resource($pipe))fclose($pipe);
        proc_close($process);
    }
    flock($slot,LOCK_UN);fclose($slot);
}
// What failed, for whoever runs this host: the runner's own line naming the
// handler or startup stage and its reason (wasm-host.mjs logFailure), and
// the step that failed here. It goes to PHP's error log and nowhere else.
if($errors!==''&&function_exists('error_log'))foreach(softn_log_lines($errors) as $line)error_log('softn-host '.$method.' '.$path.': '.$line);
// The host's own refusal says when to come back, as the Rust host does.
if($result['status']===429&&is_file(softn_rate_marker($backend,$rateKey,time())))header('Retry-After: '.softn_retry_after(time()));
$responseBody=$result['body'];
// Always run the authenticated handler first, including on conditional polls.
// No server-side user-response cache and no bypass of revocation checks.
if(($route['poll']??false)===true && $method==='GET' && $result['status']===200) {
    $etag='"'.hash('sha256',$responseBody).'"';
    header('ETag: '.$etag);header('X-SoftN-Poll-Interval: 5000');
    if(softn_etag_matches((string)($_SERVER['HTTP_IF_NONE_MATCH']??''),$etag)){http_response_code(304);exit;}
}
http_response_code($result['status']);if(!$head)echo $responseBody;
