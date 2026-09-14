/* Optional enhancements only. Reading and navigation do not depend on JavaScript. */
'use strict';
(() => {
  const input = document.querySelector('#docs-search-input');
  const results = document.querySelector('#search-results');
  const search = document.querySelector('.docs-search');
  const base = document.documentElement.dataset.docsBase;
  let pendingIndex;
  const loadIndex = () => pendingIndex ??= fetch(document.documentElement.dataset.searchIndex)
    .then(response => { if (!response.ok) throw new Error('Search index unavailable'); return response.json(); });
  if (search && input && results) {
    search.hidden = false;
    input.addEventListener('focus', () => { loadIndex().catch(() => { pendingIndex = undefined; }); }, {once:true});
    let serial = 0;
    input.addEventListener('input', async () => {
      const request = ++serial;
      const query = input.value.trim().toLocaleLowerCase();
      results.replaceChildren(); results.hidden = !query;
      if (!query) return;
      try {
        const index = await loadIndex();
        if (request !== serial) return;
        const tokens = query.split(/\s+/).slice(0,12);
        const ranked = index.pages.map(page => {
          const title = page.title.toLocaleLowerCase(), summary = page.summary.toLocaleLowerCase(), body = page.text.toLocaleLowerCase();
          if (!tokens.every(t => `${title} ${summary} ${body}`.includes(t))) return {page,score:0};
          return {page,score:tokens.reduce((score,t) => score + (title.includes(t)?10:0) + (summary.includes(t)?4:0) + (body.includes(t)?1:0),0)};
        }).filter(x => x.score).sort((a,b)=>b.score-a.score).slice(0,8);
        if (!ranked.length) { results.textContent = results.dataset.empty; return; }
        const list = document.createElement('ul');
        for (const {page} of ranked) {
          const href = new URL(page.href,window.location.origin);
          if (href.origin !== window.location.origin || !href.pathname.startsWith(base)) continue;
          const item = document.createElement('li'), link = document.createElement('a'), description = document.createElement('p');
          link.href = href.pathname; link.textContent = page.title; description.textContent = page.summary;
          item.append(link,description); list.append(item);
        }
        results.replaceChildren(list);
      } catch {
        if (request === serial) results.textContent = document.querySelector('#search-hint').textContent;
        pendingIndex = undefined;
      }
    });
    input.addEventListener('keydown',event => { if(event.key==='Escape'){input.value='';results.replaceChildren();results.hidden=true;serial++;} });
  }
  // The theme switch, as on the site: the stored value is the reader's
  // choice, and every SoftN app on this origin reads the same key.
  const toggle = document.querySelector('.theme-toggle');
  if (toggle) {
    const KEY = 'softn.site.theme';
    const current = () => document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const reflect = () => {
      const theme = current();
      toggle.setAttribute('aria-label', theme === 'dark' ? toggle.dataset.toLight : toggle.dataset.toDark);
      toggle.title = toggle.getAttribute('aria-label');
      for (const icon of toggle.querySelectorAll('[data-theme-icon]')) icon.style.display = icon.dataset.themeIcon === theme ? '' : 'none';
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f6f9' : '#101317');
    };
    toggle.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch { /* storage blocked; the page still switches */ }
      reflect();
    });
    reflect();
    toggle.hidden = false;
  }
  for (const button of document.querySelectorAll('.copy-code')) {
    button.hidden = false;
    button.addEventListener('click', async () => {
      const label=button.textContent;
      try {
        await navigator.clipboard.writeText(button.closest('.code-block').querySelector('pre code').textContent);
        button.textContent=button.dataset.copied;
      } catch { button.textContent=button.dataset.failed; }
      setTimeout(()=>{button.textContent=label;},2500);
    });
  }
})();
