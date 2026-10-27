<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
/**
 * Setup cannot go on: one line saying what is wrong and what to do, and a
 * non-zero exit. An unwritable folder used to be a PHP warning and then a
 * TypeError from flock() with a stack of paths, a manifest that is not JSON
 * an uncaught JsonException: neither told the operator anything to act on.
 */
function softn_setup_stop(string $message): void {fwrite(STDERR,$message."\n");exit(1);}
/** A JSON file that must hold an object, as an array; setup stops when it does not. */
function softn_setup_json(string $file, string $name): array {
    $text=@file_get_contents($file);
    if(!is_string($text))softn_setup_stop("$name cannot be read by this account. Check its owner and permissions.");
    $value=json_decode($text,true);
    if(!is_array($value))softn_setup_stop("$name is not a JSON object".(json_last_error()===JSON_ERROR_NONE?'':' ('.json_last_error_msg().')').'. Install it again from the bundle it came from.');
    return $value;
}
// Before anything is read or made: the files beside this one are written for 8.1.
if(PHP_VERSION_ID<80100)softn_setup_stop('PHP '.PHP_VERSION.' is too old; the backend needs PHP 8.1 or newer. If the server has several, run setup with the one the web server uses.');
umask(0077);
$root=__DIR__;
// --migration-deadline=SECONDS: how long this run's check of the app may take
// to apply its migrations, where a request has the runner's 20 seconds. A
// migration that needs longer is stopped on every request and, after three
// stops, not started again (README-RUNTIME.md, Startup diagnostics); this is
// how it is applied. Only this run is given it: http.php starts the runner
// with an environment of its own.
$migrationDeadline=null;
foreach(array_slice($argv??[],1) as $arg) {
    if(!str_starts_with($arg,'--migration-deadline'))continue;
    if(!preg_match('/^--migration-deadline=([1-9][0-9]{0,4})$/',$arg,$m)||(int)$m[1]>86400)softn_setup_stop('--migration-deadline takes a whole number of seconds from 1 to 86400, for example --migration-deadline=600.');
    $migrationDeadline=(int)$m[1];
}
// The rules http.php applies; setup starts the runner exactly as a request does.
if(!is_file($root.'/request.php'))softn_setup_stop('request.php is missing beside setup.php. Upload the whole backend/ folder from the archive again.');
require_once $root.'/request.php';
// Who is running this: everything created below is readable by this account alone.
$account=function_exists('posix_geteuid')?posix_geteuid():null;
$accountName=$account===null?null:(function_exists('posix_getpwuid')&&is_array($who=posix_getpwuid($account))?$who['name']:'uid '.$account);
$unwritable=' is not writable by the account running setup'.($accountName===null?'':" ($accountName)").'. Run setup as the account the web server runs PHP as (for example: sudo -u www-data php '.$root.'/setup.php), and make the backend folder belong to that account (chown -R).';
if(is_link($root.'/private'))softn_setup_stop('private/ is a symbolic link. It must be a real directory inside the backend folder.');
if(!is_dir($root.'/private')&&!@mkdir($root.'/private',0700))softn_setup_stop('Cannot create private/: '.$root.$unwritable);
$lock=@fopen($root.'/private/setup.lock','c');
if(!$lock)softn_setup_stop('Cannot write in private/: '.$root.'/private'.$unwritable);
flock($lock,LOCK_EX);
try {
    $file=$root.'/private/config.json';
    if(!file_exists($file) && !is_file($root.'/app/manifest.json')) {
        // The archive before an app is installed in it. Reading the manifest
        // here died with a TypeError and a stack of paths; the message meant
        // for this case comes later and was never reached on a first run.
        fwrite(STDERR,"No application is installed at app/ yet: install the private bundle there, then run setup again.\n");
        exit(1);
    }
    if(!file_exists($file)) {
        $manifest=softn_setup_json($root.'/app/manifest.json','app/manifest.json');
        $defaults=is_file($root.'/operator/defaults.json')?softn_setup_json($root.'/operator/defaults.json','operator/defaults.json'):[];
        $id=$manifest['id']??'softn-app';
        // The runner compares it with the manifest's own: one that is no text can never match.
        if(!is_string($id)||$id==='')softn_setup_stop('app/manifest.json has no usable "id" (it must be text). Install the private bundle at app/ again.');
        $config=array_merge($defaults,['development'=>false,'keyHex'=>bin2hex(random_bytes(32)),
            'appId'=>$id,'capabilities'=>$manifest['server']['requires']['capabilities']??[],
            'cryptoDomains'=>$defaults['cryptoDomains']??['hmac'=>$id.':hmac:v1','seal'=>$id.':seal:v1'],
            // Proxies whose X-Forwarded-For names the client (see client-ip.php); none by default.
            'trustedProxies'=>$defaults['trustedProxies']??[]]);
        // Encoded before the file is made: a manifest json_encode cannot
        // write back (a number past the doubles, read as INF) left a
        // config.json of one newline, with "Setup complete", and every later
        // run kept it.
        try{$json=json_encode($config,JSON_PRETTY_PRINT|JSON_THROW_ON_ERROR)."\n";}
        catch(JsonException $e){softn_setup_stop('app/manifest.json holds a value private/config.json cannot be written from ('.$e->getMessage().'). Correct the manifest and install the bundle at app/ again.');}
        $handle=@fopen($file,'x');
        if(!$handle||fwrite($handle,$json)===false)softn_setup_stop('Cannot write private/config.json: '.$root.'/private'.$unwritable);
        fclose($handle);
    }
    if(is_link($file))softn_setup_stop('private/config.json is a symbolic link. It must be a real file.');
    // Its mode first: the owner of a file can always give itself the right to read it. Still unreadable, it is somebody else's.
    @chmod($file,0600);
    if(!is_readable($file))softn_setup_stop('private/config.json exists but this account cannot read it: an earlier setup was run as another account. Run setup as the account that owns private/, or hand the backend folder to this one (chown -R) and run it again.');
    if(is_link($root.'/private/data'))softn_setup_stop('private/data is a symbolic link. It must be a real directory.');
    if(!is_dir($root.'/private/data')&&!@mkdir($root.'/private/data',0700))softn_setup_stop('Cannot create private/data: '.$root.'/private'.$unwritable);
    @chmod($root.'/private',0700);@chmod($root.'/private/data',0700);
    // An upload over FTP leaves them without their executable bit.
    foreach(['node',SOFTN_RUNNER_BINARY] as $name)if(is_file($root.'/bin/'.$name))@chmod($root.'/bin/'.$name,0700);
    for($i=0;$i<4;$i++){ $f=@fopen($root.'/private/slot-'.$i.'.lock','c');if($f)fclose($f); }
    echo "Setup complete. Run PHP/Apache as this directory's owner. Review private/config.json for this application's operator settings.\n";
    if($migrationDeadline!==null)echo "Migrations may run for up to $migrationDeadline s in this run's check of the app, a migration stopped three times included. Requests made meanwhile wait for the database and may be told it is busy (503 database_busy).\n";
    $problems=softn_setup_checks($root,$migrationDeadline);
    foreach($problems as $problem)fwrite(STDERR,'WARNING: '.$problem."\n");
    // What these checks cannot see. Said, not failed on: neither is wrong on every host.
    if($account===0)fwrite(STDERR,"NOTE: setup ran as root, so private/ and the database belong to root and the web server's PHP cannot read them (requests will answer 503 private_permissions). Hand the backend folder to the web server's PHP account (chown -R) or run setup as it.\n");
    echo "These checks ran with the command-line PHP".($accountName===null?'':" as $accountName").". The web server's PHP is configured separately (its own disable_functions and extensions) and may run as another account: request /api/meta through the site to check that one.\n";
    // And what nothing here can see at all: how many PHP workers the web
    // server has. Requests that run and requests that wait for a slot each
    // hold one (request.php softn_slot_waiters), and a pool no larger than
    // the two together is one an overload of the API takes whole. Under
    // php-fpm, whose own pool is that small, no request waits unless the
    // operator wrote a number (softn_pool_has_room); under anything else,
    // and wherever they did write one, the pool is theirs to have sized.
    $installed=json_decode((string)@file_get_contents($root.'/app/manifest.json'),true);
    $settings=json_decode((string)@file_get_contents($file),true);
    if(is_array($installed)) {
        $workers=softn_workers($installed,$settings);
        $written=is_array($settings)?($settings['slotWaiters']??null):null;
        $waiters=softn_slot_waiters($written,$workers);
        $pools="php-fpm's pm.max_children, Apache's MaxRequestWorkers, a shared host's process limit";
        if($waiters===0)echo "Up to $workers requests run at once, each holding one of the web server's PHP workers; none waits for a slot (\"slotWaiters\": 0 in private/config.json), so a request past them is told at once that the server is busy.\n";
        elseif(softn_slot_waiters_set($written))echo "Up to $workers requests run at once and $waiters more may wait for one of them (\"slotWaiters\" in private/config.json), each holding one of the web server's PHP workers. That number is taken at its word, under php-fpm too: the pool ($pools) must be larger than ".($workers+$waiters).".\n";
        else echo "Up to $workers requests run at once, each holding one of the web server's PHP workers, and a request past them may wait for one, or not, by where PHP runs. Under php-fpm none waits (a request past the $workers is told at once that the server is busy) until \"slotWaiters\" in private/config.json says how many may: a php-fpm pool is small as it comes (Ubuntu's package ships pm.max_children = 5), which leaves none to wait with, so write a number only for a pm.max_children larger than $workers plus that number. Under any other PHP (Apache's own, CGI, FastCGI) $waiters may wait: there the pool (Apache's MaxRequestWorkers, a shared host's process limit) must be larger than ".($workers+$waiters).", and if it is not, set \"slotWaiters\": 0.\n";
    }
    if($problems)exit(1);
} finally {flock($lock,LOCK_UN);fclose($lock);}



/**
 * What the first request would find out the hard way, found now: PHP's
 * version and process functions, and whether the runner a request starts
 * (request.php softn_runner_choice: softn-runner where the backend carries
 * it, else the bundled Node) starts on this machine (neither runs on ARM or
 * from a noexec mount, and Node needs glibc) and, with an application
 * installed, answers /api/meta. Each problem is one line; the empty list
 * means the backend is ready. `$migrationDeadline` (seconds) is how long the
 * app's check may take to apply its migrations.
 * @return list<string>
 */
function softn_setup_checks(string $root, ?int $migrationDeadline=null): array {
    $problems=[];
    if(PHP_VERSION_ID<80100)$problems[]='PHP '.PHP_VERSION.' is too old; the backend needs PHP 8.1 or newer.';
    foreach(['proc_open','proc_get_status','proc_terminate','proc_close'] as $name)
        if(!function_exists($name))$problems[]="PHP function $name is disabled; the web server's PHP must allow it (check disable_functions).";
    if($problems)return $problems;
    // PHP's own, so looked at before Node is: a photo route answers 503
    // without GD, and nothing else says so until someone uploads.
    $manifest=json_decode((string)@file_get_contents($root.'/app/manifest.json'),true);
    $declared=is_array($manifest)?($manifest['server']['requires']['capabilities']??[]):[];
    if(is_array($declared)&&in_array('photos',$declared,true)&&!extension_loaded('gd'))
        $problems[]='The application takes photo uploads and this PHP has no GD extension: its upload routes answer 503 until GD is installed for the web server\'s PHP (Debian/Ubuntu: the php-gd package).';
    // The operator's settings: which runner, and how much memory a request on softn-runner may take.
    $settings=json_decode((string)@file_get_contents($root.'/private/config.json'),true);
    if(is_array($settings)&&array_key_exists('requestMemoryMb',$settings)&&softn_request_memory_mb($settings)!==$settings['requestMemoryMb'])
        $problems[]='"requestMemoryMb" in private/config.json must be a whole number of MiB from 128 to 1024; requests on softn-runner take '.SOFTN_REQUEST_MEMORY_MB.' until it is.';
    // What the runner says on stderr is kept (in a temporary file, so that it
    // can never fill a pipe nobody is reading): it is the reason, where the
    // answer on stdout is only a label. It used to go to /dev/null.
    $run=function(array $command,string $input='',array $env=[]) use($root,$settings):?array {
        $errors=tmpfile();
        $process=@proc_open($command,[0=>['pipe','r'],1=>['pipe','w'],2=>$errors?:['pipe','w']],$pipes,$root,softn_runner_environment($root,$settings)+$env);
        if(!is_resource($process))return null;
        fwrite($pipes[0],$input);fclose($pipes[0]);
        $out=stream_get_contents($pipes[1]);fclose($pipes[1]);
        // rewind(), not an offset to stream_get_contents(): PHP thinks it is
        // still at 0, where the child has moved the file's one position on.
        if($errors){rewind($errors);$said=(string)stream_get_contents($errors,65536);fclose($errors);}
        else $said=(string)stream_get_contents($pipes[2],65536);
        return ['code'=>proc_close($process),'out'=>(string)$out,'said'=>softn_log_lines($said)];
    };
    // The runner every request will start: softn-runner, where the backend
    // carries it, needs no Node, and Node is looked at only when it is the one.
    $runner=softn_runner_choice($root,$settings);
    if($runner['runner']==='softn-runner') {
        // It reads a request on stdin and has no --version: whether it runs is the check of /api/meta below.
        if(!is_executable($runner['binary']))return array_merge($problems,['bin/'.SOFTN_RUNNER_BINARY.' cannot be made executable by this account. Upload the whole backend/ folder again, as binary files, to a filesystem that allows executing files.']);
    } else {
        // Not there is another thing to mend than there and not running; it was a chmod() warning and then "does not run".
        if(!is_file($root.'/bin/node'))return array_merge($problems,['bin/node is missing from the backend folder. Upload the whole backend/ folder again, as binary files (an FTP client in text mode damages it).']);
        $version=$run([$root.'/bin/node','--version']);
        if($version===null||$version['code']!==0||!preg_match('/^v(\d+)\.(\d+)\.(\d+)/',$version['out'],$v))
            return array_merge($problems,['The bundled Node (bin/node) does not run on this machine. It needs Linux x86-64 with glibc 2.28+, and a filesystem that allows executing files.']);
        $protocol=json_decode((string)@file_get_contents($root.'/host-protocol.json'),true);
        $minimum=is_array($protocol)&&is_string($protocol['minimumNode']??null)?$protocol['minimumNode']:'0.0.0';
        if(version_compare($v[1].'.'.$v[2].'.'.$v[3],$minimum,'<'))$problems[]="The bundled Node is $v[0]; this runtime needs $minimum or newer.";
    }
    if(!is_file($root.'/app/manifest.json')) {
        echo "No application is installed at app/ yet: install the private bundle there, then run setup again to check it.\n";
        return $problems;
    }
    // Started as a request starts it (request.php softn_runner_choice): a
    // Node that refuses one of its flags, or a softn-runner this machine
    // cannot run, fails here, not on every request.
    $meta=$run($runner['command'],json_encode(['path'=>'/api/meta','method'=>'GET','query'=>new stdClass(),'headers'=>new stdClass(),'body'=>new stdClass(),'client_ip'=>'0.0.0.0','photos'=>extension_loaded('gd')]),
        // runner.mjs and request-worker.mjs read it (migrations.mjs setupDeadlineMs).
        $migrationDeadline===null?[]:['SOFTN_SETUP_DEADLINE_MS'=>(string)($migrationDeadline*1000)]);
    $answer=$meta===null?null:json_decode($meta['out'],true);
    // The runner's own line names the stage and gives the reason (wasm-host.mjs logFailure); Node's own says why it would not start.
    $said=$meta===null||$meta['said']===[]?'':' It said: '.implode(' | ',$meta['said']);
    // A runner its deadline ended while a migration ran says which one
    // (runner.mjs); "check bin/node" sent the operator the wrong way.
    if(!is_array($answer))$problems[]=(str_contains($said,' was stopped at the ')
        ?'A database migration did not finish before the runner\'s deadline and was rolled back; after three such stops it is not started again. Run setup with --migration-deadline=SECONDS to give it longer (see README-RUNTIME.md, Startup diagnostics, migration_stopped).'
        :($runner['runner']==='softn-runner'
            ?'The backend runner (bin/'.SOFTN_RUNNER_BINARY.') did not answer. It needs Linux x86-64 and a filesystem that allows executing files; if this is one, upload the backend/ folder again, as binary files.'
            :'The backend runner did not answer. Check that bin/node and runner.mjs are intact.')).$said;
    elseif(($answer['status']??0)!==200) {
        $diagnostic=$answer['body']['diagnostic']??$answer['body']['code']??'unknown';
        $problems[]='The application does not start: '.$diagnostic.' (see README-RUNTIME.md, Startup diagnostics).'
            .($diagnostic==='migration_stopped'?' Run setup again with --migration-deadline=SECONDS, long enough for the migration, to apply it.':'').$said;
    }
    else echo 'Application '.($answer['body']['appId']??'?').' '.($answer['body']['version']??'').' answers /api/meta.'.(isset($answer['body']['unservedRoutes'])?' Routes this host does not serve: '.count($answer['body']['unservedRoutes']).'.':'')."\n";
    // Which runner that was, and, where softn-runner is there and Node was chosen all the same, why.
    $hooks=is_array($settings)&&(($settings['enableRequestHook']??null)===true||($settings['enableAfterRequestHook']??null)===true);
    if($runner['runner']==='softn-runner') {
        $mb=softn_request_memory_mb($settings);
        echo "Requests run on softn-runner (bin/".SOFTN_RUNNER_BINARY."), without Node. To run them on Node instead, set \"runner\": \"node\" in private/config.json.\n";
        echo "Each request may take up to $mb MiB for the app's engine (a script's heap ".min($mb-64,512)." MiB of it) and $mb MiB for SQLite: \"requestMemoryMb\" in private/config.json, 128 to 1024.\n";
        // What the kernel lets it lock itself down to here, proved by trying (main.rs --check-lockdown).
        $check=$run([$runner['binary'],'--check-lockdown']);
        foreach(softn_lockdown_report($check===null?null:json_decode($check['out'],true)) as $line)echo $line."\n";
    }
    elseif(is_file($root.'/bin/'.SOFTN_RUNNER_BINARY))echo 'Requests run on Node (bin/node and runner.mjs), not on softn-runner: '.($hooks?'a request hook is enabled in private/config.json, and only Node runs one.':(is_array($settings)&&($settings['runner']??null)==='node'?'"runner" is "node" in private/config.json.':'this server is not Linux x86-64, which softn-runner is built for.'))."\n";
    return $problems;
}
