<?php
declare(strict_types=1);

/** Folder catalogue. JSON is authoritative; the bundle cache can be deleted. */
final class Catalog
{
    private static $lock = null;
    private static bool $ready = false;
    private static array $docs = [];
    private static array $cache = [];
    private static bool $cacheDirty = false;
    /** slug => why the folder was skipped this boot; its files are untouched. */
    private static array $skipped = [];

    public static function validSlug(string $slug): bool { return (bool) preg_match('/^[a-z0-9][a-z0-9-]{0,63}$/D', $slug); }
    public static function path(string $slug): string {
        if (!self::validSlug($slug)) throw new ApiError(400, 'Invalid app folder name.');
        $path = Config::dataDir() . '/apps/' . $slug;
        if (is_link($path)) throw new ApiError(400, 'App folders must not be symlinks.');
        return $path;
    }
    /** A stable lock inode, outside app directories, protects read-modify-write.
     * Held until response generation ends; never delete or replace this file. */
    public static function boot(): void {
        if (self::$ready) return;
        $root = Config::dataDir();
        self::$lock = fopen("$root/catalog.lock", 'c');
        if (!self::$lock || !flock(self::$lock, LOCK_EX)) throw new ApiError(503, 'The directory is busy.');
        self::$ready = true;
        register_shutdown_function([self::class, 'release']);
        try {
            if (!is_dir("$root/apps") && !mkdir("$root/apps", 0775, true)) throw new ApiError(503, 'Cannot create apps folder.');
            try { self::migrateLegacy(); }
            catch (Throwable $e) { error_log('softn-api: legacy import did not complete and will retry on the next request: ' . $e->getMessage()); }
            self::$cache = self::readJson("$root/cache/bundles.json", true);
            foreach (scandir("$root/apps") ?: [] as $slug) {
                if (!self::validSlug($slug) || is_link("$root/apps/$slug") || !is_dir("$root/apps/$slug")) continue;
                // One folder's trouble is that folder's alone: a malformed or
                // invalid app.json, an unreadable bundle or an unwritable
                // directory skips the app, logs why, leaves its files exactly
                // as they are, and the rest of the directory is served. The
                // folder still occupies its slug, so nothing publishes over it.
                try { self::load($slug); }
                catch (Throwable $e) {
                    unset(self::$docs[$slug]);
                    self::$skipped[$slug] = $e->getMessage();
                    error_log("softn-api: skipping app folder $slug: " . $e->getMessage());
                }
            }
            foreach(array_keys(self::$cache) as $key)if(!is_file("$root/apps/$key")){unset(self::$cache[$key]);self::$cacheDirty=true;}
            if (self::$cacheDirty) {try {self::writeJson("$root/cache/bundles.json", self::$cache);}catch(Throwable $e){error_log('softn-api: bundle cache could not be written');}}
        } catch (Throwable $e) {
            self::release();
            throw $e;
        }
    }
    private static function load(string $slug): void {
        $path = self::path($slug) . '/app.json';
        $doc = is_file($path) ? self::readJson($path) : null;
        if ($doc !== null) {
            if (($doc['schemaVersion'] ?? 1) !== 1 || !is_array($doc['app'] ?? null) || ($doc['app']['slug'] ?? $slug) !== $slug)
                throw new ApiError(503, "Invalid app.json in $slug; the app is not listed until it is repaired.");
            $doc['schemaVersion']=1;
            $doc['app']=array_replace(self::defaults($slug),$doc['app']);
            foreach(['versions','comments','ratings','runsDaily'] as $field)if(!array_key_exists($field,$doc))$doc[$field]=[];
            foreach(['thumb','icon'] as $field)if($doc['app'][$field]!==null && (!is_string($doc['app'][$field]) || basename($doc['app'][$field])!==$doc['app'][$field] || str_contains($doc['app'][$field],'\\')))throw new ApiError(503,"Invalid image filename in $slug/app.json.");
            foreach (['tags','capabilities','storage_policies'] as $field) if (is_array($doc['app'][$field] ?? null)) $doc['app'][$field] = json_encode($field==='storage_policies'?(object)$doc['app'][$field]:$doc['app'][$field]);
            foreach (['versions','comments','ratings','runsDaily'] as $field) if (!is_array($doc[$field] ?? null)) throw new ApiError(503, "Invalid $field in $slug/app.json.");
            self::validate($slug,$doc);
            self::$docs[$slug] = $doc;
        }
        self::discover($slug);
    }
    /** Folders skipped by this boot, slug => reason. Empty when every folder loaded. */
    public static function skipped(): array { self::boot(); return self::$skipped; }
    private static function validate(string $slug, array $doc): void {
        $fail=static function() use($slug): never {throw new ApiError(503,"Invalid metadata fields in $slug/app.json. The file has been preserved.");};
        $app=$doc['app'];
        foreach(['name','description','author','category','execution','source'] as $field)if(!is_string($app[$field]))$fail();
        foreach(['parent_slug','root_slug','edit_key_hash','primary_color'] as $field)if($app[$field]!==null&&!is_string($app[$field]))$fail();
        foreach(['runs','launches','remixes','rating_sum','rating_count','comments','size','created_at','updated_at','latest_version'] as $field)if(!is_int($app[$field])||$app[$field]<0)$fail();
        if(!in_array($app['hidden'],[0,1,false,true],true))$fail();
        foreach(['tags','capabilities','storage_policies'] as $field)if(!is_string($app[$field])||!is_array(json_decode($app[$field],true)))$fail();
        foreach(['versions','comments','ratings','runsDaily'] as $field)if(!array_is_list($doc[$field]))$fail();
        foreach($doc['versions'] as $v)if(!is_array($v)||!is_int($v['version']??null)||$v['version']<1||!is_string($v['file']??null)||basename($v['file'])!==$v['file']||str_contains($v['file'],'\\'))$fail();
        foreach($doc['comments'] as $c)if(!is_array($c)||!is_int($c['id']??null)||!is_string($c['name']??null)||!is_string($c['body']??null)||!is_string($c['visitor']??null)||!isset($c['created_at'],$c['hidden']))$fail();
        foreach($doc['ratings'] as $r)if(!is_array($r)||!is_string($r['visitor']??null)||!in_array($r['stars']??null,[1,2,3,4,5],true))$fail();
        foreach($doc['runsDaily'] as $r)if(!is_array($r)||!is_int($r['day']??null)||!is_int($r['count']??null)||$r['count']<0)$fail();
    }
    public static function release(): void {
        if (is_resource(self::$lock)) { flock(self::$lock, LOCK_UN); fclose(self::$lock); }
        self::$lock = null; self::$ready=false; self::$docs=[]; self::$cache=[]; self::$cacheDirty=false; self::$skipped=[];
    }
    public static function readJson(string $path, bool $cache = false): array {
        if (is_link($path)) throw new ApiError(503, 'JSON metadata must not be a symlink.');
        if (!is_file($path)) return [];
        try {
            $value = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
            if (!is_array($value)) throw new RuntimeException('Expected a JSON object.');
            return $value;
        } catch (Throwable $e) {
            if ($cache) return [];
            throw new ApiError(503, 'Invalid JSON metadata: ' . basename($path) . '. The file has been preserved.');
        }
    }
    /** Write a complete sibling, flush it, then atomically replace the old file. */
    public static function writeJson(string $path, array $value): void {
        if (is_link($path)) throw new ApiError(503, 'JSON metadata must not be a symlink.');
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0775, true)) throw new ApiError(503, 'Cannot create metadata folder.');
        $bytes = json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . "\n";
        $tmp = tempnam($dir, '.json-');
        if ($tmp === false) throw new ApiError(503, 'Cannot stage metadata.');
        try {
            $f = fopen($tmp, 'wb');
            if (!$f) throw new ApiError(503, 'Cannot write metadata.');
            try {
                $offset = 0;
                while ($offset < strlen($bytes)) { $n = fwrite($f, substr($bytes, $offset)); if (!$n) throw new ApiError(503, 'Incomplete metadata write.'); $offset += $n; }
                if (!fflush($f)) throw new ApiError(503, 'Cannot flush metadata.');
                if (function_exists('fsync') && !fsync($f)) throw new ApiError(503, 'Cannot sync metadata.');
            } finally { fclose($f); }
            if (!rename($tmp, $path)) throw new ApiError(503, 'Cannot replace metadata.');
        } finally { if (is_file($tmp)) @unlink($tmp); }
    }
    public static function all(): array {
        self::boot(); $out = [];
        foreach (self::$docs as $slug => $doc) {
            if (!$doc['versions']) continue;
            $row = $doc['app'];
            $row['remixes'] = count(array_filter(self::$docs, fn($d) => ($d['app']['parent_slug'] ?? null) === $slug));
            $out[$slug] = $row;
        }
        return $out;
    }
    public static function doc(string $slug): array {
        self::boot();
        if (!isset(self::$docs[$slug])) throw new ApiError(404, 'No app is published under that name.');
        return self::$docs[$slug];
    }
    public static function put(string $slug, array $doc): void {
        self::boot();
        $doc['schemaVersion'] = 1;
        $disk = $doc;
        foreach (['tags','capabilities','storage_policies'] as $field) if (is_string($disk['app'][$field] ?? null)) $disk['app'][$field] = $field==='storage_policies'?(object)(json_decode($disk['app'][$field],true)?:[]):(json_decode($disk['app'][$field],true)?:[]);
        self::writeJson(self::path($slug) . '/app.json', $disk);
        self::$docs[$slug] = $doc;
    }
    public static function patch(string $slug, array $fields): void { $d = self::doc($slug); $d['app'] = array_replace($d['app'], $fields); self::put($slug, $d); }
    public static function remove(string $slug): void {
        self::doc($slug);
        self::retire($slug);
        unset(self::$docs[$slug]);
    }
    /** Atomically retire the entire directory, listed or not; recovery never rediscovers it. */
    public static function retire(string $slug): void {
        $from = self::path($slug); $trash = Config::dataDir() . '/.retired-' . $slug . '-' . bin2hex(random_bytes(6));
        if (!rename($from, $trash)) throw new ApiError(503, 'Cannot retire app folder.');
        foreach (scandir($trash) ?: [] as $name) if ($name !== '.' && $name !== '..' && !is_dir("$trash/$name")) @unlink("$trash/$name");
        @rmdir($trash);
    }
    public static function categories(): array { self::boot(); return self::readJson(Config::dataDir() . '/categories.json'); }
    public static function saveCategories(array $rows): void { self::boot(); self::writeJson(Config::dataDir() . '/categories.json', $rows); }
    public static function defaults(string $slug): array {
        return ['slug'=>$slug,'name'=>$slug,'description'=>'','author'=>'Anonymous','category'=>'other','tags'=>'[]','parent_slug'=>null,'root_slug'=>null,'latest_version'=>1,'capabilities'=>'[]','execution'=>'main','storage_policies'=>'{}','thumb'=>null,'icon'=>null,'primary_color'=>null,'edit_key_hash'=>null,'source'=>'folder','runs'=>0,'launches'=>0,'remixes'=>0,'rating_sum'=>0,'rating_count'=>0,'comments'=>0,'size'=>0,'hidden'=>0,'created_at'=>time(),'updated_at'=>time()];
    }
    private static function discover(string $slug): void {
        $dir = self::path($slug); $old = self::$docs[$slug] ?? null;
        $doc = $old ?? ['schemaVersion'=>1,'app'=>self::defaults($slug),'versions'=>[],'comments'=>[],'ratings'=>[],'runsDaily'=>[]];
        $versions = []; $infos=[]; $used = []; $files = glob("$dir/*.softn") ?: []; natsort($files);
        foreach ($doc['versions'] as $v) $used[basename($v['file'])] = (int)$v['version'];
        foreach ($files as $path) {
            if (is_link($path)) continue;
            $file = basename($path);
            if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.softn$/D', $file)) continue;
            $key = "$slug/$file"; $stat = @stat($path);
            if ($stat === false) { error_log("softn-api: unreadable bundle $slug/$file"); continue; }
            $fingerprint = [$stat['size'],$stat['mtime'],$stat['ctime']];
            $cached = self::$cache[$key] ?? null;
            // The icon is only needed the first time a folder is met, so it is only cached then; an entry without one is re-read if the need arises.
            if(!is_array($cached) || !is_array($cached['info']??null) || array_diff(['author','name','version','description','capabilities','storagePolicies','execution','size','sha256'],array_keys($cached['info'])) || (!$old && !array_key_exists('icon',$cached['info'])))$cached=null;
            if (!$cached || ($cached['stat'] ?? []) !== $fingerprint || time() - ($cached['checked'] ?? 0) >= 5) {
                // Any failure to read one bundle skips that bundle, not the
                // app and not the directory: a truncated upload, a zip the
                // extension refuses, a manifest that is not JSON.
                try { $full = Bundle::inspect($path); }
                catch (Throwable $e) { error_log("softn-api: invalid bundle in $slug/$file: " . $e->getMessage()); if (isset(self::$cache[$key])) { unset(self::$cache[$key]); self::$cacheDirty = true; } continue; }
                // Only what this function reads is cached. The whole manifest
                // (and every icon) went in once, and cache/bundles.json is
                // read back on every request, for every bundle.
                $author = $full['manifest']['author'] ?? null;
                if (is_array($author)) $author = $author['name'] ?? null;
                $info = ['author'=>is_string($author) ? (Text::clean($author, 40) ?: 'Anonymous') : 'Anonymous'];
                foreach (['name','version','description','capabilities','storagePolicies','execution','size','sha256'] as $field) $info[$field] = $full[$field];
                if (!$old) $info['icon'] = $full['icon'] ? [base64_encode($full['icon'][0]), $full['icon'][1]] : null;
                unset($full);
                self::$cache[$key] = ['stat'=>$fingerprint,'checked'=>time(),'info'=>$info]; self::$cacheDirty = true;
            } else $info = $cached['info'];
            if (!isset($info)) $info = self::$cache[$key]['info'];
            $number = $used[$file] ?? (preg_match('/^v([1-9][0-9]*)\.softn$/D',$file,$m) ? (int)$m[1] : max([0,...array_values($used)])+1);
            if (isset($versions[$number])) { error_log("softn-api: $slug/$file would be version $number, already taken by {$versions[$number]['file']}; skipped"); continue; }
            $used[$file]=$number;$infos[$number]=$info;
            $previous = null; foreach ($doc['versions'] as $v) if ($v['file']===$file) $previous=$v;
            $versions[$number] = ['slug'=>$slug,'version'=>$number,'file'=>$file,'size'=>$info['size'],'sha256'=>$info['sha256'],'manifest_version'=>$info['version'],'notes'=>$previous['notes']??'','created_at'=>$previous['created_at']??$stat['mtime']];
            if (!$old || $number >= (int)$doc['app']['latest_version']) {
                if (!$old) { $doc['app']['name']=$info['name']; $doc['app']['description']=$info['description']; $doc['app']['author']=$info['author']; }
                $doc['app']['latest_version']=$number; $doc['app']['size']=$info['size'];
                $doc['app']['capabilities']=json_encode($info['capabilities']); $doc['app']['execution']=$info['execution']; $doc['app']['storage_policies']=json_encode((object)$info['storagePolicies']);
                if (!$old && !empty($info['icon'])) { $icon='icon.'.Images::extension($info['icon'][1]); if (@file_put_contents("$dir/$icon",base64_decode($info['icon'][0]),LOCK_EX) !== false) $doc['app']['icon']=$icon; else error_log("softn-api: icon for $slug could not be written"); }
            }
            unset($info);
        }
        krsort($versions); $doc['versions']=array_values($versions);
        if (!$versions) { unset(self::$docs[$slug]); return; }
        $latest=$doc['versions'][0];$info=$infos[$latest['version']];
        $doc['app']['latest_version']=$latest['version'];$doc['app']['size']=$info['size'];
        $doc['app']['capabilities']=json_encode($info['capabilities']);$doc['app']['execution']=$info['execution'];$doc['app']['storage_policies']=json_encode((object)$info['storagePolicies']);
        if($old && $old['versions']!==$doc['versions'])$doc['app']['updated_at']=time();
        if ($old !== $doc) {
            // A folder that cannot take its app.json is still served from what
            // was read; the write is retried on the next request.
            try { self::put($slug,$doc); }
            catch (Throwable $e) { error_log("softn-api: metadata for $slug could not be written: " . $e->getMessage()); self::$docs[$slug] = $doc; }
        }
    }
    /** One-time, restartable import. Keep the original database as a backup. */
    private static function migrateLegacy(): void {
        $root=Config::dataDir(); $path="$root/directory.sqlite";
        if (!is_file($path) || is_file("$root/directory-migrated.json")) return;
        $pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
        $pdo->exec('PRAGMA query_only=ON'); $pdo->beginTransaction();
        foreach ($pdo->query('SELECT * FROM apps')->fetchAll() as $app) {
            $slug=$app['slug']; if (!self::validSlug($slug)) throw new ApiError(503,'Legacy directory has an invalid slug.');
            if (is_file(self::path($slug).'/app.json')) continue;
            $doc=['schemaVersion'=>1,'app'=>array_replace(self::defaults($slug),$app)];
            foreach (['versions'=>'versions','comments'=>'comments','ratings'=>'ratings','runsDaily'=>'runs_daily'] as $key=>$table) { $s=$pdo->prepare("SELECT * FROM $table WHERE slug=?");$s->execute([$slug]);$doc[$key]=$s->fetchAll(); }
            self::put($slug,$doc);
        }
        if (!is_file("$root/categories.json")) self::writeJson("$root/categories.json",array_column($pdo->query('SELECT * FROM categories')->fetchAll(),null,'id'));
        $pdo->commit();
        self::writeJson("$root/directory-migrated.json",['schemaVersion'=>1,'migratedAt'=>gmdate('c'),'source'=>'directory.sqlite']);
    }
}
