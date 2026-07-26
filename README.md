# A CMS whose HTML is served out of SQLite

A WordPress-shaped content management system with **no server component at all**. Posts, pages,
categories, tags, theme templates, CSS and image bytes all live in one **demand-paged SQLite
database** inside the browser. A page view is a `SELECT`.

The interesting question is not "can you store HTML in a database" — obviously you can. It is
**how the HTML gets *served*** when there is nothing to serve it. This answers that twice, and
picks between them by looking at where it is running:

| Context | Transport | What the URL looks like |
|---|---|---|
| Hosted over `http`/`https` | A **Service Worker** intercepts `fetch` and answers from SQLite with a real `text/html` `Response` | `https://…/p/hello-world/` — shareable, `view-source` shows the served bytes |
| Opened as a `file://` document | No Service Worker is possible, so the same renderer output becomes a **`blob:` URL** | `blob:null/…` — no network, no server, no origin |

Both call the same `renderPath()`. There is exactly one description of what the site looks like;
only the plumbing differs. Built on
[`browser-sqlite/wa-sqlite-idb-demo`](../../browser-sqlite/wa-sqlite-idb-demo).

```sh
npm install
npm run dev        # vite dev server
npm run build      # → docs/index.html (self-contained) + docs/sw.js
npm run serve      # static server, so the Service Worker path is reachable
npm test           # routing, templates, content model, paging  (15 tests, Node)
npm run test:e2e   # both transports in real Chromium         (12 tests)
```

Then either open `docs/index.html` by double-clicking it, or `npm run serve` and visit
<http://localhost:8787/>. Same database, same output, different transport — the footer of every
rendered page names which one produced it.

## Why demand paging is the whole point

Ordinary file-based SQLite reads and writes 4 KB pages as queries touch them. Most SQLite-in-the-browser
throws that away: `sql.js` loads the entire file into a `Uint8Array`, so the database must fit in
RAM and every write rewrites everything. That is survivable for a todo list and fatal for a CMS
with a media library.

Keeping the paged model means a page view costs only the pages it touches. Measured, from `npm test`:

```
227 pages in file, one permalink render faulted in 21
329 pages in file · listMedia faulted in 2 · one 600 KB BLOB took 152
```

Rendering a permalink out of a 227-page database reads 21 pages. Listing a media library holding
1.2 MB of images reads **2**. That second number is the one to look at, and it took a schema fix
to get — see below.

## Layout

| file | |
|---|---|
| `src/db.ts` | engine seam: wasm, VFS registration, serialized query queue. Copied from the reference implementation |
| `src/schema.ts` | the content model — posts, terms, media, templates, settings, FTS5 |
| `src/content.ts` | posts and pages: CRUD, slugs, FTS5 search |
| `src/taxonomy.ts` | categories and tags |
| `src/media.ts` | the media library, as BLOBs |
| `src/theme.ts` | default templates — seeded as *rows*, editable in the admin |
| `src/template.ts` | the template language (`{{x}}`, `{{{raw}}}`, `{{#each}}`, `{{#if}}`) |
| `src/render.ts` | **the router and renderer.** Takes a path, returns status + MIME + body. DOM-free, so Node can test it |
| `src/transport.ts` | picks Service Worker or `blob:` from the environment; the only file needing a DOM |
| `public/sw.js` | the web server, when there is one. Owns no data — asks a page and wraps the answer in a `Response` |
| `public/404.html` | 1 KB shim so a shared permalink works on a first-ever visit, before any worker exists |
| `src/seed.ts` | first-boot demo content |
| `src/main.ts` | admin UI wiring |
| `serve.mjs` | static server for the hosted path |

## The theme is data

Templates are rows in a `templates` table, including the stylesheet. Editing the theme is editing
the database, and the Theme tab in the admin does exactly that. WordPress keeps templates on disk
and content in MySQL; here both are in the one SQLite file, and the "disk" is IndexedDB.

Deleting a template row cannot brick the site — `getTemplate` falls back to the built-in, because a
user-editable table is not a trustworthy source of a required value.

## Post bodies are documents, not strings

A body is HTML, interpolated raw (`{{{post.body}}}`), and the result is loaded as a real document —
a `blob:` URL or a Service Worker `Response`, never `innerHTML`. So a post can carry its own
behaviour, and the seeded `hello-world` post ships a working `<script>` to prove it. The e2e suite
clicks the button it installs and asserts the counter increments.

This is also why the escaping distinction in `template.ts` is load-bearing rather than cosmetic:
`{{title}}` escapes, `{{{body}}}` does not.

## Five things that will bite you

Each of these cost real debugging time and is verified by a test.

**1. Column order decides whether a BLOB is free to ignore.** SQLite stores a row's columns in
declaration order, and a large BLOB spills into an overflow page chain. Reading a column positioned
*after* the BLOB means walking that whole chain to reach it. With `bytes` declared in the middle of
`media`, `SELECT size, created FROM media` cost **302 pages of a 327-page database**. Moving `bytes`
to the end made the same query cost **1**. Nothing about the query changed.

**2. A permalink lookup needs its own index.** `posts_slug` is `(type, slug)`, but resolving
`/about/` knows the slug and not the type, so it cannot use an index whose leading column is `type`.
Without a separate `(slug, status)` index every page view full-scanned `posts` — which on a
demand-paged database means reading essentially the whole file. A page view went from 171 pages to
21.

**3. An opaque-origin document cannot load `blob:` subresources.** At `file://`, the rendered page
is a `blob:` document with an opaque origin. Pointing an `<img>` at another `blob:` URL — created by
the parent, holding bytes straight from SQLite — is rejected outright: *Not allowed to load local
resource*. Navigating the frame to a blob document is fine; loading a blob *from inside* one is not.
Media therefore has to be inlined as `data:` URIs in that mode, at the cost of base64's 33 %
inflation.

**4. Not every client can answer for the Service Worker.** The worker holds no data — it asks a page
and wraps the reply. But a permalink served at the top level *is* rendered output: an ordinary
document with no application JavaScript in it. Asking it to render its own `<img>` stalls for the
full timeout and then 503s. So the shell announces itself (`cms:hello`) and only announced clients
are ever asked.

**5. The shell is not always at the shell's URL.** When the worker answers a cold permalink it
serves the shell bytes at `/p/hello-world/`, so `new URL('./', location.href)` reports the
*permalink's* directory. Everything derived from it — the content base, the `sw.js` registration
path — comes out wrong. The shell directory has to be recovered from the content segment instead.

## Serving, in detail

Content lives under a `/p/` prefix so it can never collide with the shell document, which stays at
`index.html`. Routes:

```
/p/                     index — published posts, newest first
/p/<slug>/              a post or page
/p/category/<slug>/     archive
/p/tag/<slug>/          archive
/p/search/?q=…          FTS5, ranked by bm25(), snippets marked
/p/media/<slug>         raw bytes, with the stored MIME type
```

In hosted mode a cold navigation to `/p/hello-world/` has no page to ask, so the worker serves the
app shell, which boots, reads `location.pathname`, hides the admin chrome and renders that
permalink. The URL stays real and shareable either way; on a cold load the HTML is composed a few
hundred milliseconds later by the page rather than arriving pre-rendered.

A **first-ever** visit to a shared link is different again: there is no worker yet *and* no file on
disk at that path, so nothing intercepts. `public/404.html` handles it — a 1 KB shim that every
static host (GitHub Pages included) serves for unmatched paths. It hands the requested path to the
shell as `?p=…`, and the shell puts it back with `replaceState`, so the address bar still ends up
showing the permalink that was shared. Once the worker is installed it intercepts first and the shim
is never reached again.

`serve.mjs` follows the same 404 rule as GitHub Pages deliberately, so that path is covered by the
test suite rather than only discovered in production. A genuine 404 — anything without the content
prefix — is left where it is instead of being bounced.

To deploy on GitHub Pages: enable Pages for `/docs` on `main`. No build configuration is needed;
`docs/` already contains the three files it serves.

## Inherited constraints

From the reference implementation, and they still apply:

1. **One statement at a time per connection.** A connection is a single Asyncify state machine.
   `src/db.ts` funnels every statement through one queue. This matters more here than in the
   original demo: a rendered page fires one request per `<img>`, and the worker answers them all
   from the same connection.
2. **`fake-indexeddb` does not test a VFS.** Hence `test/e2e.test.mjs`.
3. Schema written to stay CRDT-compatible: every column has a `DEFAULT`, primary keys are
   non-nullable, and ids are random rather than autoincrement — two offline replicas both picking
   `max(id)+1` would collide. cr-sqlite is compiled into this build, so promoting the tables to
   CRRs is a later change of mind, not a rewrite.
4. An FTS5 table cannot itself be a CRR, so `posts_fts` is a derived local artifact maintained by
   triggers.

## Credits

[wa-sqlite](https://github.com/rhashimoto/wa-sqlite) (Roy Hashimoto) ·
[cr-sqlite](https://github.com/vlcn-io/cr-sqlite) (Matt Wonlaw)
