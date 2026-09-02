<?php
/**
 * What the directory learns from a .softn before it agrees to keep it.
 *
 * A bundle is a zip: manifest.json with a name, a version and an entry file;
 * optionally permission.json, which is the app's own declaration of what it
 * will ask the runtime for, and an icon. The archive is read in place and
 * never extracted here — the runtime does its own reading, with its own
 * limits, on the client — so the checks below are about what the directory
 * is willing to store and show, not about what the bundle can do.
 */
declare(strict_types=1);

final class Bundle
{
    public const MAX_ENTRIES = 4000;
    public const MAX_UNCOMPRESSED = 128 * 1024 * 1024;
    public const MAX_ICON_BYTES = 512 * 1024;
    /** What the runtime asks the visitor to allow; the order the app page lists them in. */
    public const CAPABILITIES = ['net', 'camera', 'mic', 'files', 'qr', 'ai', 'gpu', 'sync', 'storage'];

    /**
     * @return array{
     *   manifest: array<string, mixed>, name: string, version: string, description: string,
     *   capabilities: string[], execution: string, icon: array{0: string, 1: string}|null,
     *   size: int, sha256: string, entries: int
     * }
     */
    public static function inspect(string $path): array
    {
        if (!class_exists('ZipArchive')) throw new ApiError(503, 'This server\'s PHP has no zip extension, which the directory needs to read bundles.');
        $size = (int) filesize($path);
        if ($size < 22) throw new ApiError(400, 'That is not a .softn bundle.');
        $zip = new ZipArchive();
        $opened = $zip->open($path, ZipArchive::RDONLY);
        if ($opened !== true) throw new ApiError(400, 'That is not a .softn bundle: the archive does not open.');
        try {
            $count = $zip->numFiles;
            if ($count === 0) throw new ApiError(400, 'The bundle is empty.');
            if ($count > self::MAX_ENTRIES) throw new ApiError(400, 'The bundle has more than ' . self::MAX_ENTRIES . ' files.');
            $total = 0;
            for ($i = 0; $i < $count; $i++) {
                $stat = $zip->statIndex($i);
                if ($stat === false) throw new ApiError(400, 'The bundle has an unreadable entry.');
                $name = (string) $stat['name'];
                if ($name === '' || str_contains($name, '\\') || str_starts_with($name, '/') || preg_match('#(^|/)\.\.(/|$)#', $name)) {
                    throw new ApiError(400, "The bundle has an entry with an unsafe path: $name");
                }
                if ((int) $stat['encryption_method'] !== ZipArchive::EM_NONE) throw new ApiError(400, 'The bundle has an encrypted entry.');
                $total += (int) $stat['size'];
                if ($total > self::MAX_UNCOMPRESSED) throw new ApiError(400, 'The bundle expands to more than 128 MB.');
            }
            $manifestText = $zip->getFromName('manifest.json');
            if ($manifestText === false) throw new ApiError(400, 'The bundle has no manifest.json.');
            $manifest = json_decode($manifestText, true, 32);
            if (!is_array($manifest)) throw new ApiError(400, 'The bundle\'s manifest.json is not valid JSON.');
            $name = Text::clean(is_string($manifest['name'] ?? null) ? $manifest['name'] : '', 64);
            if ($name === '') throw new ApiError(400, 'The manifest has no name.');
            $version = Text::clean(is_string($manifest['version'] ?? null) ? $manifest['version'] : '', 32);
            if ($version === '') throw new ApiError(400, 'The manifest has no version.');
            $main = is_string($manifest['main'] ?? null) ? $manifest['main'] : '';
            if ($main === '') throw new ApiError(400, 'The manifest names no entry file (main).');
            if ($zip->locateName($main) === false) throw new ApiError(400, "The manifest's entry file is not in the bundle: $main");
            $description = Text::clean(is_string($manifest['description'] ?? null) ? $manifest['description'] : '', 600, true);

            $capabilities = [];
            $permText = $zip->getFromName('permission.json');
            if ($permText !== false) {
                $perm = json_decode($permText, true, 16);
                $declared = is_array($perm) && is_array($perm['permissions'] ?? null) ? $perm['permissions'] : [];
                foreach (self::CAPABILITIES as $cap) {
                    $entry = $declared[$cap] ?? null;
                    if (is_array($entry) && !empty($entry['enabled'])) $capabilities[] = $cap;
                }
            }
            $execution = 'main';
            $config = is_array($manifest['config'] ?? null) ? $manifest['config'] : [];
            if (($config['execution'] ?? null) === 'worker') $execution = 'worker';

            $icon = null;
            $iconPath = is_string($manifest['icon'] ?? null) ? $manifest['icon'] : '';
            if ($iconPath !== '' && $zip->locateName($iconPath) !== false) {
                $stat = $zip->statName($iconPath);
                if ($stat !== false && (int) $stat['size'] <= self::MAX_ICON_BYTES) {
                    $bytes = $zip->getFromName($iconPath);
                    if (is_string($bytes)) {
                        $mime = Images::sniff($bytes);
                        if ($mime === null && preg_match('/\.svg$/i', $iconPath) && self::looksLikeSvg($bytes)) $mime = 'image/svg+xml';
                        if ($mime !== null) $icon = [$bytes, $mime];
                    }
                }
            }
        } finally {
            $zip->close();
        }
        return [
            'manifest' => $manifest,
            'name' => $name,
            'version' => $version,
            'description' => $description,
            'capabilities' => $capabilities,
            'execution' => $execution,
            'icon' => $icon,
            'size' => $size,
            'sha256' => hash_file('sha256', $path) ?: '',
            'entries' => $count,
        ];
    }

    /**
     * An SVG is served back as an image, so it has to be one, and one with no
     * script in it: the icon is shown on the directory's own origin.
     */
    private static function looksLikeSvg(string $bytes): bool
    {
        $head = substr($bytes, 0, 2048);
        if (!preg_match('/<svg[\s>]/i', $head)) return false;
        if (preg_match('/<script|on[a-z]+\s*=|javascript:|<foreignObject|<iframe|<embed|<object/i', $bytes)) return false;
        return true;
    }

    /**
     * The bundle's files, for reading on the app page: every path, with the
     * text of the ones a person would read. Binary files and anything past
     * the size caps are listed without content.
     *
     * @return array{files: array<int, array{path: string, size: int, text: string|null}>, truncated: bool}
     */
    public static function listSource(string $path): array
    {
        $zip = new ZipArchive();
        if ($zip->open($path, ZipArchive::RDONLY) !== true) throw new ApiError(500, 'The stored bundle does not open.');
        $files = [];
        $budget = 2 * 1024 * 1024;
        $truncated = false;
        try {
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $stat = $zip->statIndex($i);
                if ($stat === false) continue;
                $name = (string) $stat['name'];
                if ($name === '' || str_ends_with($name, '/')) continue;
                $size = (int) $stat['size'];
                $text = null;
                if (preg_match('/\.(ui|logic|json|md|txt|css|js|ts|html|svg|csv|xml|yml|yaml|toml|ini)$/i', $name) && $size <= 256 * 1024 && $budget > 0) {
                    $bytes = $zip->getFromIndex($i);
                    if (is_string($bytes) && mb_check_encoding($bytes, 'UTF-8')) {
                        $text = $bytes;
                        $budget -= strlen($bytes);
                    }
                } elseif ($size > 256 * 1024 || $budget <= 0) {
                    $truncated = true;
                }
                $files[] = ['path' => $name, 'size' => $size, 'text' => $text];
            }
        } finally {
            $zip->close();
        }
        usort($files, fn($a, $b) => strcmp($a['path'], $b['path']));
        return ['files' => $files, 'truncated' => $truncated];
    }
}
