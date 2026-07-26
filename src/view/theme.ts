// The default theme, seeded into the `templates` table on first boot.
//
// These are *rows*, not files — page templates, widget renderers and the stylesheet alike. The
// admin's Theme tab edits them, the renderer reads them back, and a page view is the result of
// composing them with content from the same database. WordPress keeps templates in the filesystem
// and content in MySQL; here both are in the one SQLite database, and the "filesystem" is
// IndexedDB.
//
// Template language lives in template.ts. `{{{x}}}` is raw, `{{x}}` is escaped — part payloads
// are raw on purpose, which is what lets a post ship its own <script>.
import type { Db } from '../engine/db.js';
import { DEFAULT_WIDGETS } from './widgets.js';

export type PageTemplateName =
  | 'layout'
  | 'index'
  | 'single'
  | 'page'
  | 'collection'
  | 'part'
  | 'archive'
  | 'query'
  | 'notfound'
  | 'style';

export const PAGE_TEMPLATES: PageTemplateName[] = [
  'layout',
  'index',
  'single',
  'page',
  'collection',
  'part',
  'archive',
  'query',
  'notfound',
  'style',
];

const LAYOUT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Relative URLs in part payloads resolve against the site root, not the current permalink.
     Without this, ./media/x.svg inside /p/demand-paging/ would resolve to
     /p/demand-paging/media/x.svg when a Service Worker is serving real URLs. -->
<base href="{{site.home}}">
<title>{{title}} · {{site.title}}</title>
{{#if card}}
<!-- Link preview. Present here so view-source is honest and a browser extension can read it — but a
     crawler runs no JavaScript and no Service Worker intercepts for it, so previews only actually
     work if a build step also writes static stubs. See model/cards.ts. -->
<meta name="description" content="{{card.description}}">
<meta property="og:type" content="{{card.type}}">
<meta property="og:site_name" content="{{card.siteName}}">
<meta property="og:title" content="{{card.title}}">
<meta property="og:description" content="{{card.description}}">
{{#if card.url}}<meta property="og:url" content="{{card.url}}">{{/if}}
{{#if card.image}}<meta property="og:image" content="{{card.image}}">
<meta property="og:image:alt" content="{{card.imageAlt}}">{{/if}}
<meta name="twitter:card" content="{{card.kind}}">
<meta name="twitter:title" content="{{card.title}}">
<meta name="twitter:description" content="{{card.description}}">
{{#if card.image}}<meta name="twitter:image" content="{{card.image}}">{{/if}}
{{/if}}
<style>{{{style}}}</style>
</head>
<body>
<header class="masthead">
  <a class="brand" href="{{site.home}}">{{site.title}}</a>
  <p class="tagline">{{site.tagline}}</p>
  <nav class="menu">
    <a href="{{site.home}}">Home</a>
    {{#each site.pages}}<a href="{{url}}">{{title}}</a>{{/each}}
    {{#each site.collections}}<a href="{{url}}">{{title}}</a>{{/each}}
    {{#if viewer.portal}}
      {{#if viewer.signedIn}}
      <a class="chip" href="{{viewer.portal}}" target="_blank" rel="noopener"
         title="{{viewer.email}}">{{#if viewer.name}}{{viewer.name}}{{else}}{{viewer.email}}{{/if}}</a>
      {{else}}
      <a class="chip" href="{{viewer.portal}}" target="_blank" rel="noopener">Login</a>
      {{/if}}
    {{/if}}
  </nav>
  <!-- Every named field becomes a URL parameter, so a result set is a shareable link. -->
  <form class="searchbox" data-cms-query action="{{site.home}}query/">
    <input type="search" name="q" value="{{query}}" placeholder="Search this site…" autocomplete="off">
  </form>
</header>
<main>
{{#if breadcrumbs}}
<nav class="crumbs">{{#each breadcrumbs}}<a href="{{url}}">{{title}}</a><span>/</span>{{/each}}</nav>
{{/if}}
{{{content}}}
</main>
<footer class="footsie">
  <p>{{site.title}} — every byte of this page came out of SQLite.</p>
  <p class="served">served via <b>{{transport}}</b> · {{pages}} pages in the database file</p>
</footer>
</body>
</html>
`;

const INDEX = `<h1 class="page-title">{{site.tagline}}</h1>
{{#if posts}}
<ul class="postlist">
  {{#each posts}}
  <li>
    <h2><a href="{{url}}">{{#if number}}<span class="num">{{number}}</span> {{/if}}{{title}}</a></h2>
    <p class="meta">{{created}}{{#if terms}} · {{#each terms}}<a class="term" href="{{url}}">{{name}}</a> {{/each}}{{/if}}</p>
    <p class="excerpt">{{excerpt}}</p>
  </li>
  {{/each}}
</ul>
{{else}}
<p class="empty">Nothing published yet. Write something in the admin.</p>
{{/if}}
{{#if collections}}
<aside class="cloud">
  <h3>Collections</h3>
  {{#each collections}}<a class="term" href="{{url}}">{{title}} <span>{{count}}</span></a>{{/each}}
</aside>
{{/if}}
{{#if categories}}
<aside class="cloud">
  <h3>Categories</h3>
  {{#each categories}}<a class="term" href="{{url}}">{{name}} <span>{{count}}</span></a>{{/each}}
</aside>
{{/if}}
`;

const SINGLE = `<article class="post">
  <h1 class="page-title">{{#if post.number}}<span class="num">{{post.number}}</span> {{/if}}{{post.title}}</h1>
  {{#if post.subtitle}}<p class="subtitle">{{post.subtitle}}</p>{{/if}}
  <p class="meta">{{post.created}}{{#if terms}} · {{#each terms}}<a class="term" href="{{url}}">{{name}}</a> {{/each}}{{/if}}</p>
  <div class="content">{{{parts}}}</div>
  {{#if children}}
  <nav class="subtoc">
    <h3>In this section</h3>
    <ol>{{#each children}}<li><a href="{{url}}">{{#if number}}<span class="num">{{number}}</span> {{/if}}{{title}}</a></li>{{/each}}</ol>
  </nav>
  {{/if}}
  {{#if related}}
  <aside class="related">
    <h3>Related</h3>
    <ul>{{#each related}}
      <li>
        <a href="{{url}}">{{#if number}}<span class="num">{{number}}</span> {{/if}}{{title}}</a>
        <span class="rel">{{relation}}{{#if score}} · {{score}}{{/if}}</span>
      </li>
    {{/each}}</ul>
  </aside>
  {{/if}}
</article>
`;

const PAGE = `<article class="post page">
  <h1 class="page-title">{{post.title}}</h1>
  <div class="content">{{{parts}}}</div>
</article>
`;

// A collection is a book or a blog: its table of contents is the document hierarchy, rendered
// as nested lists. `tree` arrives pre-flattened with a depth on each node, because the template
// language has no recursion — see render.ts.
const COLLECTION = `<h1 class="page-title">{{collection.title}}</h1>
{{#if collection.subtitle}}<p class="subtitle">{{collection.subtitle}}</p>{{/if}}
<p class="meta">{{collection.kind}} · {{count}} document(s)</p>
{{#if tree}}
<ul class="toc">
  {{#each tree}}
  <li class="depth-{{depth}}">
    <a href="{{url}}">{{#if number}}<span class="num">{{number}}</span> {{/if}}{{title}}</a>
    {{#if excerpt}}<span class="toc-note">{{excerpt}}</span>{{/if}}
  </li>
  {{/each}}
</ul>
{{else}}
<p class="empty">This collection is empty.</p>
{{/if}}
`;

// One part, addressable on its own. This is the "bring back part of an entry" view.
const PART = `<article class="post standalone-part">
  <p class="meta">
    {{part.kind}} from <a href="{{post.url}}">{{post.title}}</a>
  </p>
  <div class="content">{{{parts}}}</div>
  {{#if related}}
  <aside class="related">
    <h3>Similar passages</h3>
    <ul>{{#each related}}
      <li><a href="{{url}}">{{title}}</a> <span class="rel">{{score}}</span><br><span class="toc-note">{{text}}</span></li>
    {{/each}}</ul>
  </aside>
  {{/if}}
  <p><a href="{{post.url}}">Read the whole entry →</a></p>
</article>
`;

const ARCHIVE = `<h1 class="page-title">{{term.name}}</h1>
<p class="meta">{{term.kind}} · {{count}} document(s)</p>
{{#if posts}}
<ul class="postlist">
  {{#each posts}}
  <li>
    <h2><a href="{{url}}">{{title}}</a></h2>
    <p class="meta">{{created}}</p>
    <p class="excerpt">{{excerpt}}</p>
  </li>
  {{/each}}
</ul>
{{else}}
<p class="empty">No documents in this archive.</p>
{{/if}}
`;

// The query page. Every filter is a URL parameter, so this whole page is links: a facet is a link
// that toggles one parameter, a sort is a link that changes one, and paging is a link that moves an
// offset. No client state at all, and the address bar always holds the entire query.
const QUERY = `<h1 class="page-title">{{#if query}}{{query}}{{else}}Query{{/if}}</h1>

<form class="queryform" data-cms-query action="{{site.home}}query/">
  <input type="search" name="q" value="{{query}}" placeholder="Full-text over passages…" autocomplete="off">
  <div class="queryrow">
    {{#each criteria.tags}}<input type="hidden" name="tag" value="{{.}}">{{/each}}
    {{#each criteria.categories}}<input type="hidden" name="category" value="{{.}}">{{/each}}
    {{#each criteria.kinds}}<input type="hidden" name="kind" value="{{.}}">{{/each}}
    {{#each criteria.types}}<input type="hidden" name="type" value="{{.}}">{{/each}}
    <label>terms
      <select name="terms">
        <option value="all">all of them</option>
        <option value="any">any of them</option>
      </select>
    </label>
    <label>group
      <select name="group">
        <option value="parts">passages</option>
        <option value="documents">by entry</option>
      </select>
    </label>
    <button type="submit">Query</button>
  </div>
</form>

{{#if active}}
<p class="chips">
  {{#each active}}<a class="term on" href="{{url}}">{{label}} <span>&times;</span></a>{{/each}}
  <a class="term" href="{{clear}}">clear all</a>
</p>
{{/if}}

{{#if empty}}
  <p class="empty">
    Ask for something. <code>?q=</code> is full text over passages; <code>?tag=</code> and
    <code>?category=</code> narrow by taxonomy; <code>?kind=</code> by part type;
    <code>?type=</code> by document type. Combine as many as you like — the URL is the query.
  </p>
{{else}}
  <p class="meta resultline">
    {{total}} passage(s){{#if query}} for &ldquo;{{query}}&rdquo;{{/if}}{{#if from}} · showing {{from}}&ndash;{{shown}}{{/if}}
    {{#if sorts}} · sort {{#each sorts}}<a class="term{{#if active}} on{{/if}}" href="{{url}}">{{value}}</a>{{/each}}{{/if}}
    · view {{#each groupings}}<a class="term{{#if active}} on{{/if}}" href="{{url}}">{{value}}</a>{{/each}}
  </p>

  {{#if titles}}
  <ul class="postlist titles">
    <li class="group">Matching titles</li>
    {{#each titles}}<li><h2><a href="{{url}}">{{#if number}}<span class="num">{{number}}</span> {{/if}}{{title}}</a></h2></li>{{/each}}
  </ul>
  {{/if}}

  {{#if grouped}}
    {{#if groups}}
    <ul class="postlist grouped">
      {{#each groups}}
      <li>
        <h2><a href="{{url}}">{{#if number}}<span class="num">{{number}}</span> {{/if}}{{title}}</a></h2>
        <p class="meta">{{created}} · {{type}}</p>
        <ul class="inner">
          {{#each passages}}
          <li><a href="{{url}}">{{{snippet}}}</a> <span class="rel">{{kind}}</span></li>
          {{/each}}
        </ul>
      </li>
      {{/each}}
    </ul>
    {{else}}
    <p class="empty">Nothing matched.</p>
    {{/if}}
  {{else}}
    {{#if results}}
    <ul class="postlist passages">
      {{#each results}}
      <li>
        <p class="meta">
          <a href="{{documentUrl}}">{{#if number}}<span class="num">{{number}}</span> {{/if}}{{documentTitle}}</a>
          · {{kind}} · {{created}}{{#if score}} <span class="rel">{{score}}</span>{{/if}}
        </p>
        <p class="excerpt"><a href="{{url}}">{{{snippet}}}</a></p>
      </li>
      {{/each}}
    </ul>
    {{else}}
    <p class="empty">Nothing matched.</p>
    {{/if}}
  {{/if}}

  {{#if prev}}<a class="pager" href="{{prev}}">&larr; previous</a>{{/if}}
  {{#if next}}<a class="pager" href="{{next}}">next &rarr;</a>{{/if}}

  <aside class="facets">
    {{#if facets.tags}}
    <div class="facet"><h3>Tags</h3>
      {{#each facets.tags}}<a class="term{{#if active}} on{{/if}}" href="{{url}}">{{label}} <span>{{count}}</span></a>{{/each}}
    </div>
    {{/if}}
    {{#if facets.categories}}
    <div class="facet"><h3>Categories</h3>
      {{#each facets.categories}}<a class="term{{#if active}} on{{/if}}" href="{{url}}">{{label}} <span>{{count}}</span></a>{{/each}}
    </div>
    {{/if}}
    {{#if facets.kinds}}
    <div class="facet"><h3>Passage kinds</h3>
      {{#each facets.kinds}}<a class="term{{#if active}} on{{/if}}" href="{{url}}">{{label}} <span>{{count}}</span></a>{{/each}}
    </div>
    {{/if}}
    {{#if facets.types}}
    <div class="facet"><h3>Document types</h3>
      {{#each facets.types}}<a class="term{{#if active}} on{{/if}}" href="{{url}}">{{label}} <span>{{count}}</span></a>{{/each}}
    </div>
    {{/if}}
  </aside>
{{/if}}
`;

const NOTFOUND = `<h1 class="page-title">Not found</h1>
<p class="empty">No published document at <code>{{path}}</code>.</p>
<p><a href="{{site.home}}">Back home</a></p>
`;

const STYLE = `:root{
  --bg:#fbfaf8; --fg:#1c1b19; --muted:#6b6660; --rule:#e4e0d9;
  --accent:#0f766e; --mark:#fde68a; --code:#f1efea;
}
@media (prefers-color-scheme: dark){
  :root{ --bg:#14161a; --fg:#e8e6e3; --muted:#9a958e; --rule:#2b2f36;
         --accent:#5eead4; --mark:#78591c; --code:#1d2025; }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:17px/1.7 Charter,Georgia,Cambria,"Times New Roman",serif;}
.masthead{max-width:760px;margin:0 auto;padding:44px 24px 20px;border-bottom:1px solid var(--rule)}
.brand{font-size:26px;font-weight:700;letter-spacing:-.02em;color:var(--fg);text-decoration:none;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.tagline{margin:4px 0 14px;color:var(--muted);font-size:15px;font-style:italic}
.menu{display:flex;gap:16px;flex-wrap:wrap;font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  text-transform:uppercase;letter-spacing:.08em}
.menu a{color:var(--muted);text-decoration:none}
.menu a:hover{color:var(--accent)}
.menu .chip{border:1px solid var(--rule);border-radius:999px;padding:3px 11px;letter-spacing:.04em;
  text-transform:none}
.menu .chip:hover{border-color:var(--accent)}
.searchbox{margin-top:16px}
.searchbox input{width:100%;padding:9px 12px;border:1px solid var(--rule);border-radius:7px;
  background:transparent;color:var(--fg);font:14px/1.4 inherit}
main{max-width:760px;margin:0 auto;padding:28px 24px 60px}
.page-title{font-size:32px;line-height:1.2;letter-spacing:-.02em;margin:.2em 0 .3em}
.subtitle{color:var(--muted);font-size:19px;font-style:italic;margin:-.2em 0 .6em}
h2{font-size:21px;line-height:1.3;margin:0 0 4px}
h2 a{color:var(--fg);text-decoration:none}
h2 a:hover{color:var(--accent)}
a{color:var(--accent)}
.num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82em;color:var(--muted)}
.meta{color:var(--muted);font-size:13px;margin:0 0 10px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.excerpt{margin:0;color:var(--fg)}
.postlist{list-style:none;margin:26px 0 0;padding:0}
.postlist li{padding:22px 0;border-top:1px solid var(--rule)}
.postlist li.group{padding:8px 0 4px;border:none;color:var(--muted);font-size:11px;
  text-transform:uppercase;letter-spacing:.09em;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.postlist.passages .excerpt a{color:var(--fg);text-decoration:none}
.postlist.passages .excerpt a:hover{color:var(--accent)}
.crumbs{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin:0 0 14px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.crumbs span{opacity:.5}

/* parts */
.content{margin-top:20px}
.part{margin:0 0 4px}
.part.prose p:first-child,.part.raw p:first-child{margin-top:0}
.content img{max-width:100%;height:auto;border-radius:8px;display:block}
.content video{width:100%;border-radius:10px;background:#000;display:block}
.part.figure,.part.code,.part.table,.part.video{margin:26px 0}
.part.figure figcaption,.part.video figcaption,.part.code figcaption,.part.table figcaption{
  color:var(--muted);font-size:13px;margin-top:8px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.part.code pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow-x:auto;margin:0;
  font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.content pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow-x:auto;
  font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.content code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:.86em;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.content pre code{background:none;padding:0}
.part.quote,.content blockquote{margin:24px 0;padding-left:18px;border-left:3px solid var(--rule);color:var(--muted)}
.part.quote cite{display:block;margin-top:8px;font-size:13px;font-style:normal}
.part.callout{margin:26px 0;padding:16px 18px;border:1px solid var(--rule);border-radius:12px;
  background:color-mix(in srgb, var(--accent) 5%, transparent)}
.part.callout .callout-title{margin:0 0 6px;font-weight:700;font-size:14px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.part.callout p:last-child{margin-bottom:0}
.part.sealed{margin:26px 0;padding:18px;border:1px dashed var(--rule);border-radius:12px;color:var(--muted)}
.part.sealed .sealed-title{margin:0 0 6px;font-weight:700;color:var(--fg);font-size:13px;
  text-transform:uppercase;letter-spacing:.08em;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.part.story{display:grid;grid-template-columns:1fr;gap:16px;margin:30px 0;padding-top:24px;
  border-top:1px solid var(--rule)}
@media (min-width:720px){ .part.story{grid-template-columns:1fr 1fr;align-items:start} }
.part.story .story-step{margin:0 0 4px;color:var(--accent);font-size:11px;font-weight:700;
  text-transform:uppercase;letter-spacing:.1em;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.part.story h3{margin:0 0 8px;font-size:19px}
.part.list ul{margin:0;padding-left:22px}
.part.list .list-title{margin:0 0 6px;font-weight:600}
.content table{border-collapse:collapse;width:100%;font-size:15px}
.content th,.content td{border-bottom:1px solid var(--rule);padding:7px 10px;text-align:left}
mark{background:var(--mark);border-radius:2px;padding:0 2px}

/* query page — every control is a link, so they are all styled as chips */
.queryform{margin:22px 0 6px}
.queryform input[type=search]{width:100%;padding:10px 13px;border:1px solid var(--rule);border-radius:8px;
  background:transparent;color:var(--fg);font:16px/1.4 inherit}
.queryrow{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px;
  font:12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--muted)}
.queryrow label{display:flex;gap:5px;align-items:center;text-transform:uppercase;letter-spacing:.07em}
.queryrow select{padding:5px 7px;border:1px solid var(--rule);border-radius:6px;background:transparent;
  color:var(--fg);font:12px/1 inherit}
.queryrow button{padding:6px 15px;border:1px solid var(--accent);border-radius:999px;background:transparent;
  color:var(--accent);font:12px/1 inherit;font-weight:700;text-transform:uppercase;letter-spacing:.07em;cursor:pointer}
.chips{margin:12px 0 0}
.resultline{margin:18px 0 0}
.term.on{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb, var(--accent) 9%, transparent)}
.pager{display:inline-block;margin:22px 14px 0 0;font-size:14px}
.facets{margin-top:44px;padding-top:22px;border-top:1px solid var(--rule);
  display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.facet h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 8px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.postlist.grouped .inner{list-style:none;margin:10px 0 0;padding:0 0 0 14px;border-left:2px solid var(--rule)}
.postlist.grouped .inner li{padding:5px 0;border:none;font-size:15px}
.postlist.grouped .inner a{color:var(--fg);text-decoration:none}
.postlist.grouped .inner a:hover{color:var(--accent)}

.part.raw{margin:30px 0}
.part.raw .raw-frame{width:100%;border:1px solid var(--rule);border-radius:12px;background:var(--bg);
  display:block;height:520px}
.part.raw .raw-title{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.09em;
  color:var(--muted);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.part.raw .raw-caption{color:var(--muted);font-size:13px;margin-top:9px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
/* structure */
.toc{list-style:none;margin:26px 0 0;padding:0;font-size:16px}
.toc li{padding:5px 0;border-top:1px solid var(--rule)}
.toc li.depth-1{padding-left:22px}
.toc li.depth-2{padding-left:44px;font-size:15px}
.toc li.depth-3{padding-left:66px;font-size:14px}
.toc a{text-decoration:none}
.toc a:hover{text-decoration:underline}
.toc-note{display:block;color:var(--muted);font-size:13px}
.subtoc,.related{margin-top:42px;padding-top:20px;border-top:1px solid var(--rule)}
.subtoc h3,.related h3,.cloud h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;
  color:var(--muted);margin:0 0 10px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.related ul,.subtoc ol{margin:0;padding-left:20px}
.related li,.subtoc li{margin:5px 0}
.related .rel{color:var(--muted);font-size:12px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.term{display:inline-block;color:var(--muted);text-decoration:none;font-size:12px;
  border:1px solid var(--rule);border-radius:999px;padding:2px 9px;margin:0 4px 4px 0;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.term:hover{border-color:var(--accent);color:var(--accent)}
.term span{opacity:.6}
.cloud{margin-top:44px;padding-top:22px;border-top:1px solid var(--rule)}
.empty{color:var(--muted);font-style:italic}
.footsie{max-width:760px;margin:0 auto;padding:22px 24px 50px;border-top:1px solid var(--rule);
  color:var(--muted);font-size:13px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.footsie p{margin:3px 0}
.served b{color:var(--accent);font-weight:600}
`;

const DEFAULT_PAGES: Record<PageTemplateName, string> = {
  layout: LAYOUT,
  index: INDEX,
  single: SINGLE,
  page: PAGE,
  collection: COLLECTION,
  part: PART,
  archive: ARCHIVE,
  query: QUERY,
  notfound: NOTFOUND,
  style: STYLE,
};

/** Every seeded template: page templates plus one renderer per widget kind. */
export const DEFAULT_TEMPLATES: Record<string, string> = {
  ...DEFAULT_PAGES,
  ...DEFAULT_WIDGETS,
};

/** Names offered in the admin's template picker, pages first then widgets. */
export const TEMPLATE_ORDER: string[] = [
  ...PAGE_TEMPLATES,
  ...Object.keys(DEFAULT_WIDGETS).sort(),
];

/** Insert any template the database does not already have. Never overwrites an edited one. */
export async function seedTheme(db: Db): Promise<void> {
  for (const [name, body] of Object.entries(DEFAULT_TEMPLATES)) {
    await db.query(`INSERT OR IGNORE INTO templates (name, body) VALUES (?, ?)`, [name, body]);
  }
}

export async function getTemplate(db: Db, name: string): Promise<string> {
  const body = await db.scalar(`SELECT body FROM templates WHERE name = ?`, [name]);
  // Fall back to the built-in rather than rendering nothing, so deleting a row cannot brick the
  // site — the theme table is user-editable.
  return typeof body === 'string' ? body : DEFAULT_TEMPLATES[name] ?? '';
}

export async function setTemplate(db: Db, name: string, body: string): Promise<void> {
  await db.query(
    `INSERT INTO templates (name, body) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET body = excluded.body`,
    [name, body],
  );
}

export async function resetTemplate(db: Db, name: string): Promise<void> {
  await setTemplate(db, name, DEFAULT_TEMPLATES[name] ?? '');
}

/** Load every template in one pass, so a render does not issue a query per template. */
export async function loadTemplates(db: Db): Promise<Record<string, string>> {
  const rows = await db.query<{ name: string; body: string }>(`SELECT name, body FROM templates`);
  const out: Record<string, string> = { ...DEFAULT_TEMPLATES };
  for (const row of rows) out[row.name] = row.body;
  return out;
}
