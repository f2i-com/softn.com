<?php
declare(strict_types=1);
ini_set('display_errors', '0');
ini_set('memory_limit', '256M');
set_time_limit(35);
ignore_user_abort(true); // Always reap the runner, even after a browser disconnects.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function reply(int $status, array $body): never { http_response_code($status); echo json_encode($body, JSON_INVALID_UTF8_SUBSTITUTE); exit; }
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if (!is_string($path) || !str_starts_with($path, '/api/') || strlen($path)>256) reply(404, ['error'=>'Not found.']);
$manifest=json_decode(@file_get_contents($backend.'/app/manifest.json')?:'null',true);
if(!is_array($manifest))reply(503,['error'=>'Application bundle is unavailable.']);
$origins=$manifest['config']['server']['allowedOrigins']??[];
$origin=$_SERVER['HTTP_ORIGIN']??null;
if($origin!==null&&!in_array($origin,$origins,true))reply(403,['error'=>'Origin not allowed.']);
if($origin!==null){header('Access-Control-Allow-Origin: '.$origin);header('Vary: Origin');}
header('Access-Control-Expose-Headers: ETag, X-SoftN-Poll-Interval');
if ($method==='OPTIONS') {
    if($origin===null)reply(403,['error'=>'Origin required.']);
    header('Access-Control-Allow-Origin: '.$origin);
    header('Access-Control-Allow-Headers: Content-Type, Authorization, Idempotency-Key, If-None-Match');
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    http_response_code(204); exit;
}
if (!in_array($method,['GET','POST','PUT','DELETE'],true)) reply(405,['error'=>'Method not allowed.']);
$routes=$manifest['server']['routes']??[];
$route=null;foreach($routes as $r)if(($r['path']??null)===$path&&($r['method']??null)===$method){$route=$r;break;}
if($route===null && !($path==='/api/meta'&&$method==='GET'))reply(404,['error'=>'Endpoint not found.']);
$upload=($route['upload']??null)==='photo' && $method==='POST';
$limit=min($upload?5600100:32768,(int)($route['maxBodySize']??$manifest['config']['server']['maxBodySize']??PHP_INT_MAX));
if($limit<0)reply(503,['error'=>'Invalid body limit configuration.']);
if ((int)($_SERVER['CONTENT_LENGTH']??0)>$limit) reply(413,['error'=>'Request too large.']);
$raw=file_get_contents('php://input',false,null,0,$limit+1);
if ($raw===false || strlen($raw)>$limit) reply(413,['error'=>'Request too large.']);
if ($raw!=='' && strtolower(trim(explode(';',$_SERVER['CONTENT_TYPE']??'')[0]))!=='application/json') reply(415,['error'=>'Send application/json.']);
try {$body=$raw===''?null:json_decode($raw,false,32,JSON_THROW_ON_ERROR);} catch(Throwable $e){reply(400,['error'=>'Invalid JSON.']);}
if ($body!==null && !is_object($body)) reply(400,['error'=>'JSON body must be an object.']);
if (!function_exists('proc_open') || !function_exists('proc_terminate')) reply(503,['error'=>'This host must enable PHP process execution.']);
$backend=realpath($backend);
if (!$backend || !is_file($backend.'/private/config.json') || !is_executable($backend.'/bin/node')) reply(503,['error'=>'Run the private backend setup first.']);
$public=realpath($_SERVER['DOCUMENT_ROOT']??__DIR__);
if ($public && ($backend===$public || str_starts_with($backend,$public.'/'))) reply(503,['error'=>'The backend must be outside the public document root.']);
$slot=null;
for($i=0;$i<4;$i++) {
    $candidate=fopen($backend.'/private/slot-'.$i.'.lock','c');
    if($candidate && flock($candidate,LOCK_EX|LOCK_NB)){$slot=$candidate;break;}
    if($candidate)fclose($candidate);
}
if(!$slot)reply(503,['error'=>'The server is busy. Please retry.','code'=>'database_busy']);
// Only HTTP metadata from Apache is trusted. Never accept a caller's client_ip,
// upload flags, executable path, script source or forwarded-IP headers.
$authorization='';$authorizationKey='HTTP_AUTHORIZATION';
for($i=0;$i<6;$i++) {
    if(isset($_SERVER[$authorizationKey])){$authorization=$_SERVER[$authorizationKey];break;}
    $authorizationKey='REDIRECT_'.$authorizationKey;
}
$headers=['authorization'=>$authorization,
    'idempotency-key'=>$_SERVER['HTTP_IDEMPOTENCY_KEY']??''];
$request=['path'=>$path,'method'=>$method,'query'=>(object)$_GET,'headers'=>$headers,'body'=>$body,
    'client_ip'=>$_SERVER['REMOTE_ADDR']??'unknown','photos'=>extension_loaded('gd')];
if($upload) {
    if(!extension_loaded('gd'))reply(503,['error'=>'Enable PHP GD for photo uploads.']);
    require_once $backend.'/photos.php';
    try{$request['upload']=sanitize_photo($body->data_url??null);$request['body']=(object)[];}
    catch(Throwable $e){reply(400,['error'=>'Photo rejected. Use a still JPEG, PNG or WebP under 4 MB and 16 megapixels.']);}
}
$process=null;$pipes=[];
try {
    // Array command bypasses the shell; no request data becomes an argument.
    $process=proc_open([$backend.'/bin/node','--max-old-space-size=128','--disable-proto=throw',$backend.'/runner.mjs'],
        [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes,$backend,
        ['PATH'=>'/usr/bin:/bin','TZ'=>'UTC','NODE_NO_WARNINGS'=>'1']);
    if(!is_resource($process))throw new RuntimeException('spawn');
    foreach($pipes as $pipe)stream_set_blocking($pipe,false);
    $input=json_encode($request,JSON_THROW_ON_ERROR);$offset=0;$output='';$errorBytes=0;$exitCode=null;
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
            if(strlen($output)>3*1024*1024 || $errorBytes>65536)throw new RuntimeException('output limit');
        }
        $status=proc_get_status($process);
        if(!$status['running']) {
            if($exitCode===null)$exitCode=$status['exitcode'];
            if(feof($pipes[1])&&feof($pipes[2]))break;
        }
    }
    if($exitCode!==0)throw new RuntimeException('runner failure');
    $result=json_decode($output,true,32,JSON_THROW_ON_ERROR);
    if(!is_array($result)||!is_int($result['status']??null)||$result['status']<200||$result['status']>599||!array_key_exists('body',$result))throw new RuntimeException('protocol');
} catch(Throwable $e) {
    $result=['status'=>503,'body'=>['error'=>'The request could not be completed. Please retry.','code'=>'runner_unavailable']];
} finally {
    if(is_resource($process)) {
        if(proc_get_status($process)['running'])proc_terminate($process,9);
        foreach($pipes as $pipe)if(is_resource($pipe))fclose($pipe);
        proc_close($process);
    }
    flock($slot,LOCK_UN);fclose($slot);
}
$responseBody=json_encode($result['body'],JSON_INVALID_UTF8_SUBSTITUTE);
// Always run the authenticated handler first, including on conditional polls.
// No server-side user-response cache and no bypass of revocation checks.
if(($route['poll']??false)===true && $method==='GET' && $result['status']===200) {
    $etag='"'.hash('sha256',$responseBody).'"';
    header('ETag: '.$etag);header('X-SoftN-Poll-Interval: 5000');
    if(($_SERVER['HTTP_IF_NONE_MATCH']??'')===$etag){http_response_code(304);exit;}
}
http_response_code($result['status']);echo $responseBody;
