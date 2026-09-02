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
    public static function comments(string $slug, int $page, int $perPage = 20): array
    {
        $pdo = Db::catalog();
        $page = max(1, min(1000, $page));
        $perPage = max(1, min(50, $perPage));
        $count = $pdo->prepare('SELECT COUNT(*) FROM comments WHERE slug = ? AND hidden = 0');
        $count->execute([$slug]);
        $total = (int) $count->fetchColumn();
        $stmt = $pdo->prepare('SELECT id, name, body, created_at FROM comments WHERE slug = ? AND hidden = 0 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?');
        $stmt->bindValue(1, $slug);
        $stmt->bindValue(2, $perPage, PDO::PARAM_INT);
        $stmt->bindValue(3, ($page - 1) * $perPage, PDO::PARAM_INT);
        $stmt->execute();
        $comments = [];
        foreach ($stmt->fetchAll() as $r) {
            $comments[] = ['id' => (int) $r['id'], 'name' => $r['name'], 'body' => $r['body'], 'createdAt' => gmdate('c', (int) $r['created_at'])];
        }
        return ['comments' => $comments, 'page' => $page, 'perPage' => $perPage, 'total' => $total, 'pages' => max(1, (int) ceil($total / $perPage))];
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
        $pdo = Db::catalog();
        $now = time();
        $pdo->beginTransaction();
        try {
            $pdo->prepare('INSERT INTO comments (slug, name, body, visitor, created_at) VALUES (?, ?, ?, ?, ?)')->execute([$slug, $name, $body, $visitor, $now]);
            $id = (int) $pdo->lastInsertId();
            $pdo->prepare('UPDATE apps SET comments = (SELECT COUNT(*) FROM comments WHERE slug = ? AND hidden = 0) WHERE slug = ?')->execute([$slug, $slug]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
        return ['id' => $id, 'name' => $name, 'body' => $body, 'createdAt' => gmdate('c', $now)];
    }

    public static function hideComment(int $id, bool $hidden = true): void
    {
        $pdo = Db::catalog();
        $stmt = $pdo->prepare('SELECT slug FROM comments WHERE id = ?');
        $stmt->execute([$id]);
        $slug = $stmt->fetchColumn();
        if (!is_string($slug)) throw new ApiError(404, 'No such comment.');
        $pdo->prepare('UPDATE comments SET hidden = ? WHERE id = ?')->execute([$hidden ? 1 : 0, $id]);
        $pdo->prepare('UPDATE apps SET comments = (SELECT COUNT(*) FROM comments WHERE slug = ? AND hidden = 0) WHERE slug = ?')->execute([$slug, $slug]);
    }

    /** @return array<string, mixed> */
    public static function rating(Request $req, string $slug): array
    {
        $visitor = Config::visitorHash($req->ip);
        $pdo = Db::catalog();
        $mine = $pdo->prepare('SELECT stars FROM ratings WHERE slug = ? AND visitor = ?');
        $mine->execute([$slug, $visitor]);
        $stars = $mine->fetchColumn();
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
        $visitor = Config::visitorHash($req->ip);
        Db::rateLimit('rate', $visitor);
        $pdo = Db::catalog();
        $pdo->beginTransaction();
        try {
            $pdo->prepare('INSERT INTO ratings (slug, visitor, stars, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(slug, visitor) DO UPDATE SET stars = excluded.stars, created_at = excluded.created_at')
                ->execute([$slug, $visitor, $stars, time()]);
            $pdo->prepare('UPDATE apps SET rating_sum = (SELECT COALESCE(SUM(stars), 0) FROM ratings WHERE slug = ?), rating_count = (SELECT COUNT(*) FROM ratings WHERE slug = ?) WHERE slug = ?')
                ->execute([$slug, $slug, $slug]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
        return self::rating($req, $slug);
    }

    public static function recordRun(Request $req, string $slug): void
    {
        $visitor = Config::visitorHash($req->ip);
        Db::rateLimit('run', $visitor);
        $pdo = Db::catalog();
        $day = (int) floor(time() / 86400);
        $pdo->prepare('INSERT INTO runs_daily (slug, day, count) VALUES (?, ?, 1) ON CONFLICT(slug, day) DO UPDATE SET count = count + 1')->execute([$slug, $day]);
        $pdo->prepare('UPDATE apps SET runs = runs + 1 WHERE slug = ?')->execute([$slug]);
    }
}
