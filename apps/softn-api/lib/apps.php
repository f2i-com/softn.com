<?php
/**
 * The catalogue: publishing, versions, remixes, the listing and its search,
 * categories, thumbnails.
 *
 * Every published app is a JSON document beside its version files.
 * Publishing hands back an edit key; a new version, a metadata change or a
 * thumbnail needs it, and nothing else does. A remix is a new app that
 * remembers where it came from — that lineage is a first-class fact here,
 * because the point of a directory of sandboxed apps is that anyone can take
 * one apart and put it back together differently.
 */
declare(strict_types=1);

final class Apps
{
    private const SORTS = ['trending', 'newest', 'top', 'remixed', 'runs', 'name'];

    private static function copyBundle(string $from, string $to): void {
        $tmp=tempnam(dirname($to),'.upload-');
        if($tmp===false)throw new ApiError(503,'Cannot stage bundle.');
        try { if(!copy($from,$tmp) || !rename($tmp,$to))throw new ApiError(503,'Cannot store bundle.'); }
        finally { if(is_file($tmp))@unlink($tmp); }
    }

    // ── Slugs ──────────────────────────────────────────────────────────────

    public static function slugify(string $name): string
    {
        $s = strtolower(trim($name));
        if (function_exists('iconv')) {
            $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
            if (is_string($t) && $t !== '') $s = $t;
        }
        $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
        $s = trim($s, '-');
        if ($s === '') $s = 'app';
        return substr($s, 0, 48);
    }

    private static function uniqueSlug(string $base): string {
        $rows = Catalog::all(); $slug=$base;
        for ($n=2;$n<1000;$n++) { if (!isset($rows[$slug]) && !is_dir(Catalog::path($slug))) return $slug; $slug=substr($base,0,44).'-'.$n; }
        throw new ApiError(500,'Could not find a free name for the app.');
    }

    /** A slug as a visitor typed it into a URL: the manifest name works too. */
    public static function resolveSlug(string $given): string {
        $given=trim($given); $rows=Catalog::all();
        foreach ([$given,self::slugify($given)] as $slug) if (isset($rows[$slug])) return $slug;
        uasort($rows,fn($a,$b)=>$a['created_at']<=>$b['created_at']);
        foreach ($rows as $slug=>$r) if (!$r['hidden'] && mb_strtolower($r['name'])===mb_strtolower($given)) return $slug;
        throw new ApiError(404,'No app is published under that name.');
    }

    // ── Rows ───────────────────────────────────────────────────────────────

    /** @return array<string, mixed> */
    public static function row(string $slug, bool $includeHidden = false): array {
        $row=Catalog::all()[$slug]??null;
        if (!$row || (!$includeHidden && $row['hidden'])) throw new ApiError(404,'No app is published under that name.');
        return $row;
    }

    public static function dir(string $slug): string
    {
        $dir = Catalog::path($slug);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) throw new ApiError(500, 'Could not create the app\'s directory.');
        return $dir;
    }

    /** @return array<string, mixed> */
    public static function version(string $slug, ?int $version = null): array {
        $rows=Catalog::doc($slug)['versions']; usort($rows,fn($a,$b)=>$b['version']<=>$a['version']);
        foreach ($rows as $row) if ($version===null || (int)$row['version']===$version) return $row;
        throw new ApiError(404,'That version does not exist.');
    }

    // ── Presentation ───────────────────────────────────────────────────────

    /** @param array<string, mixed> $row @return array<string, mixed> */
    public static function card(array $row): array
    {
        $slug = (string) $row['slug'];
        $bundle = "/api/apps/$slug/bundle.softn";
        $count = (int) $row['rating_count'];
        $parent = null;
        if (!empty($row['parent_slug'])) {
            $pr = Catalog::all()[$row['parent_slug']] ?? null;
            if ($pr) $parent = ['slug' => $pr['slug'], 'name' => $pr['name']];
        }
        return [
            'slug' => $slug,
            'name' => (string) $row['name'],
            'description' => (string) $row['description'],
            'author' => (string) $row['author'],
            'category' => (string) $row['category'],
            'tags' => json_decode((string) $row['tags'], true) ?: [],
            'capabilities' => json_decode((string) $row['capabilities'], true) ?: [],
            // By collection name; `*` is the default for the rest. Always an
            // object on the wire, so a page can index it without checking.
            'storagePolicies' => (object) Storage::policiesOf($row),
            'execution' => (string) $row['execution'],
            'version' => (int) $row['latest_version'],
            'size' => (int) $row['size'],
            'primary' => $row['primary_color'] ?: null,
            // Versioned by the last update, so a replaced picture is never the
            // cached one: the images are served with a ten-minute max-age.
            'thumbnail' => "/api/apps/$slug/thumbnail?v=" . (int) $row['updated_at'],
            'thumbnailKind' => $row['thumb'] ? 'image' : ($row['icon'] ? 'icon' : 'placeholder'),
            'icon' => $row['icon'] ? "/api/apps/$slug/icon?v=" . (int) $row['updated_at'] : null,
            'runs' => (int) $row['runs'],
            // Presses of Play on the directory, which need not become runs:
            // a bundle that failed to open counts here and not there.
            'launches' => (int) ($row['launches'] ?? 0),
            'remixes' => (int) $row['remixes'],
            'rating' => ['average' => $count > 0 ? round((int) $row['rating_sum'] / $count, 2) : 0, 'count' => $count],
            'comments' => (int) $row['comments'],
            'parent' => $parent,
            'source' => (string) $row['source'],
            'createdAt' => gmdate('c', (int) $row['created_at']),
            'updatedAt' => gmdate('c', (int) $row['updated_at']),
            'urls' => [
                'page' => "/app/$slug",
                'run' => "/web/app/$slug",
                'bundle' => $bundle,
                'download' => "$bundle?download=1",
                'studio' => '/studio/?open=' . rawurlencode($bundle),
                'builder' => '/builder/?open=' . rawurlencode($bundle),
                'remix' => "/publish?remix=$slug",
            ],
        ];
    }

    /** @param array<string, mixed> $row @return array<string, mixed> */
    public static function detail(array $row): array
    {
        $slug = (string) $row['slug'];
        $doc=Catalog::doc($slug);
        $card = self::card($row);
        $versions = [];
        usort($doc['versions'],fn($a,$b)=>$b['version']<=>$a['version']);
        foreach ($doc['versions'] as $r) {
            $versions[] = [
                'version' => (int) $r['version'],
                'manifestVersion' => (string) $r['manifest_version'],
                'size' => (int) $r['size'],
                'sha256' => (string) $r['sha256'],
                'notes' => (string) $r['notes'],
                'createdAt' => gmdate('c', (int) $r['created_at']),
                'bundle' => "/api/apps/$slug/bundle.softn?v=" . (int) $r['version'],
            ];
        }
        $breakdown = [1=>0,2=>0,3=>0,4=>0,5=>0];
        foreach ($doc['ratings'] as $r) $breakdown[(int)$r['stars']]++;
        $kids=array_values(array_filter(Catalog::all(),fn($r)=>$r['parent_slug']===$slug && !$r['hidden']));
        usort($kids,fn($a,$b)=>$b['created_at']<=>$a['created_at']);
        $remixes=[];
        foreach (array_slice($kids,0,12) as $r) $remixes[]=['slug'=>$r['slug'],'name'=>$r['name'],'author'=>$r['author'],'createdAt'=>gmdate('c',(int)$r['created_at'])];
        $lineage = [];
        $cur = $row['parent_slug'] ?? null;
        $hops = 0;
        while (is_string($cur) && $cur !== '' && $hops++ < 8) {
            $pr = Catalog::all()[$cur] ?? null;
            if (!$pr) break;
            $lineage[] = ['slug' => $pr['slug'], 'name' => $pr['name'], 'author' => $pr['author']];
            $cur = $pr['parent_slug'];
        }
        $card['versions'] = $versions;
        $card['ratingBreakdown'] = $breakdown;
        $card['remixList'] = $remixes;
        $card['lineage'] = $lineage;
        $card['storage'] = Storage::summary($slug);
        $card['manifest'] = self::manifestSummary($slug, (int) $row['latest_version']);
        return $card;
    }

    /** The parts of the manifest worth showing: entry file and the file counts by kind. */
    private static function manifestSummary(string $slug, int $version): ?array
    {
        try {
            $ver = self::version($slug, $version);
            $zip = new ZipArchive();
            if ($zip->open(self::dir($slug) . '/' . $ver['file'], ZipArchive::RDONLY) !== true) return null;
            $text = $zip->getFromName('manifest.json');
            $zip->close();
            $m = is_string($text) ? json_decode($text, true) : null;
            if (!is_array($m)) return null;
            $files = is_array($m['files'] ?? null) ? $m['files'] : [];
            $counts = [];
            foreach ($files as $kind => $list) {
                if (is_array($list)) $counts[(string) $kind] = count($list);
            }
            return [
                'main' => is_string($m['main'] ?? null) ? $m['main'] : null,
                'version' => is_string($m['version'] ?? null) ? $m['version'] : null,
                'files' => $counts,
            ];
        } catch (Throwable) {
            return null;
        }
    }

    // ── Listing ────────────────────────────────────────────────────────────

    /** @param array<string, string> $q @return array<string, mixed> */
    public static function list(array $q): array {
        $search=Text::clean($q['q']??'',80);$category=Text::clean($q['category']??'',40);$tag=strtolower(Text::clean($q['tag']??'',24));$author=Text::clean($q['author']??'',40);$cap=Text::clean($q['cap']??'',16);
        $sort=in_array($q['sort']??'',self::SORTS,true)?$q['sort']:($search!==''?'relevance':'trending');
        $perPage=max(1,min(48,(int)($q['perPage']??24)));$page=max(1,min(500,(int)($q['page']??1)));
        $rows=[];$since=time()-7*86400;
        foreach (Catalog::all() as $r) {
            if ($r['hidden'] || ($category!=='' && $category!=='all' && $r['category']!==$category)) continue;
            $tags=json_decode($r['tags'],true)?:[];$caps=json_decode($r['capabilities'],true)?:[];
            if ($tag!=='' && !in_array($tag,$tags,true)) continue;
            if ($author!=='' && mb_strtolower($r['author'])!==mb_strtolower($author)) continue;
            if (($cap==='none' && $caps) || ($cap==='nonet' && in_array('net',$caps,true)) || ($cap==='storage' && !in_array('storage',$caps,true)) || ($cap==='worker' && $r['execution']!=='worker')) continue;
            $text=mb_strtolower($r['name'].' '.$r['description'].' '.implode(' ',$tags).' '.$r['author']);
            $words=preg_split('/\s+/u',trim(mb_strtolower($search)))?:[];
            if ($search!=='' && array_filter($words,fn($w)=>!str_contains($text,$w))) continue;
            $r['_relevance']=$search!=='' && str_contains(mb_strtolower($r['name']),mb_strtolower($search))?1:0;
            $daily=Catalog::doc($r['slug'])['runsDaily'];$runs7=0;
            foreach ($daily as $d) if ($d['day']>=floor($since/86400)) $runs7+=$d['count'];
            $r['_trend']=$runs7*3+$r['remixes']*5+$r['rating_count']*2+$r['comments']+($r['created_at']>$since?4:0);
            $r['_average']=$r['rating_count']?$r['rating_sum']/$r['rating_count']:0;
            $rows[]=$r;
        }
        usort($rows,function($a,$b) use($sort) {
            if ($sort==='name') return strcasecmp($a['name'],$b['name']) ?: strcmp($a['slug'],$b['slug']);
            $keys=match($sort){'newest'=>['created_at'],'top'=>['_average','rating_count','runs'],'remixed'=>['remixes','runs'],'runs'=>['runs'],'relevance'=>['_relevance','runs'],default=>['_trend','runs','created_at']};
            foreach($keys as $k) if($a[$k]!=$b[$k])return $b[$k]<=>$a[$k];
            return strcmp($a['slug'],$b['slug']);
        });
        $total=count($rows);
        return ['apps'=>array_map([self::class,'card'],array_slice($rows,($page-1)*$perPage,$perPage)),'page'=>$page,'perPage'=>$perPage,'total'=>$total,'pages'=>max(1,(int)ceil($total/$perPage)),'sort'=>$sort,'query'=>$search,'category'=>$category];
    }

    // ── Publishing ─────────────────────────────────────────────────────────

    /**
     * Publish a bundle as a new app. `$opts` are the visitor's fields; the
     * bundle's own manifest fills whatever they left out.
     *
     * @param array<string, mixed> $opts
     * @return array{app: array<string, mixed>, editKey: string|null}
     */
    public static function create(string $bundlePath, array $opts, string $source = 'upload', ?string $parentSlug = null): array
    {
        $info = Bundle::inspect($bundlePath);
        $name = Text::clean($opts['name'] ?? '', 64) ?: $info['name'];
        $description = Text::clean($opts['description'] ?? '', 600, true) ?: $info['description'];
        $author = Text::clean($opts['author'] ?? '', 40) ?: (self::authorFromManifest($info['manifest']) ?? 'Anonymous');
        $category = Categories::resolve(Text::clean($opts['category'] ?? '', 40));
        $tags = Text::tags($opts['tags'] ?? null);
        $notes = Text::clean($opts['notes'] ?? '', 400, true);
        $primary = self::color($opts['primary'] ?? null) ?? self::color($info['manifest']['config']['theme']['primary'] ?? null);

        Catalog::boot();
        // A seed names its own slug: the id the site already uses for that demo.
        $wanted = is_string($opts['slug'] ?? null) && $opts['slug'] !== '' ? self::slugify($opts['slug']) : self::slugify($name);
        $slug = self::uniqueSlug($wanted);
        // Everything that can refuse is settled before the folder exists: a
        // parent that is hidden is a 404 here, not after the bundle is on disk.
        $rootSlug = null;
        if ($parentSlug !== null) {
            $parent = self::row($parentSlug);
            $rootSlug = $parent['root_slug'] ?: $parent['slug'];
        }
        $editKey = $source === 'seed' ? null : bin2hex(random_bytes(20));
        $dir = self::dir($slug);
        $file = 'v1.softn';
        try {
            self::copyBundle($bundlePath, "$dir/$file");
            $icon = self::storeIcon($dir, $info['icon']);
            $now = time();
            $app=array_replace(Catalog::defaults($slug),[
                'name'=>$name,'description'=>$description,'author'=>$author,'category'=>$category,'tags'=>json_encode($tags),'parent_slug'=>$parentSlug,'root_slug'=>$rootSlug,
                'capabilities'=>json_encode($info['capabilities']),'execution'=>$info['execution'],'storage_policies'=>json_encode((object)$info['storagePolicies']),
                'icon'=>$icon,'primary_color'=>$primary,'edit_key_hash'=>$editKey===null?null:hash('sha256',$editKey),'source'=>$source,'size'=>$info['size'],'created_at'=>$now,'updated_at'=>$now
            ]);
            Catalog::put($slug,['app'=>$app,'versions'=>[['slug'=>$slug,'version'=>1,'file'=>$file,'size'=>$info['size'],'sha256'=>$info['sha256'],'manifest_version'=>$info['version'],'notes'=>$notes,'created_at'=>$now]],'comments'=>[],'ratings'=>[],'runsDaily'=>[]]);
        } catch (Throwable $e) {
            // A folder with a bundle and no app.json is discovered on the
            // next request as an app of its own, with no edit key — the
            // admin's. Retire what was written the way an unpublish does.
            try { Catalog::retire($slug); } catch (Throwable $retire) { error_log("softn-api: could not retire the half-published $slug: " . $retire->getMessage()); }
            throw $e;
        }
        return ['app' => self::card(self::row($slug)), 'editKey' => $editKey];
    }

    /** @return array<string, mixed> */
    public static function addVersion(string $slug, string $bundlePath, ?string $notes): array {
        $row=self::row($slug,true);$info=Bundle::inspect($bundlePath);$doc=Catalog::doc($slug);
        $next=(int)$row['latest_version']+1;
        if($next>(int)Config::get('maxVersionsPerApp',50))throw new ApiError(400,'This app has reached its version limit.');
        $dir=self::dir($slug);$file="v$next.softn";
        self::copyBundle($bundlePath,"$dir/$file");
        $icon=self::storeIcon($dir,$info['icon'])??$row['icon'];$now=time();
        $doc['versions'][]=['slug'=>$slug,'version'=>$next,'file'=>$file,'size'=>$info['size'],'sha256'=>$info['sha256'],'manifest_version'=>$info['version'],'notes'=>Text::clean($notes,400,true),'created_at'=>$now];
        $doc['app']=array_replace($doc['app'],['latest_version'=>$next,'capabilities'=>json_encode($info['capabilities']),'execution'=>$info['execution'],'storage_policies'=>json_encode((object)$info['storagePolicies']),'icon'=>$icon,'size'=>$info['size'],'updated_at'=>$now]);
        Catalog::put($slug,$doc);
        return self::detail(self::row($slug,true));
    }

    /**
     * Refresh an existing seeded app from its updated bundle on disk.
     * Keeps slug, metadata, and replaces the bundle payload while refreshing version digest.
     *
     * @param array<string, mixed> $meta
     */
    public static function updateSeedApp(string $slug, string $bundlePath, array $meta = []): void
    {
        Catalog::boot();
        $info = Bundle::inspect($bundlePath);
        $name = Text::clean($meta['name'] ?? '', 64) ?: $info['name'];
        $description = Text::clean($meta['description'] ?? '', 600, true) ?: $info['description'];
        $category = Categories::resolve(Text::clean($meta['category'] ?? '', 40));
        $tags = Text::tags($meta['tags'] ?? null);
        $primary = self::color($meta['primary'] ?? null) ?? self::color($info['manifest']['config']['theme']['primary'] ?? null);

        $dir = self::dir($slug);
        $file = 'v1.softn';
        self::copyBundle($bundlePath, "$dir/$file");
        $icon = self::storeIcon($dir, $info['icon']);
        $now = time();

        $doc=Catalog::doc($slug);
        $doc['app']=array_replace($doc['app'],['name'=>$name,'description'=>$description,'category'=>$category,'tags'=>json_encode($tags),'capabilities'=>json_encode($info['capabilities']),'execution'=>$info['execution'],'storage_policies'=>json_encode((object)$info['storagePolicies']),'icon'=>$icon??$doc['app']['icon'],'primary_color'=>$primary,'size'=>$info['size'],'updated_at'=>$now]);
        foreach($doc['versions'] as &$v)if((int)$v['version']===1)$v=array_replace($v,['file'=>$file,'size'=>$info['size'],'sha256'=>$info['sha256'],'manifest_version'=>$info['version'],'created_at'=>$now]);
        unset($v);Catalog::put($slug,$doc);
    }

    /** @param array<string, mixed> $fields @return array<string, mixed> */
    public static function patch(string $slug, array $fields): array
    {
        $row = self::row($slug, true);
        $sets = [];
        $params = [':slug' => $slug];
        if (isset($fields['name'])) {
            $name = Text::clean((string) $fields['name'], 64);
            if ($name === '') throw new ApiError(400, 'The name cannot be empty.');
            $sets[] = 'name = :name';
            $params[':name'] = $name;
        }
        if (isset($fields['description'])) {
            $sets[] = 'description = :description';
            $params[':description'] = Text::clean((string) $fields['description'], 600, true);
        }
        if (isset($fields['author'])) {
            $sets[] = 'author = :author';
            $params[':author'] = Text::clean((string) $fields['author'], 40) ?: 'Anonymous';
        }
        if (isset($fields['category'])) {
            $sets[] = 'category = :category';
            $params[':category'] = Categories::resolve(Text::clean((string) $fields['category'], 40));
        }
        if (array_key_exists('tags', $fields)) {
            $sets[] = 'tags = :tags';
            $params[':tags'] = json_encode(Text::tags(is_array($fields['tags']) ? json_encode($fields['tags']) : (string) $fields['tags']));
        }
        if (isset($fields['primary'])) {
            $sets[] = 'primary_color = :primary';
            $params[':primary'] = self::color((string) $fields['primary']);
        }
        if (array_key_exists('hidden', $fields)) {
            $sets[] = 'hidden = :hidden';
            $params[':hidden'] = $fields['hidden'] ? 1 : 0;
        }
        if (!$sets) return self::detail($row);
        $sets[] = 'updated_at = :now';
        $params[':now'] = time();
        unset($params[':slug']);$changes=[];foreach($params as $k=>$v){$field=substr($k,1);$field=match($field){'primary'=>'primary_color','now'=>'updated_at',default=>$field};$changes[$field]=$v;}Catalog::patch($slug,$changes);
        return self::detail(self::row($slug, true));
    }

    /** @param array{0: string, 1: string} $image */
    public static function setThumbnail(string $slug, array $image): void
    {
        self::row($slug,true);
        [$bytes, $mime] = $image;
        $dir = self::dir($slug);
        foreach (glob("$dir/thumb.*") ?: [] as $old) @unlink($old);
        $file = 'thumb.' . Images::extension($mime);
        if (file_put_contents("$dir/$file", $bytes, LOCK_EX) === false) throw new ApiError(500, 'Could not store the thumbnail.');
        Catalog::patch($slug,['thumb'=>$file,'updated_at'=>time()]);
    }

    public static function remove(string $slug): void { Catalog::remove($slug);
    }

    /**
     * The edit key, or the admin key, or nothing. A seeded app has no edit key
     * and belongs to the site.
     */
    /** requireOwner's question without its refusal. */
    public static function isOwner(Request $req, string $slug): bool
    {
        try {
            self::requireOwner($req, $slug);
            return true;
        } catch (ApiError) {
            return false;
        }
    }

    public static function requireOwner(Request $req, string $slug): void
    {
        if (Config::isAdmin($req->credential('x-admin-key', 'adminKey'))) return;
        $row = self::row($slug, true);
        $presented = $req->credential('x-edit-key', 'editKey');
        $hash = $row['edit_key_hash'];
        if (!is_string($presented) || $presented === '' || !is_string($hash) || !hash_equals($hash, hash('sha256', $presented))) {
            throw new ApiError(403, 'That needs the edit key this app was published with.');
        }
    }

    /** @param array<string, mixed> $manifest */
    private static function authorFromManifest(array $manifest): ?string
    {
        $a = $manifest['author'] ?? null;
        if (is_string($a)) return Text::clean($a, 40) ?: null;
        if (is_array($a) && is_string($a['name'] ?? null)) return Text::clean($a['name'], 40) ?: null;
        return null;
    }

    private static function color(mixed $value): ?string
    {
        if (!is_string($value)) return null;
        $value = trim($value);
        return preg_match('/^#[0-9a-fA-F]{6}$/', $value) ? strtolower($value) : null;
    }

    /** @param array{0: string, 1: string}|null $icon */
    private static function storeIcon(string $dir, ?array $icon): ?string
    {
        if ($icon === null) return null;
        [$bytes, $mime] = $icon;
        foreach (glob("$dir/icon.*") ?: [] as $old) @unlink($old);
        $file = 'icon.' . Images::extension($mime);
        if (file_put_contents("$dir/$file", $bytes, LOCK_EX) === false) return null;
        return $file;
    }

    // ── Images ─────────────────────────────────────────────────────────────

    public static function thumbnailResponse(string $slug): Response
    {
        $row = self::row($slug);
        $dir = Catalog::path($slug);
        $cache = ['Cache-Control' => 'public, max-age=600'];
        foreach ([$row['thumb'], $row['icon']] as $file) {
            if (is_string($file) && $file !== '' && is_file("$dir/$file")) {
                $ext = pathinfo($file, PATHINFO_EXTENSION);
                return Response::file("$dir/$file", Images::mimeForExtension($ext), $cache + ['ETag' => '"' . md5_file("$dir/$file") . '"']);
            }
        }
        return Response::bytes(self::placeholderSvg((string) $row['name'], $row['primary_color'] ?: null), 'image/svg+xml', $cache);
    }

    public static function iconResponse(string $slug): Response
    {
        $row = self::row($slug);
        $dir = Catalog::path($slug);
        $file = $row['icon'];
        if (is_string($file) && $file !== '' && is_file("$dir/$file")) {
            return Response::file("$dir/$file", Images::mimeForExtension(pathinfo($file, PATHINFO_EXTENSION)), ['Cache-Control' => 'public, max-age=600']);
        }
        return Response::bytes(self::placeholderSvg((string) $row['name'], $row['primary_color'] ?: null, true), 'image/svg+xml', ['Cache-Control' => 'public, max-age=600']);
    }

    /** A card for an app that brought no picture: its initials on a colour derived from its name. */
    public static function placeholderSvg(string $name, ?string $primary, bool $square = false): string
    {
        $hue = hexdec(substr(md5($name), 0, 2)) * 360 / 255;
        $bg = $primary ?? sprintf('hsl(%d, 48%%, 42%%)', (int) $hue);
        $bg2 = $primary ? self::shade($primary, -0.25) : sprintf('hsl(%d, 52%%, 24%%)', (int) $hue);
        $words = preg_split('/\s+/u', trim($name)) ?: [];
        $initials = '';
        foreach ($words as $w) {
            if ($w === '') continue;
            $initials .= mb_strtoupper(mb_substr($w, 0, 1));
            if (mb_strlen($initials) >= 2) break;
        }
        $initials = htmlspecialchars($initials ?: '?', ENT_QUOTES | ENT_XML1);
        $w = $square ? 256 : 640;
        $h = $square ? 256 : 400;
        $fs = $square ? 112 : 160;
        return <<<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="$w" height="$h" viewBox="0 0 $w $h" role="img">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="$bg"/><stop offset="1" stop-color="$bg2"/></linearGradient></defs>
<rect width="$w" height="$h" fill="url(#g)"/>
<text x="50%" y="50%" dy="0.36em" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-weight="800" font-size="$fs" fill="rgba(255,255,255,0.92)">$initials</text>
</svg>
SVG;
    }

    private static function shade(string $hex, float $amount): string
    {
        $r = hexdec(substr($hex, 1, 2));
        $g = hexdec(substr($hex, 3, 2));
        $b = hexdec(substr($hex, 5, 2));
        $f = fn(int $c): int => max(0, min(255, (int) round($c * (1 + $amount))));
        return sprintf('#%02x%02x%02x', $f((int) $r), $f((int) $g), $f((int) $b));
    }
}

final class Categories
{
    /** The categories the site starts with. A visitor can suggest more. */
    private const CORE = [
        ['games', 'Games', 'Things to play', '🎮', 10],
        ['simulations', 'Simulations', 'Interactive worlds, ecosystems and models', '🌐', 15],
        ['tools', 'Tools', 'Utilities that do one job well', '🧰', 20],
        ['creative', 'Creative', 'Drawing, music, generators', '🎨', 30],
        ['productivity', 'Productivity', 'Notes, planners, trackers', '📝', 40],
        ['education', 'Learning', 'Teach, quiz, explain', '📚', 50],
        ['ai', 'AI', 'Apps that run a model', '🤖', 60],
        ['experiments', 'Experiments', 'Trying something out', '🧪', 70],
        ['demos', 'Examples', 'Sample apps that show what SoftN can do, not things to rely on', '🧩', 80],
        ['other', 'Other', 'Everything else', '📦', 90],
    ];

    public static function ensure(): void {
        $rows=Catalog::categories();$before=$rows;
        foreach(self::CORE as [$id,$name,$desc,$emoji,$sort]) {
            if(isset($rows[$id]) && $rows[$id]['status']!=='core')continue;
            $rows[$id]=['id'=>$id,'name'=>$name,'description'=>$desc,'emoji'=>$emoji,'status'=>'core','sort'=>$sort,'created_at'=>$rows[$id]['created_at']??time()];
        }
        if($rows!==$before)Catalog::saveCategories($rows);
    }

    /** @return array<int, array<string, mixed>> */
    public static function all(bool $includeHidden = false): array
    {
        self::ensure();
        $rows=array_values(Catalog::categories());$apps=Catalog::all();
        foreach($rows as &$r)$r['app_count']=count(array_filter($apps,fn($a)=>$a['category']===$r['id']&&!$a['hidden']));unset($r);
        usort($rows,fn($a,$b)=>[in_array($a['status'],['core','approved'])?0:1,$a['sort'],$a['name']]<=>[in_array($b['status'],['core','approved'])?0:1,$b['sort'],$b['name']]);
        $out = [];
        foreach ($rows as $r) {
            if (!$includeHidden && $r['status'] === 'hidden') continue;
            $out[] = [
                'id' => $r['id'],
                'name' => $r['name'],
                'description' => $r['description'],
                'emoji' => $r['emoji'],
                'status' => $r['status'],
                'suggested' => $r['status'] === 'suggested',
                'apps' => (int) $r['app_count'],
            ];
        }
        return $out;
    }

    /** A category id the visitor gave, or 'other'. */
    public static function resolve(string $given): string {
        self::ensure();$id=Apps::slugify($given);
        foreach(Catalog::categories() as $r)if($r['status']!=='hidden' && ($r['id']===$id || mb_strtolower($r['name'])===mb_strtolower($given)))return $r['id'];
        return 'other';
    }

    /**
     * A visitor's suggestion. It becomes usable at once, marked as suggested,
     * so an app can be filed under it today; the site owner approves, renames
     * or hides it later with the admin key.
     *
     * @return array<string, mixed>
     */
    public static function suggest(string $name, string $description, string $emoji): array
    {
        self::ensure();
        $name = Text::clean($name, 32);
        if (mb_strlen($name) < 2) throw new ApiError(400, 'A category name needs at least two characters.');
        $id = Apps::slugify($name);
        $rows=Catalog::categories();
        foreach($rows as $r)if($r['id']===$id||mb_strtolower($r['name'])===mb_strtolower($name))return self::one($r['id']);
        if(count($rows)>=200)throw new ApiError(400,'There are already as many categories as the directory will hold.');
        $emoji = Text::clean($emoji, 4);
        if ($emoji !== '' && !preg_match('/^\p{So}\p{M}*(\x{200D}\p{So}\p{M}*)*$/u', $emoji)) $emoji = '';
        $rows[$id]=['id'=>$id,'name'=>$name,'description'=>Text::clean($description,120),'emoji'=>$emoji?:'🏷️','status'=>'suggested','sort'=>500,'created_at'=>time()];Catalog::saveCategories($rows);
        return self::one($id);
    }

    /** @return array<string, mixed> */
    public static function one(string $id): array
    {
        foreach (self::all(true) as $c) {
            if ($c['id'] === $id) return $c;
        }
        throw new ApiError(404, 'No such category.');
    }

    /** @param array<string, mixed> $fields @return array<string, mixed> */
    public static function update(string $id, array $fields): array {
        self::one($id);$rows=Catalog::categories();$r=$rows[$id];
        if(isset($fields['status'])&&in_array($fields['status'],['core','approved','suggested','hidden'],true))$r['status']=$fields['status'];
        foreach(['name'=>32,'description'=>120,'emoji'=>4] as $k=>$max)if(isset($fields[$k])){$v=Text::clean((string)$fields[$k],$max);if($k!=='name'||$v!=='')$r[$k]=$v;}
        if(isset($fields['sort']))$r['sort']=(int)$fields['sort'];
        $rows[$id]=$r;Catalog::saveCategories($rows);return self::one($id);
    }
}
