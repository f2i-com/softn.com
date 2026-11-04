<?php
/**
 * Publishing with `git push`: an app in the directory as a remote that takes pushes.
 *
 *     git remote add softn https://my-app@softn.com/api/git/my-app.git
 *     git config remote.softn.push HEAD:refs/heads/main
 *     git push softn
 *
 * The password git asks for is the app's edit key, and the app's slug is the username, which is what makes git's
 * credential helpers keep one key for each app rather than one for the site.
 *
 * The directory keeps no repository. It tells git it holds nothing, so every push carries what it needs, and only the
 * files of the commit pushed are kept, as a new version made the way a bundle sent to `POST /apps/{slug}/versions` is:
 * the same checks and the same limits. There is no store of objects to back up, erase or fill, and what is in a
 * project's history and not in its last commit is never kept or shown. That is also why this takes pushes and does not
 * serve clones.
 *
 * Nothing here runs git, which a shared host may not have, so a pack is read here. A pack comes from whoever holds the
 * key, and is held to limits on its bytes, its objects and what they expand to, before anything is allocated.
 */
declare(strict_types=1);

/** A push turned away, with the reason to show the person. */
final class GitRefused extends RuntimeException
{
}

/**
 * A pack read into objects: each one's bytes in a spool file, found by its id. A delta is resolved into the object it
 * makes, so what is read afterwards is whole objects.
 */
final class GitPack
{
    private const MAX_OBJECTS = 50000;
    /** The runtime's limit on one file of a bundle: an object past it could not be published. */
    private const MAX_OBJECT = 50 * 1024 * 1024;
    /** All the objects expanded, history included. */
    private const MAX_TOTAL = 256 * 1024 * 1024;
    /**
     * All the bytes gone through to read a pack. MAX_TOTAL is what is kept, and an object sent twice is kept once, so
     * this is what holds the time: the same large object can be sent, or rebuilt by a tiny delta, over and over. A
     * real pack comes to about twice what it keeps.
     */
    private const MAX_WORK = 1024 * 1024 * 1024;
    /** One step of a delta, in those bytes. */
    private const OP_WORK = 32;
    /** Deltas held in memory for a base still to come. Git sends a base before what is built on it. */
    private const MAX_WAITING = 16 * 1024 * 1024;
    private const MAX_DEPTH = 4096;
    /** How far the spool grows between looks at the temp disk. */
    private const ROOM_STEP = 32 * 1024 * 1024;
    /** What a look at memory allows for beyond what it names: the objects' index, and what PHP holds besides. */
    private const MEMORY_SPARE = 8 * 1024 * 1024;
    /** The most one slice of a compressed stream can inflate to at once: deflate expands no more than 1032 times. */
    private const SLICE_EXPANDS = self::SLICE * 1032;
    /** How much of a large copy in a delta is taken from its base at a time. */
    private const COPY_SLICE = 1024 * 1024;
    private const SLICE = 16 * 1024;
    private const TYPES = [1 => 'commit', 2 => 'tree', 3 => 'blob', 4 => 'tag'];
    /** Says what to do about a history too large to send. */
    public const LATEST_ONLY = 'To send only its latest files: git push softn "$(git commit-tree "HEAD^{tree}" -m Publish):refs/heads/main"';

    /** @var array<string, array{type: string, offset: int, size: int, depth: int}> */
    private array $objects = [];
    /** @var resource */
    private $spool;
    private string $spoolPath;
    private int $written = 0;
    private int $worked = 0;
    /** From the first step and not from nothing: a small push is no reason to refuse on a small temp disk. */
    private int $roomAt = self::ROOM_STEP;
    /** @var array<string, list<string>> deltas by the id of the base they wait for */
    private array $waiting = [];
    private int $waited = 0;
    /** @var array{type: string, size: int, offset: int, hash: HashContext}|null the object being written */
    private ?array $writing = null;

    /** @param resource $in The pushed body, read from $start up to $end. */
    public function __construct(private $in, private int $start, private int $end)
    {
        $this->spoolPath = TempFiles::create();
        $spool = fopen($this->spoolPath, 'w+b');
        if ($spool === false) throw new ApiError(500, 'Could not write a temporary file.');
        $this->spool = $spool;
    }

    public function spoolPath(): string
    {
        return $this->spoolPath;
    }

    public function read(): void
    {
        fseek($this->in, $this->start);
        $head = (string) fread($this->in, 12);
        if (strlen($head) !== 12 || !str_starts_with($head, 'PACK')) throw new GitRefused('This push did not carry a pack of objects.');
        ['version' => $version, 'count' => $count] = (array) unpack('Nversion/Ncount', substr($head, 4));
        if ($version !== 2 && $version !== 3) throw new GitRefused("This push's pack is version $version, which is not read here.");
        if ($count > self::MAX_OBJECTS) throw new GitRefused("This push has $count objects, and the most taken is " . self::MAX_OBJECTS . '. ' . self::LATEST_ONLY);

        for ($i = 0; $i < $count; $i++) {
            [$type, $size] = $this->objectHeader();
            if ($size > self::MAX_OBJECT) throw self::tooLarge();
            $this->work($size);
            if (isset(self::TYPES[$type])) {
                $this->open(self::TYPES[$type], $size);
                $this->inflate($size, function (string $piece): void { $this->put($piece); });
                $this->settle($this->shut(0));
                continue;
            }
            // Deltas named by their base's id: the one kind sent to a server that does not offer ofs-delta.
            if ($type !== 7) throw new GitRefused('This push has an object of a kind that is not read here.');
            $base = bin2hex((string) fread($this->in, 20));
            // A delta is held whole, and a string that grows can be copied as it does, with the piece it grows by.
            // The last one goes first: it is made, or waiting where it is held.
            $delta = '';
            $this->haveMemory(2 * $size + min($size, self::SLICE_EXPANDS));
            $this->inflate($size, static function (string $piece) use (&$delta): void { $delta .= $piece; });
            if (isset($this->objects[$base])) {
                $this->settle($this->resolve($base, $delta));
                continue;
            }
            $this->waited += strlen($delta);
            if ($this->waited > self::MAX_WAITING) throw new GitRefused('This push sends too much ahead of the objects it is built on.');
            $this->waiting[$base][] = $delta;
        }
        if ($this->waiting !== []) throw new GitRefused('This push is missing an object its pack is built on.');
        $this->checkTrailer();
    }

    /** The deltas that were waiting for an object that is here now, and those waiting for what they make. */
    private function settle(string $id): void
    {
        $ready = [$id];
        while ($ready !== []) {
            $base = array_pop($ready);
            $deltas = $this->waiting[$base] ?? [];
            unset($this->waiting[$base]);
            foreach ($deltas as $delta) $ready[] = $this->resolve($base, $delta);
        }
    }

    private function work(int $bytes): void
    {
        $this->worked += $bytes;
        if ($this->worked > self::MAX_WORK) throw new GitRefused('This push is too much to read: ' . Limits::human(self::MAX_WORK) . ' of objects and more. ' . self::LATEST_ONLY);
    }

    /**
     * Refused here rather than by PHP: past memory_limit a request ends in a fatal error, which git shows as a bare
     * 500 and then "Everything up-to-date". Only a delta is held in memory, with its base. The command this ends with
     * sends no history, so no earlier copy of a file for a change to be made against.
     */
    private function haveMemory(int $bytes, string $words = 'A file in this push comes as a change to another, and putting it together needs more memory than this server gives a request. ' . self::LATEST_ONLY): void
    {
        $limit = Limits::iniBytes('memory_limit');
        if ($limit !== null && memory_get_usage(true) + $bytes + self::MEMORY_SPARE > $limit) throw new GitRefused($words);
    }

    /**
     * Every object counts, history included, and a large file is often one that was taken out of the project long
     * ago: the command this ends with leaves it behind.
     */
    private static function tooLarge(): GitRefused
    {
        return new GitRefused('A file in this push is larger than ' . Limits::human(self::MAX_OBJECT) . ', the most a file of an app can be. It may be in an earlier commit and not in the latest. ' . self::LATEST_ONLY);
    }

    public function type(string $id): ?string
    {
        return $this->objects[$id]['type'] ?? null;
    }

    public function size(string $id): int
    {
        return $this->objects[$id]['size'] ?? 0;
    }

    /** Where an object's bytes start in the spool. */
    public function offset(string $id): int
    {
        return $this->objects[$id]['offset'] ?? 0;
    }

    public function data(string $id): string
    {
        $object = $this->objects[$id] ?? null;
        if ($object === null) throw new GitRefused('This push is missing an object its files need.');
        if ($object['size'] === 0) return '';
        // Whatever is read whole is looked at first. A walk holds each folder open on its way down, and a folder can be
        // a megabyte however little of it is read.
        $this->haveMemory($object['size'], 'Reading this push needs more memory than this server gives a request.');
        fseek($this->spool, $object['offset']);
        return (string) fread($this->spool, $object['size']);
    }

    /** The spool is the largest thing a push leaves on the temp disk, and the bundle is made by now. */
    public function close(): void
    {
        if (is_resource($this->spool)) fclose($this->spool);
        TempFiles::discard($this->spoolPath);
    }

    /** @return array{0: int, 1: int} the object's type and its size as the pack declares it */
    private function objectHeader(): array
    {
        $byte = ord((string) fread($this->in, 1));
        $type = ($byte >> 4) & 7;
        $size = $byte & 15;
        $shift = 4;
        while ($byte & 0x80) {
            if ($shift > 40) throw new GitRefused("This push's pack is damaged.");
            $byte = ord((string) fread($this->in, 1));
            $size |= ($byte & 0x7f) << $shift;
            $shift += 7;
        }
        return [$type, $size];
    }

    /**
     * One object's compressed stream, up to where it ends: a pack gives no lengths, so that is known only by reading
     * it. Refused the moment it comes to more than the pack declared, so a small stream cannot expand without limit.
     */
    private function inflate(int $declared, callable $take): void
    {
        $start = (int) ftell($this->in);
        $context = inflate_init(ZLIB_ENCODING_DEFLATE);
        $seen = 0;
        while (true) {
            $slice = fread($this->in, self::SLICE);
            if ($slice === false || $slice === '') throw new GitRefused("This push's pack ends early.");
            // Only this: a spool that cannot be written is the server's trouble, not a damaged pack.
            try {
                $piece = (string) inflate_add($context, $slice, ZLIB_SYNC_FLUSH);
            } catch (ErrorException) {
                throw new GitRefused("This push's pack is damaged.");
            }
            $seen += strlen($piece);
            if ($seen > $declared) throw new GitRefused('An object in this push is larger than its pack says.');
            if ($piece !== '') $take($piece);
            if (inflate_get_status($context) === ZLIB_STREAM_END) break;
        }
        if ($seen !== $declared) throw new GitRefused('An object in this push is smaller than its pack says.');
        fseek($this->in, $start + (int) inflate_get_read_len($context));
    }

    /**
     * The object a delta makes of its base, written as it is made, its declared size checked before a byte of it is.
     *
     * @return string the object's id
     */
    private function resolve(string $base, string $delta): string
    {
        $from = $this->objects[$base];
        if ($from['depth'] >= self::MAX_DEPTH) throw new GitRefused('This push builds its objects on too long a chain.');
        $this->work($from['size']);
        // The base, beside the delta that is held already. A step adds no more than a slice to that.
        $this->haveMemory($from['size'] + self::COPY_SLICE);
        $source = $this->data($base);
        $at = 0;
        if (self::deltaNumber($delta, $at) !== strlen($source)) throw new GitRefused("This push's pack is damaged.");
        $size = self::deltaNumber($delta, $at);
        if ($size > self::MAX_OBJECT) throw self::tooLarge();
        $this->work($size);
        $this->open($from['type'], $size);
        $made = 0;
        $run = '';
        $ops = 0;
        $end = strlen($delta);
        while ($at < $end) {
            $ops++;
            $op = ord($delta[$at++]);
            if ($op & 0x80) {
                $offset = 0;
                $length = 0;
                for ($bit = 0; $bit < 4; $bit++) if ($op & (1 << $bit)) { if ($at >= $end) throw new GitRefused("This push's pack is damaged."); $offset |= ord($delta[$at++]) << (8 * $bit); }
                for ($bit = 0; $bit < 3; $bit++) if ($op & (0x10 << $bit)) { if ($at >= $end) throw new GitRefused("This push's pack is damaged."); $length |= ord($delta[$at++]) << (8 * $bit); }
                if ($length === 0) $length = 0x10000;
                if ($offset + $length > strlen($source)) throw new GitRefused("This push's pack is damaged.");
                if ($length >= self::SLICE) {
                    // A step can copy 16 MB. It goes to the spool a slice at a time, so it is never a second copy of
                    // that much of the base in memory, nor a third when it joins a run.
                    $made += $length;
                    if ($made > $size) throw new GitRefused("This push's pack is damaged.");
                    $this->work($ops * self::OP_WORK);
                    $ops = 0;
                    $this->put($run);
                    $run = '';
                    for ($copied = 0; $copied < $length; $copied += self::COPY_SLICE) $this->put(substr($source, $offset + $copied, min(self::COPY_SLICE, $length - $copied)));
                    continue;
                }
                $piece = substr($source, $offset, $length);
            } elseif ($op > 0) {
                if ($at + $op > $end) throw new GitRefused("This push's pack is damaged.");
                $piece = substr($delta, $at, $op);
                $at += $op;
            } else {
                throw new GitRefused("This push's pack is damaged.");
            }
            $made += strlen($piece);
            if ($made > $size) throw new GitRefused("This push's pack is damaged.");
            // In runs, as a delta can be millions of small pieces. Each of those costs far more than a byte of inflate,
            // so it is counted as more: a pack of little else took minutes on bytes alone.
            $run .= $piece;
            if (strlen($run) >= self::SLICE) {
                $this->work($ops * self::OP_WORK);
                $ops = 0;
                $this->put($run);
                $run = '';
            }
        }
        if ($made !== $size) throw new GitRefused("This push's pack is damaged.");
        $this->work($ops * self::OP_WORK);
        $this->put($run);
        return $this->shut($from['depth'] + 1);
    }

    private static function deltaNumber(string $delta, int &$at): int
    {
        $value = 0;
        $shift = 0;
        do {
            if ($at >= strlen($delta) || $shift > 56) throw new GitRefused("This push's pack is damaged.");
            $byte = ord($delta[$at++]);
            $value |= ($byte & 0x7f) << $shift;
            $shift += 7;
        } while ($byte & 0x80);
        return $value;
    }

    /**
     * Start on an object. Its bytes go to the spool as they are made, and are hashed as they go, so the largest object
     * costs no more memory than the smallest. Held in memory whole, one past half of memory_limit was a fatal, as PHP
     * can need a growing string twice over.
     */
    private function open(string $type, int $size): void
    {
        $this->written += $size;
        if ($this->written > self::MAX_TOTAL) throw new GitRefused('This push expands to more than ' . Limits::human(self::MAX_TOTAL) . ', its history included. ' . self::LATEST_ONLY);
        // A small pack can expand a long way, onto a disk the directory's own checks do not watch.
        if ($this->written >= $this->roomAt) {
            Config::requireRoom(self::ROOM_STEP, sys_get_temp_dir());
            $this->roomAt = $this->written + self::ROOM_STEP;
        }
        fseek($this->spool, 0, SEEK_END);
        $hash = hash_init('sha1');
        hash_update($hash, "$type $size\0");
        $this->writing = ['type' => $type, 'size' => $size, 'offset' => (int) ftell($this->spool), 'hash' => $hash];
    }

    private function put(string $bytes): void
    {
        hash_update($this->writing['hash'], $bytes);
        if (fwrite($this->spool, $bytes) !== strlen($bytes)) throw new ApiError(500, 'Could not write a temporary file.');
    }

    /** @return string the object's id; one that is here already gives its room back */
    private function shut(int $depth): string
    {
        ['type' => $type, 'size' => $size, 'offset' => $offset, 'hash' => $hash] = $this->writing;
        $id = hash_final($hash);
        if (isset($this->objects[$id])) {
            ftruncate($this->spool, $offset);
            $this->written -= $size;
        } else {
            $this->objects[$id] = ['type' => $type, 'offset' => $offset, 'size' => $size, 'depth' => $depth];
        }
        return $id;
    }

    private function checkTrailer(): void
    {
        $body = (int) ftell($this->in);
        if ($body !== $this->end - 20) throw new GitRefused("This push's pack is damaged.");
        $trailer = (string) fread($this->in, 20);
        $hash = hash_init('sha1');
        fseek($this->in, $this->start);
        $left = $body - $this->start;
        while ($left > 0) {
            $piece = (string) fread($this->in, min(65536, $left));
            if ($piece === '') break;
            hash_update($hash, $piece);
            $left -= strlen($piece);
        }
        if (!hash_equals(hash_final($hash, true), $trailer)) throw new GitRefused("This push's pack is damaged.");
    }
}

final class GitRemote
{
    private const BRANCH = 'refs/heads/main';
    private const NO_ID = '0000000000000000000000000000000000000000';
    private const CAPABILITIES = 'report-status side-band-64k no-thin object-format=sha1 agent=softn-directory';
    private const MAX_DEPTH = 64;
    /** Every name met in a walk. A tree can name another twice, so the walk is what has to be counted, not the files. */
    private const MAX_WALKED = 2 * Bundle::MAX_ENTRIES;
    /** One folder. Each of the open folders of a walk is in memory, and a folder of a bundle's most files is far less. */
    private const MAX_TREE = 1024 * 1024;
    /** Past this, zip's 16-bit name length would store something other than the name that was checked. */
    private const MAX_PATH = 4096;
    /** Folders looked in for an app's manifest.json when the top has none. */
    private const MAX_SEARCHED = 1024;
    /** The most of a line said in the terminal, in bytes. */
    private const LINE = 1000;
    /** The http.postBuffer the commands on the site set. */
    private const POST_BUFFER = 64 * 1024 * 1024;
    private const NOT_LFS = 'An app is published with its own files: take them out of LFS (git lfs migrate export, as the publishing guide shows), or publish from the app\'s update page.';
    /** Files that hold someone's credentials: everything published can be read by anyone. */
    private const SECRETS = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.git-credentials', '.npmrc', '.netrc', '.pgpass'];

    /** `GET /git/{slug}/info/refs`: what git asks first. */
    public static function advertise(Request $req, string $given): Response
    {
        $service = $req->query['service'] ?? null;
        if ($service === 'git-upload-pack') {
            // Git says this to the person as it is: "remote error: …". A clone and a fetch ask the same, and a fetch is
            // most often a branch that was set to pull from here, as git itself suggests for a push with no refspec.
            return self::bytes('application/x-git-upload-pack-advertisement', self::pkt("# service=git-upload-pack\n") . '0000' . self::pkt("ERR This directory takes pushes, and does not serve clones, fetches or pulls. An app's source can be downloaded from its page. If git pull brought you here, your branch is set to pull from the directory, and git branch --unset-upstream stops that.\n"));
        }
        if ($service !== 'git-receive-pack') throw new ApiError(404, 'Git speaks to this address with ?service=git-receive-pack.');
        $slug = Apps::resolveSlug($given);
        $refused = self::admit($req, $slug);
        if ($refused !== null) return $refused;
        return self::bytes('application/x-git-receive-pack-advertisement', self::pkt("# service=git-receive-pack\n") . '0000' . self::pkt(self::NO_ID . " capabilities^{}\0" . self::CAPABILITIES . "\n") . '0000');
    }

    /** `POST /git/{slug}/git-receive-pack`: the push. */
    public static function receive(Request $req, string $given): Response
    {
        $slug = Apps::resolveSlug($given);
        $refused = self::admit($req, $slug);
        if ($refused !== null) return $refused;
        // The key is good, and everything from here takes as long as the push does: the catalogue is let go, as a
        // new version's upload is read outside it, and taken again to record the version.
        Catalog::release();
        try {
            // Counted before the body is read, as on the versions route, and whatever the push turns out to be. Git's
            // probe before a large body is not a push.
            if ($req->declaredLength() !== 4) Db::rateLimit('version', Config::publishKey($req->ip));
            $body = $req->bodyFile(Limits::bundleEnvelope(), 'This push');
        } catch (ApiError $e) {
            // Git shows the status of a failed request and none of its words, so this is said the way it does show.
            // A push too large is mostly its history, which the latest files alone leave behind.
            return self::told($e->status === 413 ? $e->getMessage() . ' ' . GitPack::LATEST_ONLY : $e->getMessage());
        } catch (Throwable $e) {
            return self::told(self::trouble($e));
        }
        $size = (int) filesize($body);
        $in = fopen($body, 'rb');
        if ($in === false) throw new ApiError(500, 'Could not read a temporary file.');
        try {
            // Before a large body git asks with a flush alone, to see that it will be heard.
            if ($size === 4 && fread($in, 4) === '0000') return self::bytes('application/x-git-receive-pack-result', '');
            // A body in chunks has no length, and PHP behind Apache's FastCGI or CGI is handed none of it. Told by its
            // emptiness and not by Transfer-Encoding, which HTTP/2 has no such header for: git has nothing else to say
            // by a push with nothing in it. Do not cure this with proxy-sendcl: see "The host" in the README.
            if ($size === 0) return self::told(self::notHandedTheBody());
            rewind($in);
            return self::answer($req, $slug, $in, $size);
        } finally {
            fclose($in);
        }
    }

    /**
     * What a push hears when it came in pieces and PHP was handed none of it. The commands git is given set
     * http.postBuffer, so git itself sends pieces only past it. While that is more than a push may be, telling the
     * person to set it again would send them round in a circle, so they are told what does fit.
     */
    private static function notHandedTheBody(): string
    {
        $words = 'This server could not read a push sent in pieces, which is how git sends one larger than its http.postBuffer. Run this once in the project and push again: git config http.postBuffer 64M. Some git tools always send pieces, and cannot publish to this server: use git, or the app\'s update page.';
        if (Limits::bundleEnvelope() < self::POST_BUFFER) $words .= ' If http.postBuffer is set already, this push is past 64 MB, more than the directory takes. ' . GitPack::LATEST_ONLY;
        return $words;
    }

    /**
     * `POST /git/{slug}/info/lfs/objects/batch`: where git-lfs sends a project's large files before the push itself.
     * None are kept here. git-lfs shows the `message` of its answer, where it would otherwise say "Repository or
     * object not found" and to check the access, which is not what is wrong. Nothing is looked up: it is the same for
     * every app, and for one that is not there.
     */
    public static function lfs(): Response
    {
        $words = 'This directory does not take files kept in Git LFS: git sends pointers to them, and not the files. ' . self::NOT_LFS;
        return Response::json(['ok' => false, 'error' => $words, 'message' => $words], 404);
    }

    /**
     * Who may push. A wrong key is counted; no key is not, as git always asks once without one and once more with
     * the username alone before it looks for the password.
     */
    private static function admit(Request $req, string $slug): ?Response
    {
        $key = $req->basicPassword();
        if ($key !== null && $key !== '') {
            if (Apps::keyOpens($slug, $key)) {
                Apps::requireBundle($slug);
                return null;
            }
            Db::rateLimit('gitKey', Config::limitKey($req->ip));
        }
        $asked = Response::bytes("That needs this app's edit key, as the password.\n", 'text/plain; charset=utf-8', ['WWW-Authenticate' => 'Basic realm="SoftN directory"', 'Cache-Control' => 'no-store']);
        $asked->status = 401;
        return $asked;
    }

    /** @param resource $in */
    private static function answer(Request $req, string $slug, $in, int $size): Response
    {
        try {
            [$commands, $capabilities] = self::commands($in);
        } catch (ApiError $e) {
            return self::told($e->getMessage());
        }
        $start = (int) ftell($in);
        $said = [];
        $statuses = [];
        foreach ($commands as $command) {
            $ref = $command['ref'];
            try {
                if ($ref !== self::BRANCH) throw new GitRefused(str_starts_with($ref, 'refs/heads/') ? 'Only main is published. Push your branch to it: git push softn HEAD:main' : 'Only main is published. Tags and other refs are not kept.');
                if ($command['new'] === self::NO_ID) throw new GitRefused('A push does not delete an app. Unpublish it from its page.');
                $said[] = self::publish($req, $slug, $in, $start, $size, $command['new']);
                $statuses[] = "ok $ref\n";
            } catch (GitRefused | ApiError $e) {
                $said[] = $e->getMessage();
                $statuses[] = "ng $ref not published\n";
            } catch (Throwable $e) {
                $said[] = self::trouble($e);
                $statuses[] = "ng $ref not published\n";
            }
        }
        $report = self::pkt("unpack ok\n");
        foreach ($statuses as $status) $report .= self::pkt($status);
        $report .= '0000';
        if (!in_array('side-band-64k', $capabilities, true)) return self::bytes('application/x-git-receive-pack-result', $report);
        $out = '';
        foreach ($said as $words) $out .= self::say($words);
        foreach (str_split($report, 60000) as $piece) $out .= self::pkt("\x01" . $piece);
        return self::bytes('application/x-git-receive-pack-result', $out . '0000');
    }

    /**
     * What to say of something that went wrong here and is not about the push. A plain 500 reaches the person as
     * "RPC failed" and then git's "Everything up-to-date", which reads as though the push had gone through. What it
     * was goes to the log, as a server's paths have no business in someone's terminal.
     */
    private static function trouble(Throwable $e): string
    {
        // As index.php logs a failure: what and where, and no trace, whose arguments can hold the key.
        error_log('softn-api: a push failed: ' . get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
        return 'The directory could not take this push just now, and nothing was published. Try again later.';
    }

    /**
     * A line for the terminal. It can carry a file's name, which can hold anything a terminal acts on: the controls
     * of both C0 and C1 are masked, those of C1 as bytes and as characters, after any bytes that are not UTF-8 are.
     */
    private static function say(string $words): string
    {
        $text = mb_scrub(mb_strcut($words, 0, self::LINE), 'UTF-8');
        return self::pkt("\x02" . (string) preg_replace('/[\x{00}-\x{1f}\x{7f}-\x{9f}]/u', '?', $text) . "\n");
    }

    /**
     * All a push gets when its body was not read: the reason, and a report that it failed. The refs are in the body,
     * so none can be named, and with no report at all some clients say the push succeeded.
     */
    private static function told(string $words): Response
    {
        return self::bytes('application/x-git-receive-pack-result', self::say($words) . self::pkt("\x01" . self::pkt("unpack not read\n") . '0000') . '0000');
    }

    /**
     * The commit, as a bundle, as a new version: room, the bundle's checks and then the catalogue, in the order the
     * versions route has them. This takes the catalogue and holds it to the end of the request, so nothing slow can
     * follow it, which is why `commands` lets a ref be named only once.
     *
     * @param resource $in
     * @return string what to tell the person
     */
    private static function publish(Request $req, string $given, $in, int $start, int $size, string $commit): string
    {
        $pack = new GitPack($in, $start, $size);
        try {
            $pack->read();
            [$tree, $subject] = self::commit($pack, $commit);
            self::requireManifest($pack, $tree);
            $files = [];
            $walked = 0;
            self::walk($pack, $tree, '', 0, $files, $walked);
            $bundle = self::bundle($pack, $files);
        } finally {
            $pack->close();
        }
        // The index of every object and the name of every file are let go: inspect makes its own of the names.
        unset($pack, $files);
        Config::requireRoom((int) filesize($bundle));
        $info = Bundle::inspect($bundle);
        $slug = Apps::resolveSlug($given);
        // A key replaced while the push was on its way is no longer good.
        if (!Apps::keyOpens($slug, (string) $req->basicPassword())) throw new GitRefused("This app's edit key has changed.");
        Apps::requireBundle($slug);
        $page = (Pages::origin() ?? Cors::requestOrigin() ?? '') . '/app/' . rawurlencode($slug);
        $latest = Apps::version($slug);
        if ($latest['sha256'] === $info['sha256']) return "Already published as version {$latest['version']}: $page";
        $app = Apps::addVersion($slug, $bundle, $subject, false, $info);
        $words = "Published version {$app['version']}: $page";
        $dropped = $app['droppedVersions'] ?? [];
        // Not "the oldest": version 1 is older, and stays. And no number: one goes a version, so an app over a limit the
        // operator lowered keeps more than it says until it is down to it (Apps::addVersion). As the site says it.
        if ($dropped !== []) $words .= ". To make room, version {$dropped[0]} was removed: an app keeps its first version and its latest ones.";
        return $words;
    }

    /**
     * What was asked for, from the pkt-lines before the pack.
     *
     * @param resource $in
     * @return array{0: list<array{new: string, ref: string}>, 1: list<string>}
     */
    private static function commands($in): array
    {
        $commands = [];
        $capabilities = [];
        while (($line = self::readPkt($in)) !== null) {
            // A shallow clone says where its history stops. Only the commit pushed is read, so nothing hangs on it.
            if (str_starts_with($line, 'shallow ')) continue;
            if (count($commands) >= 16) throw new ApiError(400, 'That push names too many refs, and only main is published. Push that alone: git push softn HEAD:main');
            $nul = strpos($line, "\0");
            if ($nul !== false) {
                $capabilities = array_values(array_filter(explode(' ', trim(substr($line, $nul + 1)))));
                $line = substr($line, 0, $nul);
            }
            if (!preg_match('#^[0-9a-f]{40} ([0-9a-f]{40}) (refs/\S+)\n?$#D', $line, $m)) throw new ApiError(400, 'That is not a push git would send.');
            if (isset($commands[$m[2]])) throw new ApiError(400, 'That is not a push git would send.');
            $commands[$m[2]] = ['new' => $m[1], 'ref' => $m[2]];
        }
        return [array_values($commands), $capabilities];
    }

    /**
     * One pkt-line; null for a flush.
     *
     * @param resource $in
     */
    private static function readPkt($in): ?string
    {
        $head = (string) fread($in, 4);
        if (strlen($head) !== 4 || !ctype_xdigit($head)) throw new ApiError(400, 'That is not a push git would send.');
        $length = (int) hexdec($head);
        if ($length === 0) return null;
        if ($length <= 4) throw new ApiError(400, 'That is not a push git would send.');
        return (string) fread($in, $length - 4);
    }

    /**
     * The commit's tree, and the subject of its message as git shows it: the first paragraph, on one line, in UTF-8
     * from the encoding the commit names, if it names one.
     *
     * @return array{0: string, 1: string}
     */
    private static function commit(GitPack $pack, string $id): array
    {
        if ($pack->type($id) !== 'commit') throw new GitRefused('Only a branch of commits is published.');
        $text = $pack->data($id);
        if (!preg_match('/^tree ([0-9a-f]{40})\n/', $text, $m)) throw new GitRefused('This push has a commit that cannot be read.');
        $blank = strpos($text, "\n\n");
        // A version's notes are short, and a commit's message need not be.
        $message = $blank === false ? '' : substr($text, $blank + 2, 4096);
        $paragraph = preg_split('/\n[ \t]*\n/', ltrim($message, "\n"), 2)[0];
        // Found in place: the headers can be most of a large commit, and a copy of them would be a second one.
        $named = strpos($text, "\nencoding ");
        $encoding = $named === false || ($blank !== false && $named > $blank) ? 'UTF-8' : substr($text, $named + 10, min(64, max(0, (int) strpos($text, "\n", $named + 1) - $named - 10)));
        if (strcasecmp($encoding, 'UTF-8') !== 0) {
            try {
                $paragraph = mb_convert_encoding($paragraph, 'UTF-8', $encoding);
            } catch (ValueError | ErrorException) {
                // An encoding PHP does not know: Text::clean makes what is not UTF-8 safe.
            }
        }
        return [$m[1], trim((string) preg_replace('/[ \t]*\n[ \t]*/', ' ', $paragraph))];
    }

    /**
     * The files of a tree, by their path in the bundle. What a repository holds for git and not for the app is left
     * out; a link or a submodule points outside what is being published, and a file that holds secrets is on its way
     * to being public, and both are refused.
     *
     * @param array<string, string> $files
     */
    private static function walk(GitPack $pack, string $id, string $prefix, int $depth, array &$files, int &$walked): void
    {
        if ($depth > self::MAX_DEPTH) throw new GitRefused('This project is more than ' . self::MAX_DEPTH . ' folders deep.');
        if ($pack->type($id) !== 'tree') throw new GitRefused('This push is missing a folder of its project. Pushing the whole branch from a full clone puts it right.');
        if ($pack->size($id) > self::MAX_TREE) throw new GitRefused("The folder $prefix has more files than a bundle can hold.");
        foreach (self::entries($pack, $id) as [$mode, $name, $object]) {
            if (++$walked > self::MAX_WALKED) throw new GitRefused('This project has more than ' . self::MAX_WALKED . ' files and folders.');
            $path = $prefix . $name;
            if (strlen($path) > self::MAX_PATH) throw new GitRefused('This project has a file with a path of more than ' . self::MAX_PATH . ' bytes.');
            if ($name === '.DS_Store' || ($prefix === '' && str_starts_with($name, '.git'))) continue;
            // An empty name is asked about here: in a folder its path ends in "/", which unsafeName takes for a folder.
            if ($name === '' || !mb_check_encoding($path, 'UTF-8') || str_contains($name, '/') || str_contains($name, '\\') || Bundle::unsafeName($path)) throw new GitRefused("This project has a file with a name a bundle cannot hold: $path");
            if (self::isFolder($mode)) {
                self::walk($pack, $object, "$path/", $depth + 1, $files, $walked);
                continue;
            }
            if ($mode === '120000') throw new GitRefused("$path is a symbolic link. A published app holds its files, so replace it with the file.");
            if ($mode === '160000') throw new GitRefused("$path is a submodule. A published app holds its files, so copy them in.");
            if ($mode !== '100644' && $mode !== '100755' && $mode !== '100664') throw new GitRefused("$path is not a file a bundle can hold.");
            if (self::looksSecret($name)) throw new GitRefused("$path looks like it holds secrets, and everything published is public. Take it out of the commit, with git rm --cached if you need to keep the file.");
            if ($pack->type($object) !== 'blob') throw new GitRefused("This push is missing $path. Pushing the whole branch from a full clone puts it right.");
            if (self::lfsPointer($pack, $object)) throw new GitRefused("$path is kept in Git LFS, so git sends a pointer to it and not the file. " . self::NOT_LFS);
            if (count($files) >= Bundle::MAX_ENTRIES) throw new GitRefused('This project has more than ' . Bundle::MAX_ENTRIES . ' files.');
            $files[$path] = $object;
        }
    }

    /**
     * A folder's entries: each one's mode, name and object. The caller has seen that the folder is here, and no larger
     * than one may be.
     *
     * @return Generator<int, array{0: string, 1: string, 2: string}>
     */
    private static function entries(GitPack $pack, string $id): Generator
    {
        $tree = $pack->data($id);
        $at = 0;
        $end = strlen($tree);
        while ($at < $end) {
            $space = strpos($tree, ' ', $at);
            $nul = $space === false ? false : strpos($tree, "\0", $space);
            if ($nul === false || $nul + 21 > $end) throw new GitRefused('This push has a folder that cannot be read.');
            $entry = [substr($tree, $at, $space - $at), substr($tree, $space + 1, $nul - $space - 1), bin2hex(substr($tree, $nul + 1, 20))];
            $at = $nul + 21;
            yield $entry;
        }
    }

    /** Some older tools wrote a folder's mode with a leading zero, and git reads it all the same. */
    private static function isFolder(string $mode): bool
    {
        return $mode === '40000' || $mode === '040000';
    }

    /**
     * Asked before the walk: an app is often one folder of a repository that holds other things, and what is wrong
     * with those is no business of the app's. Bundle::inspect would say only that the bundle has no manifest.json.
     */
    private static function requireManifest(GitPack $pack, string $tree): void
    {
        if ($pack->type($tree) !== 'tree' || $pack->size($tree) > self::MAX_TREE) return;
        foreach (self::entries($pack, $tree) as [$mode, $name]) if ($name === 'manifest.json' && !self::isFolder($mode)) return;
        $folders = self::appFolders($pack, $tree);
        if ($folders === []) throw new GitRefused('This commit has no manifest.json in its top folder, which is where an app has it.');
        $words = 'This commit has no manifest.json in its top folder, and ' . implode(', ', array_map(static fn($f) => "$f/", array_slice($folders, 0, 3))) . (count($folders) > 1 ? ' have one.' : ' has one.');
        // A folder's name goes into a command to be pasted, inside double quotes, so only a plain one: no $, `, \, " or
        // ! that a shell acts on there, and nothing a terminal shows otherwise than it is.
        $folder = $folders[0];
        if (!preg_match('#^[A-Za-z0-9_][A-Za-z0-9._ -]*(/[A-Za-z0-9_][A-Za-z0-9._ -]*)*$#D', $folder)) throw new GitRefused("$words Publish that folder on its own.");
        if (count($folders) > 1) $words .= ' Each app is its own remote, with its own key.';
        $line = "$words To publish $folder/ alone: git push softn \"\$(git commit-tree \"HEAD:$folder\" -m Publish):refs/heads/main\"";
        // Past what the terminal is given, the line would be cut, and a command cut short does not run.
        if (strlen($line) > self::LINE) throw new GitRefused("$words Publish that folder on its own.");
        throw new GitRefused($line);
    }

    /**
     * The folders nearest the top that hold a manifest.json, a level at a time. Each folder is read once however often
     * it is named, and no more entries are read than a walk may. The path of each folder still to be looked in is
     * held, so a path is held to what a walk allows, and the folders to a number: a name can be most of a megabyte,
     * and a folder of such names would otherwise be that many times over.
     *
     * @return list<string>
     */
    private static function appFolders(GitPack $pack, string $tree): array
    {
        $level = [[$tree, '']];
        $seen = [$tree => true];
        $read = 0;
        $found = [];
        // A level is finished once begun, as what it finds is nearer the top than anything below it: a committed
        // node_modules beside the app's folder can fill the folders to look in, and the app's is still named.
        for ($depth = 0; $level !== [] && $depth < self::MAX_DEPTH && $found === []; $depth++) {
            $next = [];
            foreach ($level as [$id, $prefix]) {
                foreach (self::entries($pack, $id) as [$mode, $name, $object]) {
                    if (++$read > self::MAX_WALKED) break 3;
                    if (strlen($prefix) + strlen($name) > self::MAX_PATH) continue;
                    if ($prefix !== '' && $name === 'manifest.json' && !self::isFolder($mode)) $found[rtrim($prefix, '/')] = true;
                    if (!self::isFolder($mode) || isset($seen[$object]) || $pack->type($object) !== 'tree' || $pack->size($object) > self::MAX_TREE) continue;
                    if ($prefix === '' && str_starts_with($name, '.git')) continue;
                    if (count($seen) > self::MAX_SEARCHED) continue;
                    $seen[$object] = true;
                    $next[] = [$object, "$prefix$name/"];
                }
            }
            // Past the most folders, the next level would be some of them and not all.
            $level = count($seen) > self::MAX_SEARCHED ? [] : $next;
        }
        $folders = array_map('strval', array_keys($found));
        sort($folders, SORT_STRING);
        return $folders;
    }

    /**
     * What Git LFS commits in place of a file: a few lines naming it, under 1024 bytes, that begin with the version of
     * the spec. Published, it would be the text of the pointer where a picture should be, and the push would say it
     * went through. A push that git-lfs is set up for stops before this, at `lfs()`.
     */
    private static function lfsPointer(GitPack $pack, string $id): bool
    {
        $size = $pack->size($id);
        if ($size < 64 || $size >= 1024) return false;
        $text = $pack->data($id);
        return (str_starts_with($text, "version https://git-lfs.github.com/spec/v1\n") || str_starts_with($text, "version https://hawser.github.com/spec/v1\n")) && str_contains($text, "\noid ");
    }

    private static function looksSecret(string $name): bool
    {
        $name = strtolower($name);
        if ($name === '.env' || (str_starts_with($name, '.env.') && !preg_match('/\.(example|sample|template|dist)$/D', $name))) return true;
        return in_array($name, self::SECRETS, true) || preg_match('/\.(pem|p12|pfx)$/D', $name) === 1;
    }

    /**
     * The files as a .softn, written the same way each time: names in order and one date, so a push of the same
     * files makes the same bundle, and is no new version.
     *
     * @param array<string, string> $files path to object id
     */
    private static function bundle(GitPack $pack, array $files): string
    {
        if ($files === []) throw new GitRefused('This commit has no files.');
        ksort($files, SORT_STRING);
        $total = 0;
        foreach ($files as $id) $total += $pack->size($id);
        if ($total > Bundle::MAX_UNCOMPRESSED) throw new GitRefused('The files of this commit come to more than ' . Limits::human(Bundle::MAX_UNCOMPRESSED) . '.');
        $path = TempFiles::create();
        $zip = new ZipArchive();
        if ($zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) throw new ApiError(500, 'Could not write a temporary file.');
        $when = mktime(0, 0, 0, 1, 1, 2000);
        foreach ($files as $name => $id) {
            $name = (string) $name;
            $size = $pack->size($id);
            // A length of 0 is "to the end of the file" to addFile.
            $added = $size === 0 ? $zip->addFromString($name, '', ZipArchive::FL_ENC_UTF_8) : $zip->addFile($pack->spoolPath(), $name, $pack->offset($id), $size, ZipArchive::FL_ENC_UTF_8);
            if (!$added) throw new ApiError(500, 'Could not write a temporary file.');
            $zip->setMtimeName($name, $when);
        }
        if (!$zip->close()) throw new ApiError(500, 'Could not write a temporary file.');
        clearstatcache(true, $path);
        if ((int) filesize($path) > Limits::bundle()) throw new GitRefused('This project comes to more than ' . Limits::human(Limits::bundle()) . ' as a bundle, the most the directory takes.');
        return $path;
    }

    private static function pkt(string $text): string
    {
        return sprintf('%04x', strlen($text) + 4) . $text;
    }

    private static function bytes(string $type, string $body): Response
    {
        return Response::bytes($body, $type, ['Cache-Control' => 'no-store']);
    }
}
