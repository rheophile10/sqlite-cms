// The default theme, seeded into the `templates` table on first boot.
//
// These are *rows*, not files. The admin's Theme tab edits them, the renderer reads them back,
// and a page view is the result of composing them with content from the same database. That is
// the whole conceit: WordPress keeps templates in the filesystem and content in MySQL; here
// both are in the one SQLite file, and the "filesystem" is IndexedDB.
//
// Template language lives in template.ts. `{{{x}}}` is raw, `{{x}}` is escaped — post bodies
// are raw on purpose, which is what lets a post ship its own <script>.
import type { Db } from './db.js';

export type TemplateName =
  | 'layout'
  | 'index'
  | 'single'
  | 'page'
  | 'archive'
  | 'search'
  | 'notfound'
  | 'style';

export const TEMPLATE_ORDER: TemplateName[] = [
  'layout',
  'index',
  'single',
  'page',
  'archive',
  'search',
  'notfound',
  'style',
];

const LAYOUT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Relative URLs in post bodies resolve against the site root, not the current permalink.
     Without this, ./media/x.svg inside /p/demand-paging/ would resolve to
     /p/demand-paging/media/x.svg when a Service Worker is serving real URLs. -->
<base href="{{site.home}}">
<title>{{title}} · {{site.title}}</title>
<style>{{{style}}}</style>
</head>
<body>
<header class="masthead">
  <a class="brand" href="{{site.home}}">{{site.title}}</a>
  <p class="tagline">{{site.tagline}}</p>
  <nav class="menu">
    <a href="{{site.home}}">Home</a>
    {{#each site.pages}}<a href="{{url}}">{{title}}</a>{{/each}}
  </nav>
  <form class="searchbox" data-cms-search>
    <input type="search" name="q" value="{{query}}" placeholder="Search this site…" autocomplete="off">
  </form>
</header>
<main>
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
    <h2><a href="{{url}}">{{title}}</a></h2>
    <p class="meta">{{created}}{{#if terms}} · {{#each terms}}<a class="term" href="{{url}}">{{name}}</a> {{/each}}{{/if}}</p>
    <p class="excerpt">{{excerpt}}</p>
  </li>
  {{/each}}
</ul>
{{else}}
<p class="empty">Nothing published yet. Write something in the admin.</p>
{{/if}}
{{#if categories}}
<aside class="cloud">
  <h3>Categories</h3>
  {{#each categories}}<a class="term" href="{{url}}">{{name}} <span>{{count}}</span></a>{{/each}}
</aside>
{{/if}}
`;

const SINGLE = `<article class="post">
  <h1 class="page-title">{{post.title}}</h1>
  <p class="meta">{{post.created}}{{#if terms}} · {{#each terms}}<a class="term" href="{{url}}">{{name}}</a> {{/each}}{{/if}}</p>
  <div class="content">{{{post.body}}}</div>
</article>
`;

const PAGE = `<article class="post page">
  <h1 class="page-title">{{post.title}}</h1>
  <div class="content">{{{post.body}}}</div>
</article>
`;

const ARCHIVE = `<h1 class="page-title">{{term.name}}</h1>
<p class="meta">{{term.kind}} · {{count}} post(s)</p>
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
<p class="empty">No posts in this archive.</p>
{{/if}}
`;

const SEARCH = `<h1 class="page-title">Search</h1>
{{#if query}}
  <p class="meta">{{count}} result(s) for &ldquo;{{query}}&rdquo; — ranked by <code>bm25()</code></p>
  {{#if results}}
  <ul class="postlist">
    {{#each results}}
    <li>
      <h2><a href="{{url}}">{{title}}</a></h2>
      <p class="meta">{{created}}</p>
      <p class="excerpt">{{{snippet}}}</p>
    </li>
    {{/each}}
  </ul>
  {{else}}
  <p class="empty">No matches.</p>
  {{/if}}
{{else}}
  <p class="empty">Type a query above. Prefix matching is on by default; <code>NEAR</code>, <code>OR</code> and <code>"quoted phrases"</code> work too.</p>
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
.masthead{max-width:720px;margin:0 auto;padding:44px 24px 20px;border-bottom:1px solid var(--rule)}
.brand{font-size:26px;font-weight:700;letter-spacing:-.02em;color:var(--fg);text-decoration:none;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.tagline{margin:4px 0 14px;color:var(--muted);font-size:15px;font-style:italic}
.menu{display:flex;gap:16px;flex-wrap:wrap;font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  text-transform:uppercase;letter-spacing:.08em}
.menu a{color:var(--muted);text-decoration:none}
.menu a:hover{color:var(--accent)}
.searchbox{margin-top:16px}
.searchbox input{width:100%;padding:9px 12px;border:1px solid var(--rule);border-radius:7px;
  background:transparent;color:var(--fg);font:14px/1.4 inherit}
main{max-width:720px;margin:0 auto;padding:28px 24px 60px}
.page-title{font-size:32px;line-height:1.2;letter-spacing:-.02em;margin:.2em 0 .3em}
h2{font-size:21px;line-height:1.3;margin:0 0 4px}
h2 a{color:var(--fg);text-decoration:none}
h2 a:hover{color:var(--accent)}
a{color:var(--accent)}
.meta{color:var(--muted);font-size:13px;margin:0 0 10px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.excerpt{margin:0;color:var(--fg)}
.postlist{list-style:none;margin:26px 0 0;padding:0}
.postlist li{padding:22px 0;border-top:1px solid var(--rule)}
.content{margin-top:20px}
.content img{max-width:100%;height:auto;border-radius:8px;display:block;margin:22px 0}
.content pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow-x:auto;
  font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.content code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:.86em;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.content pre code{background:none;padding:0}
.content blockquote{margin:22px 0;padding-left:18px;border-left:3px solid var(--rule);color:var(--muted)}
.content table{border-collapse:collapse;width:100%;font-size:15px}
.content th,.content td{border-bottom:1px solid var(--rule);padding:7px 10px;text-align:left}
mark,.excerpt b{background:var(--mark);border-radius:2px;padding:0 2px}
.term{display:inline-block;color:var(--muted);text-decoration:none;font-size:12px;
  border:1px solid var(--rule);border-radius:999px;padding:2px 9px;margin:0 4px 4px 0;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.term:hover{border-color:var(--accent);color:var(--accent)}
.term span{opacity:.6}
.cloud{margin-top:44px;padding-top:22px;border-top:1px solid var(--rule)}
.cloud h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 10px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.empty{color:var(--muted);font-style:italic}
.footsie{max-width:720px;margin:0 auto;padding:22px 24px 50px;border-top:1px solid var(--rule);
  color:var(--muted);font-size:13px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.footsie p{margin:3px 0}
.served b{color:var(--accent);font-weight:600}
`;

export const DEFAULT_TEMPLATES: Record<TemplateName, string> = {
  layout: LAYOUT,
  index: INDEX,
  single: SINGLE,
  page: PAGE,
  archive: ARCHIVE,
  search: SEARCH,
  notfound: NOTFOUND,
  style: STYLE,
};

/** Insert any template the database does not already have. Never overwrites an edited one. */
export async function seedTheme(db: Db): Promise<void> {
  for (const name of TEMPLATE_ORDER) {
    await db.query(`INSERT OR IGNORE INTO templates (name, body) VALUES (?, ?)`, [
      name,
      DEFAULT_TEMPLATES[name],
    ]);
  }
}

export async function getTemplate(db: Db, name: TemplateName): Promise<string> {
  const body = await db.scalar(`SELECT body FROM templates WHERE name = ?`, [name]);
  // Fall back to the built-in rather than rendering nothing, so deleting a row cannot brick
  // the site — the theme table is user-editable.
  return typeof body === 'string' ? body : DEFAULT_TEMPLATES[name];
}

export async function setTemplate(db: Db, name: TemplateName, body: string): Promise<void> {
  await db.query(
    `INSERT INTO templates (name, body) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET body = excluded.body`,
    [name, body],
  );
}

export async function resetTemplate(db: Db, name: TemplateName): Promise<void> {
  await setTemplate(db, name, DEFAULT_TEMPLATES[name]);
}

/** Load every template in one pass, so a render does not issue eight separate queries. */
export async function loadTemplates(db: Db): Promise<Record<string, string>> {
  const rows = await db.query<{ name: string; body: string }>(
    `SELECT name, body FROM templates`,
  );
  const out: Record<string, string> = { ...DEFAULT_TEMPLATES };
  for (const row of rows) out[row.name] = row.body;
  return out;
}
