// First-boot demo content. Runs once, guarded on the posts table being empty, so anything you
// write survives a reload.
//
// The three seeded documents each exist to demonstrate one claim:
//   hello-world      — post bodies are HTML and their <script> really executes
//   demand-paging    — an <img> whose bytes come out of the media table
//   about (a page)   — pages and posts share a table but get different templates
import type { Db } from './db.js';
import { createPost, type PostType } from './content.js';
import { addMedia } from './media.js';
import { setPostTerms } from './taxonomy.js';

const HELLO = `<p>This paragraph is a <code>TEXT</code> column. The stylesheet around it is a row in
<code>templates</code>. The image further down is a <code>BLOB</code>. Nothing on this page came
off a filesystem — it was all assembled out of SQLite a few milliseconds ago, in your browser,
with no server involved.</p>

<p>A post body is HTML, and it is inserted raw. So a post can carry its own behaviour:</p>

<div id="demo" style="border:1px solid var(--rule);border-radius:10px;padding:16px;margin:22px 0">
  <p style="margin:0 0 10px"><b>This widget shipped inside a database row.</b></p>
  <p style="margin:0 0 12px;font-size:14px;color:var(--muted)" id="demo-ctx">…</p>
  <button id="demo-btn" style="font:inherit;padding:7px 14px;border-radius:7px;border:1px solid var(--rule);background:transparent;color:inherit;cursor:pointer">
    Count a click
  </button>
  <span id="demo-out" style="margin-left:10px;font-variant-numeric:tabular-nums"></span>
</div>

<script>
  // Ordinary inline script. It runs because the rendered page is a real document, not a
  // string dropped into innerHTML.
  var clicks = 0;
  var out = document.getElementById('demo-out');
  document.getElementById('demo-btn').addEventListener('click', function () {
    clicks++;
    out.textContent = clicks + (clicks === 1 ? ' click' : ' clicks');
  });
  document.getElementById('demo-ctx').textContent =
    'Running at ' + location.protocol + ' — document origin: ' + (origin || 'opaque');
</script>

<p>That is the part worth pausing on. The database is not just storing text to be displayed; it
is storing <em>documents</em>, executable content included. Which makes this less a
content-management system and more a very small web host that happens to fit in a table.</p>

<blockquote>WordPress keeps templates on disk and content in MySQL. Here both are in one SQLite
database, and the filesystem is IndexedDB.</blockquote>
`;

const PAGING = `<p>SQLite is <em>demand-paged</em>: its pager reads and writes 4 KB pages as queries
touch them, keeping a small cache in RAM. That property is what most browser SQLite throws
away — <code>sql.js</code> loads the whole file into a <code>Uint8Array</code>, so the database
has to fit in memory and every write rewrites everything.</p>

<p>This site keeps the paged model by giving SQLite a VFS backed by IndexedDB. Each page is one
IndexedDB record, fetched on demand:</p>

<img src="./media/paging.svg" alt="A diagram: query touches three of many pages; only those are read from IndexedDB.">

<p>The image above is worth a second look. Its bytes are a <code>BLOB</code> in the
<code>media</code> table, and the browser fetched it the same way it fetched this HTML — through
the Service Worker when hosted, or as a <code>blob:</code> URL from a
<code>file://</code> page. Same transport, different MIME type.</p>

<p>BLOBs live in overflow pages that SQLite only reads when the column is actually selected. So
the admin's media list — which never selects <code>bytes</code> — stays fast no matter how large
the library gets. The page counter in the footer is real; watch it move as you add content.</p>
`;

const ABOUT = `<p>A demonstration of a CMS with no server component whatsoever: content, theme,
templates and media all live in a single SQLite database, paged out of IndexedDB, rendered in
the browser.</p>

<p>It runs in two modes and picks between them on its own:</p>

<table>
  <tr><th>Context</th><th>How pages are served</th></tr>
  <tr><td>Hosted over http/https</td><td>A Service Worker answers real URLs like
    <code>/p/hello-world/</code> with <code>text/html</code>, so permalinks are shareable and
    view-source shows the served bytes.</td></tr>
  <tr><td>Opened as a file</td><td>No Service Worker is possible, so the same renderer output is
    handed to the frame as a <code>blob:</code> URL. Identical HTML, no network.</td></tr>
</table>

<p>The footer of every page names the transport that produced it.</p>
`;

/** A diagram, stored as a media BLOB so the paging post has something real to reference. */
const PAGING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 200" width="640" height="200" role="img" aria-label="Demand paging diagram">
  <style>
    .lbl{font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;fill:#6b6660}
    .pg{fill:#eceae4;stroke:#d8d4cc}
    .hot{fill:#0f766e;stroke:#0b5c55}
    .hotlbl{font:11px ui-monospace,Menlo,monospace;fill:#fff}
  </style>
  <text class="lbl" x="12" y="24">IndexedDB — one record per 4 KB SQLite page</text>
  <g>
    ${Array.from({ length: 16 }, (_, i) => {
      const hot = i === 2 || i === 7 || i === 12;
      const x = 12 + i * 39;
      return `<rect class="${hot ? 'hot' : 'pg'}" x="${x}" y="40" width="31" height="44" rx="4"/>${
        hot ? `<text class="hotlbl" x="${x + 8}" y="67">${i}</text>` : ''
      }`;
    }).join('')}
  </g>
  <text class="lbl" x="12" y="118">A query touches 3 pages. The other 13 are never read.</text>
  <path d="M12 140 H628" stroke="#d8d4cc" stroke-width="1"/>
  <text class="lbl" x="12" y="166">sql.js would have loaded all 16 — plus the rest of the file — into RAM first.</text>
</svg>
`;

interface SeedDoc {
  type: PostType;
  title: string;
  slug: string;
  body: string;
  excerpt: string;
  categories: string[];
  tags: string[];
}

const DOCS: SeedDoc[] = [
  {
    type: 'post',
    title: 'Hello from inside the database',
    slug: 'hello-world',
    body: HELLO,
    excerpt:
      'This paragraph is a TEXT column, the stylesheet is a row in templates, and the widget below shipped inside a database row and runs.',
    categories: ['Notes'],
    tags: ['sqlite', 'javascript'],
  },
  {
    type: 'post',
    title: 'Demand paging, illustrated',
    slug: 'demand-paging',
    body: PAGING,
    excerpt:
      'SQLite reads 4 KB pages as queries touch them. Keeping that property in the browser is the difference between this and sql.js.',
    categories: ['Notes'],
    tags: ['sqlite', 'indexeddb'],
  },
  {
    type: 'page',
    title: 'About',
    slug: 'about',
    body: ABOUT,
    excerpt: 'What this is and how it serves itself.',
    categories: [],
    tags: [],
  },
];

/** Idempotent: does nothing once there is any content. */
export async function seedContent(db: Db): Promise<boolean> {
  const existing = Number(await db.scalar(`SELECT count(*) FROM posts`)) || 0;
  if (existing > 0) return false;

  await addMedia(db, 'paging.svg', 'image/svg+xml', new TextEncoder().encode(PAGING_SVG));

  for (const doc of DOCS) {
    const id = await createPost(db, {
      type: doc.type,
      title: doc.title,
      slug: doc.slug,
      body: doc.body,
      excerpt: doc.excerpt,
      status: 'published',
    });
    if (doc.categories.length) await setPostTerms(db, id, 'category', doc.categories);
    if (doc.tags.length) await setPostTerms(db, id, 'tag', doc.tags);
  }
  return true;
}
