<?php
declare(strict_types=1);
// The request and response rules http.php applies, as pure functions so that
// tests/request.test.mjs can drive them with `php -r`. Each follows the Rust
// host's reading of the same backend contract (apps/softn-host-rust/src/http.rs)
// unless a comment says why this host differs.

/**
 * The query string as the app sees it: names and values percent-decoded
 * (`+` is a space), every value a string, the last of a repeated name kept.
 * PHP's own $_GET is not that: it turns `a.b` into `a_b`, makes `a[]=1` an
 * array (which then fails the SQL parameter check) and drops pairs past
 * max_input_vars. The Rust host hands a map of strings.
 * @return array<string,string>
 */
function softn_query(string $queryString, int $maxPairs=256): array {
    $out=[];$pairs=0;
    foreach(explode('&',$queryString) as $pair) {
        if($pair==='')continue;
        if(++$pairs>$maxPairs)break;
        [$name,$value]=array_pad(explode('=',$pair,2),2,'');
        $out[urldecode($name)]=urldecode($value);
    }
    return $out;
}

/**
 * The request headers a handler may read, lower-cased: every header but
 * Cookie and Proxy-Authorization, as the Rust host's script_headers(). The
 * app authenticates with its own bearer session; cookies are never its.
 * `authorization` and `idempotency-key` are always present (empty when not
 * sent), as this host has always supplied them.
 * @param array<string,mixed> $server
 * @return array<string,string>
 */
function softn_request_headers(array $server): array {
    $headers=[];
    foreach($server as $key=>$value) {
        if(!is_string($key)||!is_string($value)||!str_starts_with($key,'HTTP_'))continue;
        $name=strtolower(str_replace('_','-',substr($key,5)));
        if($name===''||$name==='cookie'||$name==='proxy-authorization'||$name==='authorization')continue;
        $headers[$name]=$value;
        if(count($headers)>=100)break;
    }
    foreach(['CONTENT_TYPE'=>'content-type','CONTENT_LENGTH'=>'content-length'] as $key=>$name)
        if(isset($server[$key])&&is_string($server[$key])&&$server[$key]!=='')$headers[$name]=$server[$key];
    // Apache hands Authorization to CGI/FPM only through the rewrite rule's
    // environment, which a rewrite may prefix with REDIRECT_ one or more times.
    $authorization='';$key='HTTP_AUTHORIZATION';
    for($i=0;$i<6;$i++){if(isset($server[$key])&&is_string($server[$key])){$authorization=$server[$key];break;}$key='REDIRECT_'.$key;}
    $headers['authorization']=$authorization;
    $headers['idempotency-key']??='';
    return $headers;
}

/**
 * What a 405 says may be asked of a path: the methods declared for it that
 * this host serves, HEAD beside GET, each once and in the order declared.
 * @param list<string> $declared
 */
function softn_allowed_methods(array $declared): string {
    $allow=[];
    foreach($declared as $method) {
        if(!in_array($method,['GET','POST','PUT','DELETE'],true)||in_array($method,$allow,true))continue;
        $allow[]=$method;if($method==='GET')$allow[]='HEAD';
    }
    return implode(', ',$allow);
}

/**
 * The request body as the handler receives it: a JSON object, `{}` when
 * nothing was sent (as on the Rust host, so `req.body.x` never throws), or
 * null when the bytes are not one.
 *
 * It may nest 62 levels deep, the body itself the first (json_decode's depth
 * 63 counts the values inside the last one), which is that host's
 * MAX_BODY_DEPTH. That is what a handler can be handed: the engine passes a
 * script nothing below it. One level more used to be accepted here, and the
 * handler found null where the innermost object had been.
 *
 * A number past the range of a double is refused here as well. PHP decodes
 * `1e999` to INF, which cannot be written back as JSON, so the request failed
 * while being handed to a runner already started for it and was answered 503
 * "please retry": for a body no retry could mend. The Rust host answers 400.
 */
function softn_request_body(string $raw): ?object {
    if($raw==='')return new stdClass();
    try {
        $body=json_decode($raw,false,63,JSON_THROW_ON_ERROR);
        if(!is_object($body))return null;
        json_encode($body,JSON_THROW_ON_ERROR|JSON_INVALID_UTF8_SUBSTITUTE);
        return $body;
    } catch(Throwable $e) {return null;}
}

/** softn-runner as a release puts it in backend/bin: the one server it is built for. */
const SOFTN_RUNNER_BINARY='softn-runner-linux-x86_64';

/**
 * Which runner answers a request, for a request (http.php) and for setup's
 * check of one (setup.php): one rule, so that setup checks the runner every
 * request will start.
 *
 * softn-runner (apps/softn-runner) where the backend carries it and this
 * server is the one it is built for: it takes the request runner.mjs takes
 * and gives the same answer, without Node. Node and runner.mjs otherwise,
 * and also where the operator asks for them (`"runner": "node"` in
 * private/config.json) or has enabled a request hook, which is a JavaScript
 * module of the operator's that only Node runs (softn-runner refuses such a
 * configuration). `$os` and `$machine` are this server's; a test names them.
 * A machine PHP cannot name (php_uname disabled, which the web server's PHP
 * may do where the command line's does not) is taken for the one the
 * backend was built for, so that setup and a request choose alike: the
 * archive is for Linux x86-64, and setup's check runs what it chose.
 * @param mixed $config private/config.json, decoded
 * @return array{runner:'softn-runner'|'node',binary:string,command:list<string>}
 */
function softn_runner_choice(string $backend, mixed $config, string $os=PHP_OS_FAMILY, ?string $machine=null): array {
    $config=is_array($config)?$config:[];
    $machine??=function_exists('php_uname')?php_uname('m'):'';
    $binary=$backend.'/bin/'.SOFTN_RUNNER_BINARY;
    $hooks=($config['enableRequestHook']??null)===true||($config['enableAfterRequestHook']??null)===true;
    if($os==='Linux'&&($machine===''||in_array(strtolower($machine),['x86_64','amd64'],true))&&($config['runner']??null)!=='node'&&!$hooks&&is_file($binary))
        return ['runner'=>'softn-runner','binary'=>$binary,'command'=>[$binary]];
    return ['runner'=>'node','binary'=>$backend.'/bin/node','command'=>softn_runner_command($backend)];
}

/** How much memory, in MiB, one request on softn-runner may take, with no word from the operator: what Node's engine is held to here. */
const SOFTN_REQUEST_MEMORY_MB=256;

/**
 * The operator's `requestMemoryMb` in private/config.json, a whole number of
 * MiB from 128 to 1024, or the default: what one request on softn-runner may
 * take for the app's engine, and as much again for SQLite (the script heap
 * is 64 MiB less). Node's runner is not told: its engine is held to 256 MiB
 * by the archive (package.mjs).
 * @param mixed $config private/config.json, decoded
 */
function softn_request_memory_mb(mixed $config): int {
    $mb=is_array($config)?($config['requestMemoryMb']??null):null;
    return is_int($mb)&&$mb>=128&&$mb<=1024?$mb:SOFTN_REQUEST_MEMORY_MB;
}

/**
 * What a runner is started with, and nothing else of PHP's own environment.
 * softn-runner finds the backend by SOFTN_BACKEND_ROOT (it is not beside
 * runner.mjs, but in bin/); runner.mjs reads it too, and it names the folder
 * runner.mjs is in. SOFTN_RUNNER_MEMORY_MB is softn-runner's alone.
 * @param mixed $config private/config.json, decoded
 * @return array<string,string>
 */
function softn_runner_environment(string $backend, mixed $config=null): array {
    return ['PATH'=>'/usr/bin:/bin','TZ'=>'UTC','NODE_NO_WARNINGS'=>'1','SOFTN_BACKEND_ROOT'=>$backend,'SOFTN_RUNNER_MEMORY_MB'=>(string)softn_request_memory_mb($config)];
}

/**
 * The command that starts Node's runner (softn_runner_choice says when):
 * one definition, so that a Node which will not take a flag fails setup and
 * not every request after it. No request data becomes an argument.
 *
 * The two wasm flags keep V8's optimizing compiler off the engine. A process
 * lives for one request, and the engine's dispatch loop is one function of
 * 280 KB: V8 starts optimizing it as soon as it runs hot, which takes about
 * 450 ms and over 100 MB, far longer than the request, and a process cannot
 * end while that compile is running. So every request waited about a third
 * of a second after its answer was written, burning a core, for code nothing
 * would ever run. The baseline compiler's code is what a request ran on for
 * its first half second anyway; only one that moves hundreds of megabytes
 * through the engine lives long enough to miss the optimized code (measured
 * at the most a request may do: 4.0 s for 3.3 s; the README has the rest).
 * Both flags are needed: without tier-up alone V8 still tiers up
 * dynamically, and without dynamic tiering alone it optimizes everything.
 * @return list<string>
 */
function softn_runner_command(string $backend): array {
    return [$backend.'/bin/node','--max-old-space-size=128','--disable-proto=throw','--no-wasm-tier-up','--no-wasm-dynamic-tiering',$backend.'/runner.mjs'];
}

/**
 * What the runner reads on stdin: the request as JSON, in the order of
 * `$request`, with the body's own text set in where `body` is.
 *
 * The body is the text the client sent (softn_request_body has already found
 * it to be a JSON object this host takes) and is never decoded and written
 * again on its way to the handler. Written again, a number came out in PHP's
 * spelling: `1e16` is `1.0e+16` and `1e14` is `100000000000000`, so a 2 MiB
 * body of them was 7.5 MB by the time the runner measured it. The runner
 * refuses input past 6 MB before it has counted the request, so the client
 * was told 503 "please retry" for a body no retry could mend, at the cost of
 * a Node process each time and outside the rate limit altogether. `-0` also
 * arrived as `0`, where the Rust host and JSON.parse keep the sign.
 * @param array<string,mixed> $request `body` marks the place; its value is not used
 */
function softn_runner_input(array $request, string $bodyJson): string {
    $flags=JSON_THROW_ON_ERROR|JSON_INVALID_UTF8_SUBSTITUTE|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES;
    $members=[];
    foreach($request as $key=>$value)
        $members[]=json_encode((string)$key,$flags).':'.($key==='body'?$bodyJson:json_encode($value,$flags));
    return '{'.implode(',',$members).'}';
}

/**
 * Whether the private backend is somewhere the web server serves files from:
 * inside the document root, or inside the directory api.php itself is in.
 * That one is public whatever DOCUMENT_ROOT says, and is all there is to go
 * on when the server passes none (the fallback used to be this file's own
 * directory, the backend itself, so such a server was always refused).
 * CONTEXT_DOCUMENT_ROOT is Apache's name for the directory an Alias or a
 * user directory maps to, where DOCUMENT_ROOT is still the main site's.
 * @param array<string,mixed> $server
 */
function softn_backend_is_public(string $backend, array $server): bool {
    $flat=fn(string $path)=>rtrim(str_replace('\\','/',$path),'/');
    $backend=$flat($backend);
    $roots=[];
    foreach(['DOCUMENT_ROOT','CONTEXT_DOCUMENT_ROOT'] as $key)
        if(isset($server[$key])&&is_string($server[$key])&&$server[$key]!=='')$roots[]=$server[$key];
    if(isset($server['SCRIPT_FILENAME'])&&is_string($server['SCRIPT_FILENAME'])&&$server['SCRIPT_FILENAME']!=='')$roots[]=dirname($server['SCRIPT_FILENAME']);
    foreach($roots as $root) {
        $public=realpath($root);
        if($public===false)continue;
        $public=$flat($public);
        if($backend===$public||str_starts_with($backend,$public.'/'))return true;
    }
    return false;
}

/**
 * How long a request waits for a worker slot before it is told the server
 * is busy, in milliseconds.
 *
 * A slot is held for about a fifth of a second, so a page that makes six
 * calls as it loads found four slots and was refused the other two at once,
 * with a slot a moment from free. One and a half seconds is seven turns of
 * the slots on the machine this was measured on; it leaves a host that
 * takes three times as long over a request two turns. It is no longer
 * because the wait comes out of what the caller allows the whole request:
 * the app's own fetch gives up after 15 seconds and the live bridge's poll
 * after 10, and PHP's time limit (30 seconds where http.php may not raise
 * it) has to cover this and the 25 seconds the runner may then take.
 */
const SOFTN_SLOT_WAIT_MS=1500;

/**
 * How many requests may run at once, each a Node process: the manifest's
 * config.server.workers (four when unset), no more than private/config.json
 * `workers` when the operator set one (a whole number, 1 or more), and one to
 * sixteen on this host. The manifest is the app owner's: it was the only say,
 * and the README's advice to lower it meant editing the bundle again after
 * every update of the app.
 */
function softn_workers(mixed $manifest, mixed $operator): int {
    $workers=(int)(is_array($manifest)?($manifest['config']['server']['workers']??4):4);
    $cap=is_array($operator)?($operator['workers']??null):null;
    if(is_int($cap)&&$cap>=1)$workers=min($workers,$cap);
    return max(1,min(16,$workers));
}

/**
 * How many requests may stand waiting for a slot at once: private/config.json
 * `slotWaiters` when the operator set it (0 for none: every request past the
 * slots is refused at once, as all were), else half as many as there are
 * workers, two for the default four. Under php-fpm http.php lets none wait
 * without the operator's number (softn_pool_has_room says why).
 *
 * The bound that matters is this one, not the time. Every waiting request
 * holds one of the web server's PHP workers, and a server has only so many
 * (Apache's MaxRequestWorkers, php-fpm's pm.max_children, a shared host's
 * process limit). With no limit on how many wait, an overload of the API
 * filled that pool with waiting requests and the rest stood in the web
 * server's own queue, which nothing here bounds: measured on a pool of
 * eight (Apache prefork, PHP as CGI) under 40 requests a second, every
 * answer of the site, a static file included, took three to seven seconds,
 * where refusing at once had left them at a millisecond. Workers and
 * waiters together have to stay below the pool for it to have a worker
 * free to say "busy" with. This host cannot see the pool; the operator
 * can, which is why the number is theirs to set, and why setup.php says
 * what it comes to.
 */
function softn_slot_waiters(mixed $configured, int $workers): int {
    if(softn_slot_waiters_set($configured))return min(64,$configured);
    return intdiv($workers+1,2);
}

/** Whether private/config.json `slotWaiters` holds the operator's own number: a whole number, 0 or more. */
function softn_slot_waiters_set(mixed $configured): bool {
    return is_int($configured)&&$configured>=0;
}

/**
 * Whether the PHP pool can be seen to have a worker to spare, so that a
 * request may stand waiting for a slot without taking the last one.
 *
 * Under any SAPI but php-fpm there is nothing to look at and the answer is
 * yes: Apache's own PHP and CGI pools are counted in tens, and the operator
 * of a small one has `slotWaiters`. Under php-fpm the answer is what
 * `$status` shows, and no status is no room. That is the package's own
 * pool: php-fpm ships with five children (Ubuntu's package:
 * `pm.max_children = 5`), one more than the default four workers, and with two requests allowed to
 * wait there the fifth child waited where it used to refuse. Measured on
 * such a pool at 40 requests a second, every PHP page of the site took
 * three seconds, where refusing at once left a page at a millisecond.
 *
 * `$status` is what fpm_get_status() answers: room when another process of
 * the pool is idle (this request's own counts as active) and nothing is
 * queued for a child. http.php hands it NO status, on purpose, so under
 * php-fpm nobody waits unless the operator wrote `slotWaiters`. The call
 * that would fill it could not be trusted where it was tried: php-fpm
 * 8.3.6, the binary of Ubuntu 24.04's package unpacked and run as a user
 * (no php.ini, not under systemd), static pools behind Apache. A page that
 * did nothing but call fpm_get_status() ended its child with SIGSEGV when
 * requests asked for it together, in some runs and not in others (never in
 * 200 one at a time; 9 times in 60 two at a time; once in 480 twelve at a
 * time), and so did this host's own requests when they called it. What
 * sets it off was not found. The reading of the answer is kept, and
 * tested, for the day the call can be trusted; until then it reads nothing. (On a unix socket `listen-queue`
 * stayed 0 with hundreds queued, so the idle count is what would decide.)
 */
function softn_pool_has_room(string $sapi, mixed $status): bool {
    if($sapi!=='fpm-fcgi')return true;
    return is_array($status)&&is_int($status['idle-processes']??null)&&$status['idle-processes']>=1&&($status['listen-queue']??null)===0;
}

/**
 * A place among the requests waiting for a slot, or null when `$room` of
 * them are waiting already. The place is an empty file in private/waiting/,
 * named by the second it was made; it is counted, never locked, so a
 * request that stands waiting holds nothing another could be kept out by.
 * softn_worker_slot removes it when the wait ends, either way. One whose
 * owner died (PHP was killed as it waited) is not counted once it is older
 * than any wait, and is cleared by whoever notices.
 *
 * Counted and then made, not the other way about: requests that arrive in
 * the same instant may each count the others out and all find room, so a
 * burst can stand a few over the number. That is the case the room is for.
 */
function softn_waiting_place(string $private, int $room): ?string {
    if($room<=0)return null;
    $dir=$private.'/waiting';$now=time();$waiting=0;
    foreach(@scandir($dir)?:[] as $name) {
        if($name==='.'||$name==='..')continue;
        if($now-(int)$name>30){@unlink($dir.'/'.$name);continue;}
        $waiting++;
    }
    if($waiting>=$room)return null;
    if(!is_dir($dir)&&!@mkdir($dir,0700)&&!is_dir($dir))return null;
    $place=$dir.'/'.$now.'-'.bin2hex(random_bytes(6));
    return @touch($place)?$place:null;
}

/**
 * A worker slot: the first of `private/slot-N.lock` nobody holds, locked,
 * or null when every one is held. `usable` says whether any of them could
 * be opened at all. When none can, nobody is holding them: this account may
 * not write in private/ (setup was run as another), and "the server is
 * busy, please retry" was the answer to that for ever.
 *
 * With every slot held, a request that finds a place among at most `$room`
 * waiting (softn_waiting_place) goes on trying for `$waitMs`, every few
 * milliseconds, the gap drawn at random so that they do not all try in the
 * same instant; one that finds no place is refused at once, as every
 * request was. No lock is held while it waits: each try opens the slot
 * files, asks without blocking and closes them again, so a request that
 * gives up, or dies, never stands in another's way. `waited` is how long it
 * took, in milliseconds, whichever way it ended.
 * @return array{slot:mixed,usable:bool,waited:float}
 */
function softn_worker_slot(string $private, int $workers, int $waitMs=0, int $room=0): array {
    $started=hrtime(true);$deadline=$started+max(0,$waitMs)*1_000_000;$place=null;
    // A host may disable usleep(); without it there is no waiting, as before.
    $patient=$waitMs>0&&$room>0&&function_exists('usleep');
    try {
        for(;;) {
            $usable=false;
            for($i=0;$i<$workers;$i++) {
                // 'e': not inherited by the runner, which would otherwise keep the slot
                // locked for as long as it lived, after this request had gone.
                $candidate=@fopen($private.'/slot-'.$i.'.lock','ce');
                if(!$candidate)continue;
                $usable=true;
                if(flock($candidate,LOCK_EX|LOCK_NB))return ['slot'=>$candidate,'usable'=>true,'waited'=>(hrtime(true)-$started)/1e6];
                fclose($candidate);
            }
            // Slots nobody could open will not come free; and the bound is the bound.
            $left=$deadline-hrtime(true);
            if(!$usable||!$patient||$left<=0)return ['slot'=>null,'usable'=>$usable,'waited'=>(hrtime(true)-$started)/1e6];
            // The first time round: a place to wait in, or no waiting.
            $place??=softn_waiting_place($private,$room);
            if($place===null)return ['slot'=>null,'usable'=>true,'waited'=>(hrtime(true)-$started)/1e6];
            // 5 to 15 ms, and never past the bound.
            usleep((int)min(mt_rand(5000,15000),intdiv($left,1000)+1));
        }
    } finally {
        if($place!==null)@unlink($place);
    }
}

/**
 * Where the runner notes that a rate bucket is over its limit for the
 * current minute (request-worker.mjs markLimited): one directory a minute,
 * one empty file a bucket, named by the SHA-256 the runner counts it under.
 */
function softn_rate_marker(string $backend, string $rateKey, int $now): string {
    return $backend.'/private/limited/'.intdiv($now,60).'/'.hash('sha256',$rateKey);
}

/** Seconds until the minute the limiter counts by turns: what Retry-After says. */
function softn_retry_after(int $now): int {
    return 60-$now%60;
}

/**
 * What the runner wrote on stderr, as lines for PHP's error log: at most
 * eight, each at most 400 characters, with no control characters. The runner
 * writes one line for a handler or a startup stage that failed
 * (wasm-host.mjs logFailure); Node itself may add its own when it dies.
 * @return list<string>
 */
function softn_log_lines(string $stderr): array {
    $lines=[];
    foreach(preg_split('/\R/',$stderr)?:[] as $line) {
        $line=trim((string)preg_replace('/[\x00-\x1F\x7F]+/',' ',$line));
        if($line==='')continue;
        $lines[]=substr($line,0,400);
        if(count($lines)===8)break;
    }
    return $lines;
}

/**
 * The body a route may carry: the smaller of the route's maxBodySize and the
 * app's config.server.maxBodySize, as the Rust host bounds a route by both.
 * Neither declared is 256 KB here (2 MB there: an on-demand process per
 * request is costlier); a declared value is honoured up to 2 MB, a photo
 * upload route's up to 5.6 MB. Null for a negative or non-numeric value.
 */
function softn_body_limit(mixed $route, mixed $global, bool $upload): ?int {
    $declared=[];
    foreach([$route,$global] as $value) {
        if($value===null)continue;
        if(is_string($value)&&preg_match('/^[0-9]{1,15}$/D',$value))$value=(int)$value; // as (int) read it before
        if(!is_int($value)&&!(is_float($value)&&floor($value)===$value))return null;
        if($value<0)return null;
        $declared[]=(int)$value;
    }
    $ceiling=$upload?5600100:2*1024*1024;
    return $declared===[]?($upload?5600100:262144):min($ceiling,...$declared);
}

/**
 * This site's own origin, the one a same-origin page sends. The scheme is
 * the connection's, or a trusted proxy's X-Forwarded-Proto. Null when Host
 * is not a plain host name or address.
 * @param array<string,mixed> $server
 */
function softn_own_origin(array $server, bool $peerIsTrustedProxy): ?string {
    $host=strtolower((string)($server['HTTP_HOST']??''));
    if(!preg_match('/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:.]{2,45}\])(?::[0-9]{1,5})?$/D',$host))return null;
    $https=(isset($server['HTTPS'])&&$server['HTTPS']!==''&&strtolower((string)$server['HTTPS'])!=='off')||strtolower((string)($server['REQUEST_SCHEME']??''))==='https';
    if($peerIsTrustedProxy&&isset($server['HTTP_X_FORWARDED_PROTO'])) {
        $proto=strtolower(trim(explode(',',(string)$server['HTTP_X_FORWARDED_PROTO'])[0]));
        if($proto==='https'||$proto==='http')$https=$proto==='https';
    }
    return ($https?'https':'http').'://'.$host;
}

/**
 * Whether a browser page from `$origin` may call this API: its own site
 * always, others only when listed in config.server.allowedOrigins. A request
 * with no Origin is not a cross-site browser request and is allowed.
 * @param mixed $allowed the manifest's list
 */
function softn_origin_allowed(?string $origin, mixed $allowed, ?string $ownOrigin): bool {
    if($origin===null)return true;
    if($ownOrigin!==null&&$origin===$ownOrigin)return true;
    return is_array($allowed)&&in_array($origin,$allowed,true);
}

/**
 * The runner's answer, `{"status":N,"body":...}` with status first and body
 * last, exactly as request-worker.mjs writes it. The body's JSON text is
 * passed to the client as the runner wrote it and never decoded and
 * re-encoded here: PHP would turn `{}` into `[]`, fail on a lone UTF-16
 * surrogate escape or an object key starting with NUL, and answer 503 for a
 * request whose writes had already committed.
 * @return array{status:int,body:string}|null
 */
function softn_runner_result(string $output): ?array {
    if(!preg_match('/\A\{"status":([2-5][0-9]{2}),"body":/',$output,$match)||!str_ends_with($output,'}'))return null;
    $body=substr($output,strlen($match[0]),-1);
    if($body==='')return null;
    return ['status'=>(int)$match[1],'body'=>$body];
}

/**
 * Whether If-None-Match names this entity tag: `*`, or any listed tag, weak
 * or strong (RFC 9110 uses the weak comparison here). Apache's mod_deflate
 * appends -gzip (or mod_brotli -br) inside the quotes of a tag it compressed,
 * and the client echoes that back; it is the same entity.
 */
function softn_etag_matches(string $ifNoneMatch, string $etag): bool {
    if(trim($ifNoneMatch)==='*')return true;
    foreach(explode(',',$ifNoneMatch) as $candidate) {
        $candidate=trim($candidate);
        if(str_starts_with($candidate,'W/'))$candidate=substr($candidate,2);
        $candidate=preg_replace('/-(?:gzip|br|zstd)"$/D','"',$candidate);
        if($candidate===$etag)return true;
    }
    return false;
}

/** The request headers a preflight may approve: the ones asked for, when they are header names. */
function softn_preflight_headers(?string $requested): string {
    $default='Content-Type, Authorization, Idempotency-Key, If-None-Match';
    if($requested===null||trim($requested)==='')return $default;
    return preg_match('/^[A-Za-z0-9!#$%&\'*+.^_`|~-]+(?:[ \t]*,[ \t]*[A-Za-z0-9!#$%&\'*+.^_`|~-]+){0,63}$/D',trim($requested))?trim($requested):$default;
}
