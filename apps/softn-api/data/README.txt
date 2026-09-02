This directory holds everything the softn.com directory keeps:

  config.json          site settings, the visitor-hash salt and the ADMIN KEY
  directory.sqlite     the catalogue: apps, versions, comments, ratings, categories
  apps/<slug>/         one directory per published app
    v1.softn, v2...    every version ever published, unchanged
    icon.*, thumb.*    its pictures
    storage.sqlite     the app's own data, created the first time it stores something
  seeded               present once the demo bundles have been published

PHP must be able to write here. It is never served: the .htaccess beside this
file refuses every request, and the site's own rules refuse them first.

Back the site up by copying this directory. Move it by copying it. Reset the
directory by emptying it; the demos are published again on the next request.
