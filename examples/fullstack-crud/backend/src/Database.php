<?php
namespace App;

use PDO;

/** Central SQLite PDO factory with strict exception mode. */
class Database
{
    public static function connect($dsn = 'sqlite:db/app.db')
    {
        $pdo = new PDO($dsn);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        return $pdo;
    }

    /** Extract an error message across both standard PHP 8.x and zipp-php.wasm PDOException objects. */
    public static function errorMessage($err)
    {
        if (is_object($err)) {
            if (method_exists($err, 'getMessage')) {
                return (string) $err->getMessage();
            }
            if (isset($err->message)) {
                return (string) $err->message;
            }
        }
        return 'Database error';
    }
}
