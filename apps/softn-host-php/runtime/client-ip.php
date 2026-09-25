<?php
declare(strict_types=1);
// Who a request is from, for the host's rate limit and for an app granted
// trusted-client-ip. By default the socket peer (REMOTE_ADDR): behind a CDN or
// a reverse proxy that is the proxy, and every visitor shares one bucket.
// `trustedProxies` in private/config.json opts in to X-Forwarded-For: a list
// of addresses and CIDR ranges (IPv4 and IPv6) allowed to speak for a client.
// The header is read only when the peer is one of them, and walked from the
// right past every listed hop to the first address that is not one, so a
// client cannot choose its identity: what it prepends sits left of the entry
// the edge appended. The same rule as the Rust host's --trusted-proxy=<peers>
// and the directory API's trustedProxies. Never trusts a header by default.

const SOFTN_MAX_FORWARDED_HOPS=16;

/** An address in canonical form (IPv4-mapped IPv6 folded to IPv4), or null. */
function softn_ip_normalize(string $ip): ?string {
    $ip=trim($ip);
    if(str_starts_with($ip,'[')&&str_ends_with($ip,']'))$ip=substr($ip,1,-1);
    $packed=$ip===''?false:@inet_pton($ip);
    if($packed===false)return null;
    if(strlen($packed)===16&&substr($packed,0,12)==="\0\0\0\0\0\0\0\0\0\0\xff\xff")$packed=substr($packed,12);
    $text=inet_ntop($packed);
    return is_string($text)?strtolower($text):null;
}

/** `1.2.3.4:5678` and `[2001:db8::1]:443` without their ports. */
function softn_ip_strip_port(string $entry): string {
    $entry=trim($entry);
    if(preg_match('/^(\[[0-9a-fA-F:.]+\]):\d{1,5}$/',$entry,$m))return $m[1];
    if(preg_match('/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/',$entry,$m))return $m[1];
    return $entry;
}

/** @param mixed $list @return array<int,array{0:string,1:int}> packed network and prefix; malformed entries skipped */
function softn_ip_ranges(mixed $list): array {
    $out=[];
    foreach(is_array($list)?$list:[] as $entry) {
        if(!is_string($entry))continue;
        $entry=trim($entry);$bits=null;
        if(str_contains($entry,'/')){[$entry,$suffix]=explode('/',$entry,2);if(!preg_match('/^\d{1,3}$/',$suffix))continue;$bits=(int)$suffix;}
        $ip=softn_ip_normalize($entry);if($ip===null)continue;
        $packed=inet_pton($ip);$width=strlen($packed)*8;$bits??=$width;
        if($bits<0||$bits>$width)continue;
        $out[]=[$packed,$bits];
    }
    return $out;
}

/** @param array<int,array{0:string,1:int}> $ranges */
function softn_ip_in_ranges(string $ip, array $ranges): bool {
    $packed=@inet_pton($ip);if($packed===false)return false;
    foreach($ranges as [$net,$bits]) {
        if(strlen($net)!==strlen($packed))continue;
        $bytes=intdiv($bits,8);$rest=$bits%8;
        if($bytes>0&&substr($packed,0,$bytes)!==substr($net,0,$bytes))continue;
        if($rest===0)return true;
        $mask=(0xff<<(8-$rest))&0xff;
        if((ord($packed[$bytes])&$mask)===(ord($net[$bytes])&$mask))return true;
    }
    return false;
}

/**
 * Whether the socket peer is one of the operator's trusted proxies, whose
 * X-Forwarded-Proto may then name the scheme the visitor used.
 */
function softn_peer_is_trusted_proxy(string $remoteAddr, mixed $trustedProxies): bool {
    $peer=softn_ip_normalize($remoteAddr);
    return $peer!==null&&softn_ip_in_ranges($peer,softn_ip_ranges($trustedProxies));
}

/**
 * The rate-limit bucket for an address: an IPv4 address is its own bucket;
 * an IPv6 address shares its /64, the block one subscriber is normally
 * given, so a client cannot take a fresh bucket per request by walking the
 * low 64 bits it controls.
 */
function softn_rate_key(string $ip): string {
    $packed=@inet_pton($ip);
    if($packed===false||strlen($packed)!==16)return $ip;
    return strtolower((string)inet_ntop(substr($packed,0,8).str_repeat("\0",8))).'/64';
}

/**
 * The client's address. A peer that is not a listed proxy is the client; a
 * listed one's X-Forwarded-For is walked from the right. A malformed entry, an
 * absent header or an overlong chain stops at the peer; a chain of nothing but
 * listed hops ends at its leftmost. A REMOTE_ADDR that is no address is 0.0.0.0.
 */
function softn_client_ip(string $remoteAddr, ?string $forwardedFor, mixed $trustedProxies): string {
    $peer=softn_ip_normalize($remoteAddr);
    if($peer===null)return '0.0.0.0';
    $ranges=softn_ip_ranges($trustedProxies);
    if($ranges===[]||!softn_ip_in_ranges($peer,$ranges))return $peer;
    if(!is_string($forwardedFor)||trim($forwardedFor)==='')return $peer;
    $hops=explode(',',$forwardedFor);$leftmost=null;$seen=0;
    for($i=count($hops)-1;$i>=0;$i--) {
        if(++$seen>SOFTN_MAX_FORWARDED_HOPS)return $peer;
        $ip=softn_ip_normalize(softn_ip_strip_port($hops[$i]));
        if($ip===null)return $peer;
        if(!softn_ip_in_ranges($ip,$ranges))return $ip;
        $leftmost=$ip;
    }
    return $leftmost??$peer;
}
