<?php
declare(strict_types=1);
// The private directory holds the .softn archive, serve.config.php, the
// shell template and the generated viewer secret. Keep it outside every
// public document root. Set the path here if it is not a sibling of this
// folder.
$private = dirname(__DIR__) . '/private';
require __DIR__ . '/softn-serve.php';
