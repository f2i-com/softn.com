This private directory holds the app catalogue and app-owned data:

  config.json               settings, visitor-hash salt and ADMIN KEY
  catalog.lock              stable cross-process lock; never delete while serving
  sequences.json            monotonic comment identifier allocation
  categories.json           category definitions
  ratelimits.json           expiring request-limit windows
  cache/bundles.json        rebuildable bundle inspection cache
  apps/<slug>/app.json      listing, versions, plays, comments, ratings and edit hash
  apps/<slug>/*.softn       versioned bundles, discovered automatically
  apps/<slug>/icon.*, thumb.*  pictures
  apps/<slug>/storage.sqlite  optional app-owned saved data (not directory metadata)
  directory-migrated.json   present after importing a legacy catalogue
  directory.sqlite         retained legacy backup only; not created by new installs

Copy a named app folder into apps/ to add it. Use v1.softn, v2.softn, etc.
JSON is generated on first discovery; see ../README.md for a minimal app.json.
For concurrent updates, use the API. Manual JSON edits and consistent backups
must also hold catalog.lock or be made while API requests are stopped.

PHP must be able to write here. The web server must never serve this folder:
.htaccess and the site's rules refuse it. Keep keys and private metadata safe.
