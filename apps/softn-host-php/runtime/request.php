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
