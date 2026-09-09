<?php
/**
 * What visitors say about an app: comments, one star rating each, and a run
 * counter. No accounts, so a visitor is a salted hash of their address — one
 * rating per person means one per hash, and a comment is signed with whatever
 * name they typed.
 */
declare(strict_types=1);

final class Social
{
    /** @return array<string, mixed> */
    public static function comments(string $slug, int $page, int $perPage = 20): array {
        Apps::row($slug); // an unpublished app's comments go with it
        $rows=array_values(array_filter(Catalog::doc($slug)['comments'],fn($r)=>!$r['hidden']));
        usort($rows,fn($a,$b)=>[$b['created_at'],$b['id']]<=>[$a['created_at'],$a['id']]);
        $page=max(1,min(1000,$page));$perPage=max(1,min(50,$perPage));$total=count($rows);
        $comments=[];foreach(array_slice($rows,($page-1)*$perPage,$perPage) as $r)$comments[]=['id'=>(int)$r['id'],'name'=>$r['name'],'body'=>$r['body'],'createdAt'=>gmdate('c',(int)$r['created_at'])];
        return ['comments'=>$comments,'page'=>$page,'perPage'=>$perPage,'total'=>$total,'pages'=>max(1,(int)ceil($total/$perPage))];
    }

    /** @return array<string, mixed> */
    public static function addComment(Request $req, string $slug): array
    {
        // A field no person would fill in; a form-filling script does.
        if (($req->field('website') ?? '') !== '') throw new ApiError(400, 'The comment was not accepted.');
        $name = Text::clean($req->field('name'), 40) ?: 'Anonymous';
        $body = Text::clean($req->field('body') ?? $req->field('comment'), 2000, true);
        if (mb_strlen($body) < 2) throw new ApiError(400, 'A comment needs some words in it.');
        $visitor = Config::visitorHash($req->ip);
        Db::rateLimit('comment', $visitor);
        $doc=Catalog::doc($slug);$now=time();
        // Reserve a monotonic, browser-safe ID under the catalogue lock.
        // A crash may leave a gap; it cannot reuse an ID or reorder same-second comments.
        $path=Config::dataDir().'/sequences.json';$sequences=Catalog::readJson($path);
        $last=(int)($sequences['comment']??0);
        foreach(Catalog::all() as $app)foreach(Catalog::doc($app['slug'])['comments'] as $c)$last=max($last,(int)$c['id']);
        if($last>=9007199254740991)throw new ApiError(503,'Comment identifiers are exhausted.');
        $id=$last+1;$sequences['comment']=$id;Catalog::writeJson($path,$sequences);
        $doc['comments'][]=['id'=>$id,'slug'=>$slug,'name'=>$name,'body'=>$body,'visitor'=>$visitor,'hidden'=>0,'created_at'=>$now];
        $doc['app']['comments']=count(array_filter($doc['comments'],fn($c)=>!$c['hidden']));
        Catalog::put($slug,$doc);
        return ['id' => $id, 'name' => $name, 'body' => $body, 'createdAt' => gmdate('c', $now)];
    }

    public static function hideComment(int $id, bool $hidden = true): void {
        foreach(Catalog::all() as $app) {
            $slug=$app['slug'];$doc=Catalog::doc($slug);
            foreach($doc['comments'] as &$c)if((int)$c['id']===$id){$c['hidden']=$hidden?1:0;unset($c);$doc['app']['comments']=count(array_filter($doc['comments'],fn($r)=>!$r['hidden']));Catalog::put($slug,$doc);return;}
            unset($c);
        }
        throw new ApiError(404,'No such comment.');
    }

    /** @return array<string, mixed> */
    public static function rating(Request $req, string $slug): array
    {
        $visitor = Config::visitorHash($req->ip);
        $stars=null;foreach(Catalog::doc($slug)['ratings'] as $r)if($r['visitor']===$visitor)$stars=$r['stars'];
        $row = Apps::row($slug);
        $count = (int) $row['rating_count'];
        return [
            'average' => $count > 0 ? round((int) $row['rating_sum'] / $count, 2) : 0,
            'count' => $count,
            'mine' => is_numeric($stars) ? (int) $stars : null,
        ];
    }

    /** @return array<string, mixed> */
    public static function rate(Request $req, string $slug): array
    {
        $stars = (int) ($req->field('stars') ?? 0);
        if ($stars < 1 || $stars > 5) throw new ApiError(400, 'A rating is one to five stars.');
        Apps::row($slug); // refused for an unpublished app before anything is written
        $visitor = Config::visitorHash($req->ip);
        Db::rateLimit('rate', $visitor);
        $doc=Catalog::doc($slug);$ratings=[];
        foreach($doc['ratings'] as $r)if($r['visitor']!==$visitor)$ratings[]=$r;
        $ratings[]=['slug'=>$slug,'visitor'=>$visitor,'stars'=>$stars,'created_at'=>time()];
        $doc['ratings']=$ratings;$doc['app']['rating_sum']=array_sum(array_column($ratings,'stars'));$doc['app']['rating_count']=count($ratings);
        Catalog::put($slug,$doc);
        return self::rating($req, $slug);
    }

    /**
     * Count a play. Two stages are counted apart: `launch`, a press of Play
     * on the directory, and `open`, the runtime reporting the app ready. The
     * pages show opens as runs, because an open is the one that means the app
     * actually ran; the site used to count the click as a run and the runtime
     * counted the open as well, so every Play from the directory was two. A
     * request naming no stage is an open, which is what the count always meant.
     */
    public static function recordRun(Request $req, string $slug, string $stage = 'open'): void {
        Db::rateLimit('run',Config::visitorHash($req->ip));$doc=Catalog::doc($slug);
        if($stage==='launch')$doc['app']['launches']++;
        else {
            $doc['app']['runs']++;$day=(int)floor(time()/86400);$found=false;
            foreach($doc['runsDaily'] as &$r)if((int)$r['day']===$day){$r['count']++;$found=true;}unset($r);
            if(!$found)$doc['runsDaily'][]=['slug'=>$slug,'day'=>$day,'count'=>1];
        }
        Catalog::put($slug,$doc);
    }
}
