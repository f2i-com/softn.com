# Full-Stack CRUD Profile (React + TypeScript + PHP Slim + SQLite)

Official reference profile for generated full-stack SoftN v2 applications (e.g. from CRUD.software or other SoftN app builders).

## Architecture

- **Frontend (`public/`)**: Uncompiled React + TypeScript (`.tsx`) executed directly by SoftN's TypeScript/JSX container tier with `useState`, `useEffect`, `useMemo`, controlled inputs, CSS imports, and relative `fetch('/api/...')` calls.
- **Backend (`backend/`)**: PHP 8.x SAPI backend running inside `zipp-php.wasm`, using a pre-bundled PSR-4 autoloader (`backend/vendor/autoload.php`), PSR-7 compatible `ServerRequest`/`Response`, Slim-compatible routing (`GET`/`POST`/`PATCH`/`DELETE`), authorization/validation middleware, and parameterized PDO SQLite queries with atomic transactions. No runtime Composer execution is required.
- **Database (`db/app.db`)**: Managed by XDB SQLite (`xdb-wasm.wasm`) with initial schema (`backend/schema.sql`) and declarative versioned migrations (`backend/migrations/002_add_notes_and_priority.sql`, `schemaVersion: 2`).

## Precision & Portability Notes

- **64-bit Integers in PHP WASM**: Inside `zipp-php.wasm`, native PHP integers are backed by IEEE-754 float64 (~53-bit exact precision). Store/cast >53-bit identifiers as `TEXT` (e.g. `CAST(id AS TEXT)` or `TEXT` columns such as `external_ref_id`) when returning JSON from PHP so values like `9007199254740993` and `9223372036854775807` round-trip losslessly.
- **Exception Handling in PHP WASM**: Catch `\PDOException` explicitly alongside `\Exception` (and wrap into `new \Exception($e->getMessage())` if rethrowing) for guaranteed transaction rollback handling inside `zipp-php.wasm`.
- **Financial Decimals**: Store currency/decimal values as exact `TEXT` strings (`"12450.7500"`) rather than SQLite `REAL` floats.
- **Zero External Network Access**: `permission.json` declares `{ "permissions": {} }`; frontend `fetch('/api/...')` calls stay strictly inside the local backend worker (or FormLogic's authenticated MessagePort transport).
