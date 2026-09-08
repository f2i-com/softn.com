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
            'cryptoDomains'=>$defaults['cryptoDomains']??['hmac'=>$id.':hmac:v1','seal'=>$id.':seal:v1']]);
        $handle=fopen($file,'x');fwrite($handle,json_encode($config,JSON_PRETTY_PRINT)."\n");fclose($handle);
    }
    if(is_link($file))throw new RuntimeException('Configuration cannot be a link');
    chmod($file,0600);
    if(!is_dir($root.'/private/data'))mkdir($root.'/private/data',0700);
    if(is_link($root.'/private/data'))throw new RuntimeException('Data cannot be a link');
    chmod($root.'/private',0700);chmod($root.'/private/data',0700);chmod($root.'/bin/node',0700);
    for($i=0;$i<4;$i++){ $f=fopen($root.'/private/slot-'.$i.'.lock','c');fclose($f); }
    echo "Setup complete. Run PHP/Apache as this directory's owner. Review private/config.json for this application's operator settings.\n";
} finally {flock($lock,LOCK_UN);fclose($lock);}
