/** All content is escaped; authored HTML and executable content blocks are unsupported. */
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e = escapeHtml;

/**
 * The SoftN mark, the same drawing @softn/brand's Mark.tsx makes: coral
 * brackets for the language, a mint dot for the thing that runs, on a tile
 * of the theme's raised ground. Inline so the page needs no script for it.
 */
const MARK = '<svg width="22" height="22" viewBox="0 0 32 32" role="img" aria-label="SoftN"><rect class="softn-mark-ground" width="32" height="32" rx="8.7"/><path class="softn-mark-bracket" d="M9 11.5 5.5 16 9 20.5" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path class="softn-mark-bracket" d="M23 11.5 26.5 16 23 20.5" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle class="softn-mark-dot" cx="16" cy="16" r="2.8"/></svg>';

/** Sun and moon, as in @softn/brand's ThemeToggle; the script shows the one for the theme the reader can switch to. */
const THEME_ICONS = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><g data-theme-icon="dark"><circle cx="8" cy="8" r="3.25" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.4v1.6M8 13v1.6M14.6 8H13M3 8H1.4M12.67 3.33l-1.13 1.13M4.46 11.54l-1.13 1.13M12.67 12.67l-1.13-1.13M4.46 4.46 3.33 3.33" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></g><path data-theme-icon="light" d="M13.5 9.6A5.9 5.9 0 0 1 6.4 2.5a5.9 5.9 0 1 0 7.1 7.1Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

/**
 * Runs before first paint so a light-mode reader never sees the dark ground
 * flash. The key and the rule are the ones every SoftN app's index.html
 * carries (packages/@softn/brand/src/theme.ts, PRE_PAINT_SCRIPT); a page
 * with no JavaScript renders dark, as designed.
 */
const PRE_PAINT_SCRIPT = `(function(){var theme='dark';try{var stored=localStorage.getItem('softn.site.theme');if(stored==='light'||stored==='dark'){theme=stored;}else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches){theme='light';}}catch(e){}document.documentElement.setAttribute('data-theme',theme);var meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.setAttribute('content',theme==='light'?'#f4f6f9':'#101317');})();`;
export const inline = value => String(value).split(/(`[^`\n]+`)/g).map(part => part.startsWith('`') && part.endsWith('`') ? `<code>${e(part.slice(1,-1))}</code>` : e(part)).join('');
export const routeFor = (doc, page) => `${doc.site.basePath}${page.slug ? page.slug + '/' : ''}`;
const lookup = (doc,id) => doc.pages.find(page => page.id === id);
const hrefFor = (doc,id) => routeFor(doc,lookup(doc,id));
export const jsonForHtml = value => JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');

function card(doc,page) {
  return `<a class="doc-card" href="${e(routeFor(doc,page))}"><span class="card-title">${e(page.title)}<span aria-hidden="true"> ↗</span></span><span>${e(page.summary)}</span></a>`;
}
export function renderBlock(block,doc) {
  switch (block.type) {
    case 'paragraph': return `<p>${inline(block.text)}</p>`;
    case 'code': return `<figure class="code-block"><div class="code-toolbar"><span>${e(block.language)}</span><button class="copy-code" type="button" hidden data-copied="${e(doc.site.labels.copied)}" data-failed="${e(doc.site.labels.copyFailed)}">${e(doc.site.labels.copy)}</button></div><pre tabindex="0"><code class="language-${e(block.language)}">${e(block.code)}</code></pre><figcaption>${inline(block.caption)}</figcaption></figure>`;
    case 'list': { const tag=block.ordered?'ol':'ul'; return `<${tag}>${block.items.map(item=>`<li>${inline(item)}</li>`).join('')}</${tag}>`; }
    case 'table': return `<div class="table-scroll" tabindex="0" role="region" aria-label="${e(block.caption)}"><table><caption>${e(block.caption)}</caption><thead><tr>${block.columns.map(col=>`<th scope="col">${inline(col)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row=>`<tr>${row.map(cell=>`<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    case 'callout': return `<aside class="callout ${e(block.tone)}" aria-label="${e(block.title)}"><strong>${e(block.title)}</strong><p>${inline(block.text)}</p></aside>`;
    case 'steps': return `<ol class="steps">${block.items.map(item=>`<li><h3>${inline(item.title)}</h3><p>${inline(item.text)}</p></li>`).join('')}</ol>`;
    case 'cards': return `<div class="doc-cards">${block.pageIds.map(id=>card(doc,lookup(doc,id))).join('')}</div>`;
    case 'definitions': return `<dl class="definitions">${block.items.map(item=>`<div><dt>${inline(item.term)}</dt><dd>${inline(item.description)}</dd></div>`).join('')}</dl>`;
    case 'links': return `<ul class="reference-links">${block.items.map(item=>`<li><a href="${e(item.href)}" rel="noopener noreferrer">${e(item.label)}</a><p>${e(item.description)}</p></li>`).join('')}</ul>`;
    default: throw new Error(`Unsupported block type: ${block.type}`);
  }
}

export function navigation(doc,current) {
  return `<nav aria-label="${e(doc.site.labels.navigation)}">${doc.navigation.map(group=>`<div class="nav-group"><p>${e(group.title)}</p><ul>${group.pageIds.map(id=>{const page=lookup(doc,id);return `<li><a href="${e(routeFor(doc,page))}"${current===id?' aria-current="page"':''}>${e(page.title)}</a></li>`;}).join('')}</ul></div>`).join('')}</nav>`;
}
export function landingData(doc) {
  return {...doc.landing,cta:{label:doc.landing.cta.label,href:hrefFor(doc,doc.landing.cta.pageId)},cards:doc.landing.cards.map(item=>({label:item.label,description:item.description,href:hrefFor(doc,item.pageId)}))};
}
export function renderLanding(doc) {
  const l=landingData(doc);
  return `<section class="softn-learn" aria-labelledby="softn-learn-title"><p class="softn-learn-eyebrow">${e(l.eyebrow)}</p><h2 id="softn-learn-title">${e(l.title)}</h2><p class="softn-learn-intro">${e(l.description)}</p><div class="softn-learn-grid">${l.cards.map(c=>`<a class="softn-learn-card" href="${e(c.href)}"><strong>${e(c.label)}</strong><span>${e(c.description)}</span></a>`).join('')}</div><a class="softn-learn-cta" href="${e(l.cta.href)}">${e(l.cta.label)} <span aria-hidden="true">→</span></a></section>`;
}
export function plainText(page) {
  const texts=[page.title,page.summary];
  for(const section of page.sections) {
    texts.push(section.title);
    for(const b of section.blocks) {
      if(b.text) texts.push(b.text);
      if(b.title) texts.push(b.title);
      if(b.code) texts.push(b.code);
      if(b.caption) texts.push(b.caption);
      if(b.columns) texts.push(...b.columns,...b.rows.flat());
      for(const item of b.items??[]) texts.push(typeof item==='string'?item:[item.title,item.text,item.term,item.label,item.description].filter(Boolean).join(' '));
    }
  }
  return texts.join('\n');
}
export function renderPage(doc,page,assets) {
  const labels=doc.site.labels,route=routeFor(doc,page),canonical=doc.site.origin+route;
  const isIndex=page.slug==='';
  const indexPage=doc.pages.find(p=>p.slug==='');
  const group=doc.navigation.find(g=>g.id===page.groupId);
  const order=doc.navigation.flatMap(g=>g.pageIds),position=order.indexOf(page.id);
  const adjacent=(offset,label)=>{
    const id=order[position+offset]; if(!id)return '<span></span>';
    const p=lookup(doc,id);return `<a href="${e(routeFor(doc,p))}"><small>${e(label)}</small><strong>${e(p.title)}</strong></a>`;
  };
  const crumbItems=[{name:labels.home,item:doc.site.origin+'/'},{name:labels.docs,item:doc.site.origin+routeFor(doc,indexPage)}];
  if(!isIndex)crumbItems.push({name:page.title,item:canonical});
  const structured={'@context':'https://schema.org','@graph':[
    {'@type':isIndex?'CollectionPage':'TechArticle','@id':canonical+'#page',url:canonical,headline:page.title,description:page.seo.description,inLanguage:doc.site.language,dateModified:page.updatedAt,isPartOf:{'@id':doc.site.origin+doc.site.basePath+'#documentation'}},
    {'@type':'BreadcrumbList',itemListElement:crumbItems.map((item,i)=>({'@type':'ListItem',position:i+1,name:item.name,item:item.item}))}
  ]};
  const toc=`<nav aria-label="${e(labels.onThisPage)}"><p>${e(labels.onThisPage)}</p><ul>${page.sections.map(s=>`<li><a href="#section-${e(s.id)}">${e(s.title)}</a></li>`).join('')}</ul></nav>`;
  return `<!doctype html>
<html lang="${e(doc.site.language)}" data-search-index="${e(doc.site.basePath+'search-index.json')}" data-docs-base="${e(doc.site.basePath)}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(page.seo.title)}</title>
<meta name="description" content="${e(page.seo.description)}"><meta name="robots" content="index,follow"><meta name="color-scheme" content="dark light"><meta name="theme-color" content="#101317">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="canonical" href="${e(canonical)}">
<script>${PRE_PAINT_SCRIPT}</script>
<meta property="og:type" content="${isIndex?'website':'article'}"><meta property="og:site_name" content="${e(doc.site.documentationTitle)}"><meta property="og:title" content="${e(page.seo.title)}"><meta property="og:description" content="${e(page.seo.description)}"><meta property="og:url" content="${e(canonical)}">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${e(page.seo.title)}"><meta name="twitter:description" content="${e(page.seo.description)}">
<link rel="stylesheet" href="${e(assets.css)}"><link rel="sitemap" type="application/xml" href="/sitemap-docs.xml">
<script type="application/ld+json">${jsonForHtml(structured)}</script>
<script defer src="${e(assets.js)}"></script>
</head>
<body>
<a class="skip-link" href="#article">${e(labels.skip)}</a>
<nav class="softn-bar" data-sticky="true" aria-label="SoftN"><div class="softn-bar-inner"><a class="softn-bar-mark" href="${e(doc.site.homeHref)}">${MARK}${e(doc.site.wordmark??doc.site.name)}</a><div class="softn-bar-links">${(doc.site.products??[]).map(p=>`<a href="${e(p.href)}">${e(p.label)}</a>`).join('')}<a href="${e(doc.site.basePath)}" aria-current="page">${e(labels.docsShort??labels.docs)}</a></div><button class="softn-theme-toggle theme-toggle" type="button" hidden aria-label="Switch theme" data-to-light="Switch to light mode" data-to-dark="Switch to dark mode">${THEME_ICONS}</button><a class="softn-bar-repo" href="${e(doc.site.repositoryHref)}" target="_blank" rel="noopener noreferrer">GitHub</a></div></nav>
<div class="page-layout"><aside class="sidebar">${navigation(doc,page.id)}<p class="sidebar-foot">${e(doc.site.tagline)}</p></aside>
<div class="article-column"><details class="mobile-navigation"><summary>${e(labels.menu)}</summary>${navigation(doc,page.id)}</details>
<div class="docs-search" role="search" hidden><label for="docs-search-input">${e(labels.search)}</label><input id="docs-search-input" type="search" placeholder="${e(labels.searchPlaceholder)}" autocomplete="off" aria-controls="search-results" aria-describedby="search-hint"><p id="search-hint" class="search-hint">${e(labels.searchHint)}</p><div id="search-results" aria-live="polite" data-empty="${e(labels.noResults)}" hidden></div></div>
<main id="article" tabindex="-1"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="${e(doc.site.homeHref)}">${e(labels.home)}</a><span aria-hidden="true">/</span>${isIndex?`<span aria-current="page">${e(labels.docs)}</span>`:`<a href="${e(doc.site.basePath)}">${e(labels.docs)}</a><span aria-hidden="true">/</span><span aria-current="page">${e(page.title)}</span>`}</nav>
<article aria-labelledby="article-title"><header class="article-header"><p class="eyebrow">${e(group.title)}</p><h1 id="article-title">${e(page.title)}</h1><p class="lead">${e(page.summary)}</p><p class="article-meta">${e(labels.updated)} <time datetime="${e(page.updatedAt)}">${e(page.updatedAt)}</time>${page.kind==='experimental'?' · Experimental integration':''}</p></header>
<div class="inline-toc">${toc}</div>
${page.sections.map(section=>`<section class="article-section" aria-labelledby="section-${e(section.id)}"><h2 id="section-${e(section.id)}">${e(section.title)}<a class="heading-anchor" href="#section-${e(section.id)}" aria-label="${e(section.title)} permalink">#</a></h2>${section.blocks.map(block=>renderBlock(block,doc)).join('\n')}</section>`).join('\n')}
${isIndex?`<section class="article-section" aria-labelledby="all-guides"><h2 id="all-guides">${e(labels.allGuides)}</h2>${doc.navigation.map(g=>`<h3>${e(g.title)}</h3><div class="doc-cards">${g.pageIds.filter(id=>id!==page.id).map(id=>card(doc,lookup(doc,id))).join('')}</div>`).join('')}</section>`:''}
${page.relatedPageIds.length?`<section class="article-section" aria-labelledby="related-guides"><h2 id="related-guides">${e(labels.related)}</h2><div class="doc-cards">${page.relatedPageIds.map(id=>card(doc,lookup(doc,id))).join('')}</div></section>`:''}
<section class="sources" aria-labelledby="docs-sources"><h2 id="docs-sources">${e(labels.sources)}</h2><p>${e(labels.sourceNote)}</p><ul>${page.sourceIds.map(id=>{const s=doc.sources.find(x=>x.id===id);return `<li><a href="${e(s.url)}" rel="noopener noreferrer">${e(s.title)}</a></li>`;}).join('')}</ul></section>
</article><nav class="page-pagination" aria-label="Guide pagination">${adjacent(-1,labels.previous)}${adjacent(1,labels.next)}</nav>
</main><footer class="site-footer"><strong>${e(doc.site.name)}</strong><p>${e(doc.site.footerText)}</p></footer></div><aside class="toc-sidebar">${toc}</aside></div>
</body></html>\n`;
}
