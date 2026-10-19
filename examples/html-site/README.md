# HTML in SoftN

Three pages written as HTML: SoftN's components and syntax where they help, and browser
JavaScript where that is simpler.

- `index.html`: SoftN components (`<NavItem>`, `<Button>`, `<Stack>`), `#if` and `#each`, and
  `main.js` linked with `<script src>`. The menu's `page="…"` items switch `currentPage` and
  highlight the page showing; its `navigate="…"` items link to the other pages.
- `tasks.html`: a to-do list written as browser code, with `document.getElementById`,
  `addEventListener`, `createElement` and `innerHTML`, run in SoftN's sandbox.
- `about.html`: plain HTML and a link.

Build the standalone runtime, then serve the folder:

```sh
npm run build -w @softn/single
node examples/html-site/serve.mjs
```

- <http://127.0.0.1:4820/>: the files as a site of your own. Each page starts SoftN with
  `<script src="softn/softn.js">`, and a link loads the next page, as on any site.
- <http://127.0.0.1:4820/app/>: the same files as one bundle in the standalone runtime. A link to
  another page shows it in the app, and the browser's Back button returns.

`HTML_SITE_PORT` picks another port. The server reads the files on every request, so an edited
page shows on reload.
