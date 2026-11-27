<?php
// Pre-bundled PSR-4 autoloader (generated offline; SoftN runs bundles without runtime Composer execution).
spl_autoload_register(function ($class) {
    $prefixes = [
        'App\\' => __DIR__ . '/../src/',
        'SlimCompat\\' => __DIR__ . '/slim-compat/',
    ];
    foreach ($prefixes as $prefix => $baseDir) {
        $len = strlen($prefix);
        if (strncmp($prefix, $class, $len) !== 0) {
            continue;
        }
        $relative = substr($class, $len);
        $file = $baseDir . str_replace('\\', '/', $relative) . '.php';
        if (file_exists($file)) {
            require_once $file;
            return;
        }
    }
});
