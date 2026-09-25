<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
umask(0077);
$root=__DIR__;
if(!is_dir($root.'/private'))mkdir($root.'/private',0700);
if(is_link($root.'/private'))throw new RuntimeException('Private directory cannot be a link');
$lock=fopen($root.'/private/setup.lock','c');flock($lock,LOCK_EX);
try {
    $file=$root.'/private/config.json';
    if(!file_exists($file)) {
        $manifest=json_decode(file_get_contents($root.'/app/manifest.json'),true,32,JSON_THROW_ON_ERROR);
        $defaults=is_file($root.'/operator/defaults.json')?json_decode(file_get_contents($root.'/operator/defaults.json'),true,32,JSON_THROW_ON_ERROR):[];
        $id=$manifest['id']??'softn-app';
        $config=array_merge($defaults,['development'=>false,'keyHex'=>bin2hex(random_bytes(32)),
            'appId'=>$id,'capabilities'=>$manifest['server']['requires']['capabilities']??[],
            'cryptoDomains'=>$defaults['cryptoDomains']??['hmac'=>$id.':hmac:v1','seal'=>$id.':seal:v1'],
            // Proxies whose X-Forwarded-For names the client (see client-ip.php); none by default.
            'trustedProxies'=>$defaults['trustedProxies']??[]]);
        $handle=fopen($file,'x');fwrite($handle,json_encode($config,JSON_PRETTY_PRINT)."\n");fclose($handle);
    }
    if(is_link($file))throw new RuntimeException('Configuration cannot be a link');
    chmod($file,0600);
    if(!is_dir($root.'/private/data'))mkdir($root.'/private/data',0700);
    if(is_link($root.'/private/data'))throw new RuntimeException('Data cannot be a link');
    chmod($root.'/private',0700);chmod($root.'/private/data',0700);chmod($root.'/bin/node',0700);
    for($i=0;$i<4;$i++){ $f=fopen($root.'/private/slot-'.$i.'.lock','c');fclose($f); }
    echo "Setup complete. Run PHP/Apache as this directory's owner. Review private/config.json for this application's operator settings.\n";
    $problems=softn_setup_checks($root);
    foreach($problems as $problem)fwrite(STDERR,'WARNING: '.$problem."\n");
    if($problems)exit(1);
} finally {flock($lock,LOCK_UN);fclose($lock);}

/**
 * What the first request would find out the hard way, found now: PHP's
 * version and process functions, and whether the bundled Node starts on this
 * machine (a Linux x86-64 binary does not run on ARM, musl or a noexec mount)
 * and, with an application installed, answers /api/meta. Each problem is one
 * line; the empty list means the backend is ready.
 * @return list<string>
 */
function softn_setup_checks(string $root): array {
    $problems=[];
    if(PHP_VERSION_ID<80100)$problems[]='PHP '.PHP_VERSION.' is too old; the backend needs PHP 8.1 or newer.';
    foreach(['proc_open','proc_get_status','proc_terminate'] as $name)
        if(!function_exists($name))$problems[]="PHP function $name is disabled; the web server's PHP must allow it (check disable_functions).";
    if($problems)return $problems;
    $run=function(array $args,string $input='') use($root):?array {
        $process=@proc_open(array_merge([$root.'/bin/node'],$args),[0=>['pipe','r'],1=>['pipe','w'],2=>['file','/dev/null','w']],$pipes,$root,['PATH'=>'/usr/bin:/bin','TZ'=>'UTC','NODE_NO_WARNINGS'=>'1']);
        if(!is_resource($process))return null;
        fwrite($pipes[0],$input);fclose($pipes[0]);
        $out=stream_get_contents($pipes[1]);fclose($pipes[1]);
        return ['code'=>proc_close($process),'out'=>(string)$out];
    };
    $version=$run(['--version']);
    if($version===null||$version['code']!==0||!preg_match('/^v(\d+)\.(\d+)\.(\d+)/',$version['out'],$v))
        return ['The bundled Node (bin/node) does not run on this machine. It needs Linux x86-64 with glibc 2.28+, and a filesystem that allows executing files.'];
    $protocol=json_decode((string)@file_get_contents($root.'/host-protocol.json'),true);
    $minimum=is_array($protocol)&&is_string($protocol['minimumNode']??null)?$protocol['minimumNode']:'0.0.0';
    if(version_compare($v[1].'.'.$v[2].'.'.$v[3],$minimum,'<'))$problems[]="The bundled Node is $v[0]; this runtime needs $minimum or newer.";
    if(!is_file($root.'/app/manifest.json')) {
        echo "No application is installed at app/ yet: install the private bundle there, then run setup again to check it.\n";
        return $problems;
    }
    $meta=$run(['--max-old-space-size=128','--disable-proto=throw',$root.'/runner.mjs'],json_encode(['path'=>'/api/meta','method'=>'GET','query'=>new stdClass(),'headers'=>new stdClass(),'body'=>new stdClass(),'client_ip'=>'0.0.0.0','photos'=>extension_loaded('gd')]));
    $answer=$meta===null?null:json_decode($meta['out'],true);
    if(!is_array($answer))$problems[]='The backend runner did not answer. Check that bin/node and runner.mjs are intact.';
    elseif(($answer['status']??0)!==200)$problems[]='The application does not start: '.($answer['body']['diagnostic']??$answer['body']['code']??'unknown').' (see README-RUNTIME.md, Startup diagnostics).';
    else echo 'Application '.($answer['body']['appId']??'?').' '.($answer['body']['version']??'').' answers /api/meta.'.(isset($answer['body']['unservedRoutes'])?' Routes this host does not serve: '.count($answer['body']['unservedRoutes']).'.':'')."\n";
    return $problems;
}
