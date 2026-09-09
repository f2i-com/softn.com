// What dist/private is made of: the shell template index.php renders, the
// sample bundle and the sample configuration. Pure; assemble.mjs writes them.
import { zipSync, strToU8 } from 'fflate';

/**
 * The tags Vite wrote for the entry — its module script, its stylesheet,
 * any modulepreload — lifted out of the built page. Everything else in that
 * page is replaced by the template below, whose placeholders index.php
 * fills in per request.
 */
export function assetTags(html) {
  const tags = html.match(
    /<(?:script|link)\b[^>]*\b(?:src|href)="\.?\/?assets\/[^"]+"[^>]*>(?:<\/script>)?/g
  );
  if (!tags || !tags.some((tag) => tag.startsWith('<script')))
    throw Error('Built page has no entry script.');
  return tags.join('\n    ');
}

export const PLACEHOLDERS = [
  '{{LANG}}',
  '{{THEME}}',
  '{{BACKGROUND}}',
  '{{FOREGROUND}}',
  '{{DESCRIPTION_TAG}}',
  '{{TITLE}}',
  '{{ICON_TAG}}',
  '{{BOOT_JSON}}',
  '{{LOADING_TEXT}}',
];

export function shellTemplate(tags) {
  return `<!doctype html>
<html lang="{{LANG}}" data-theme="{{THEME}}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="{{THEME}}" />
    <meta name="theme-color" content="{{BACKGROUND}}" />
    {{DESCRIPTION_TAG}}
    <title>{{TITLE}}</title>
    {{ICON_TAG}}
    <style>
      html,
      body {
        margin: 0;
        background: {{BACKGROUND}};
        color: {{FOREGROUND}};
        font-family: system-ui;
      }
      #boot {
        min-height: 100dvh;
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 16px;
      }
      .wheel {
        width: 32px;
        height: 32px;
        border: 3px solid color-mix(in srgb, currentColor 20%, transparent);
        border-top-color: currentColor;
        border-radius: 50%;
        animation: turn 0.8s linear infinite;
      }
      @keyframes turn {
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .wheel {
          animation: none;
        }
      }
    </style>
    <script id="softn-boot" type="application/json">{{BOOT_JSON}}</script>
    ${tags}
  </head>
  <body>
    <div id="root">
      <div id="boot" role="status">
        <span class="wheel" aria-hidden="true"></span><span>{{LOADING_TEXT}}</span>
      </div>
    </div>
    <noscript>This application needs JavaScript enabled.</noscript>
  </body>
</html>
`;
}

/** The same welcome app apps/softn-single ships, so a fresh deployment shows something. */
export function sampleBundle() {
  return zipSync(
    {
      'manifest.json': strToU8(
        JSON.stringify({
          name: 'Welcome',
          version: '1.0.0',
          main: 'ui/main.ui',
          files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'], assets: [], xdb: [] },
        })
      ),
      'permission.json': strToU8('{"permissions":{}}'),
      'logic/main.logic': strToU8(
        'let sampleClicks = 0\nfunction increment() { sampleClicks = sampleClicks + 1 }'
      ),
      'ui/main.ui': strToU8(
        '<logic src="../logic/main.logic" />\n<App><Box style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:"16px",padding:"48px",maxWidth:"600px",margin:"auto"}}><Text style={{fontSize:"32px"}}>Welcome</Text><Text>Your application is ready.</Text><Button @click={increment}>{"Clicks: " + sampleClicks}</Button></Box></App>'
      ),
    },
    { level: 6 }
  );
}

export const sampleConfig = `<?php
// softn-serve deployment settings. index.php reads this file on every request.
return [
    // Names the visitor's local records; keep it stable across updates of the
    // same application and use a different id for a different application.
    'id' => 'my-application',
    'title' => 'My application',
    // 'description' => 'Shown to search engines and link previews.',
    // 'lang' => 'en',
    // The archive. Keep it in this private directory, never in webroot.
    'bundle' => __DIR__ . '/app.softn',
    'theme' => 'dark',
    'loadingText' => 'Loading…',
    // 'prompt' shows the permission bar; 'preapproved' enables the declared
    // capabilities at once and requires the sha256 pin below.
    'permissionMode' => 'prompt',
    // 'sha256' => '<lowercase hex digest of app.softn>',
    // An operator-supplied permission declaration that replaces the bundle's.
    // 'permissions' => __DIR__ . '/permission.json',
    // Require the cookie index.php sets before serving source or entries.
    'viewerToken' => true,
    'tokenLifetime' => 43200,
    // Blank: generated into secret.key here. Set it when this directory is
    // read-only or several servers share one application.
    'secret' => '',
    // Entries never sent: exact paths, directories ('notes/') or globs ('*.md').
    'withhold' => [],
    // How long a browser may keep an entry it fetched.
    'cacheSeconds' => 3600,
];
`;

export const privateHtaccess = `# This directory is private. If it ends up under a document root anyway,
# nothing in it may be served.
<IfModule mod_authz_core.c>
    Require all denied
</IfModule>
<IfModule !mod_authz_core.c>
    Deny from all
</IfModule>
`;
