# A CMS whose HTML is served out of SQLite

A content management system with **no server component at all**. Documents, their parts, the theme
templates, the CSS and the image bytes all live in one **demand-paged SQLite database** in the
browser. A page view is a `SELECT`.

Two things make it more than a weblog in a database:

**Documents are made of parts, not HTML.** A part is a `kind` naming a widget renderer, a `data`
JSON payload for that renderer, and a flattened `text` for search. So the search index is over
*passages*, and a query returns the paragraph — addressable at its own URL — rather than a whole
entry you then scan by eye. Widget renderers are themselves rows in the database, so adding a kind
of content means adding a row.

**Documents nest.** `parent_id` + `ordinal` gives sections, subsections and chapters, so the same
schema holds a weblog and a book with a table of contents. Related entries come from TF-IDF cosine
similarity computed in the browser tab.

## Serving

The transport is chosen from where the page is running, not configured:

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
npm run build      # → docs/index.html (self-contained) + docs/sw.js + docs/404.html
npm run serve      # static server, so the Service Worker path is reachable
npm test           # model, routing, widgets, similarity, paging  (25 tests, Node)
npm run test:e2e   # both transports in real Chromium            (17 tests)
```

Then either open `docs/index.html` by double-clicking it, or `npm run serve` and visit
<http://localhost:8787/>. Same database, same output, different transport — the footer of every
rendered page names which one produced it.

## The model

```
collections   a blog, or a book, or a shelf
documents     posts, pages, chapters, sections, numbered rules — one table, arranged as a tree
parts         ordered typed blocks inside a document; the atomic unit
relations     typed edges between documents or parts, with a confidence and an origin
terms         categories and tags
media         metadata + bytes
templates     page templates, widget renderers, and the stylesheet
recipients
document_keys per-document encryption keys, sealed per keyholder
```

A document has no `body`. Nine widget kinds ship built in — `prose`, `heading`, `code`, `quote`,
`list`, `table`, `callout`, `figure`, `video`, `story`, `html`, `sealed` — and an unknown kind falls
back to `html`, so any part renders as something.

Routes:

```
/p/                          index — published posts, newest first
/p/<slug>/                   a document: its parts, its children, its related entries
/p/<slug>/part/<anchor>/     one part, on its own
/p/collection/<slug>/        a collection's table of contents, indented by depth
/p/category/<slug>/          archive
/p/tag/<slug>/               archive
/p/search/?q=…               FTS5 over parts, ranked by bm25(), snippets marked
/p/media/<slug>              raw bytes, with the stored MIME type
```

## Relatedness

`similarity.ts` is a port of CROR's `rail-document-db/pipelines/similarity.py`: TF-IDF vectors,
cosine similarity, no dependencies and no network. Scoring goes through an inverted index rather
than comparing every pair, which is what makes it viable to run in a tab. It writes
`relations(type='similar', origin='tfidf')` with a confidence, clearing only its own edges so
authored links survive. Scope is whole documents or individual parts.

The algorithm is deliberately crude. Its docstring in the original anticipates the upgrade path and
it still holds: when embeddings are available, keep this shape, add a vectors table, swap the vector
source. `relations` and every consumer of it stay as they are.

## Demand paging is the whole point

Ordinary file-based SQLite reads and writes 4 KB pages as queries touch them. `sql.js` loads the
entire file into a `Uint8Array`, so the database must fit in RAM and every write rewrites
everything. That is survivable for a todo list and fatal for a corpus. Measured, from `npm test`:

```
418 pages in file, one permalink render faulted in 44
357 pages in file · listMedia faulted in 2 · one 600 KB BLOB took 152
```

Both numbers took a schema fix to get. See below.

## Layout

| file | |
|---|---|
| `src/db.ts` | engine seam: wasm, VFS registration, serialized query queue. Copied from the reference implementation |
| `src/schema.ts` | the model, plus the v1→v2 migration |
| `src/documents.ts` | documents: CRUD, slugs, the hierarchy, title search |
| `src/parts.ts` | parts: typed payloads, derived text, part-level search |
| `src/widgets.ts` | part → HTML, through a template named `widget:<kind>` |
| `src/collections.ts` | blogs, books, shelves |
| `src/relations.ts` | typed edges, and the "related" queries |
| `src/similarity.ts` | TF-IDF cosine — pure function plus a db-writing wrapper |
| `src/taxonomy.ts` | categories and tags |
| `src/media.ts` | the media library, as BLOBs |
| `src/theme.ts` | default page templates and the stylesheet, seeded as rows |
| `src/template.ts` | the template language (`{{x}}`, `{{{raw}}}`, `{{#each}}`, `{{#if}}`) |
| `src/render.ts` | **the router and renderer.** Path in, status + MIME + body out. DOM-free, so Node can test it |
| `src/transport.ts` | picks Service Worker or `blob:` from the environment; the only file needing a DOM |
| `public/sw.js` | the web server, when there is one. Owns no data — asks a page and wraps the answer in a `Response` |
| `public/404.html` | 1 KB shim so a shared permalink works on a first-ever visit, before any worker exists |
| `src/seed.ts` | demo content, authored as real parts |
| `src/main.ts` | admin UI wiring |
| `serve.mjs` | static server for the hosted path |

## The theme is data

Page templates, widget renderers and the stylesheet are all rows in `templates`. Editing the theme
is editing the database, and the Theme tab does exactly that — including `widget:prose`, which
changes how every prose part in the site renders. Deleting a row cannot brick the site;
`getTemplate` falls back to the built-in, because a user-editable table is not a trustworthy source
of a required value.

## Parts are documents, not strings

A payload is interpolated raw (`{{{html}}}`) and the result is loaded as a real document — a `blob:`
URL or a Service Worker `Response`, never `innerHTML`. So a part can carry its own behaviour, and
the seeded `hello-world` entry ships a working `<script>`; the e2e suite clicks the button it
installs and asserts the counter increments.

This is why the escaping distinction in `template.ts` is load-bearing rather than cosmetic:
`{{title}}` escapes, `{{{html}}}` does not.

## Encryption (schema only, so far)

`documents.visibility`, `recipients` and `document_keys` are in place for per-document encryption:
a protected document's parts are stored `sealed` under a content key of their own, and that key is
sealed once per recipient with an X25519 sealed box. Handing somebody a private key then lets them
read exactly the documents sealed to them and nothing else — distinct from a whole-vault passcode,
which is all-or-nothing.

The crypto that fills those tables is not written yet; it will come from
[`browser-vfs/idb-vfs-crypto`](../../browser-vfs/idb-vfs-crypto), which already supplies the
primitives. What *is* implemented is the consequence that is easy to get wrong: a `sealed` part
contributes the empty string to the FTS index, never its text. An index over content the reader
cannot decrypt would leak it — `snippet()` would happily quote it back.

## Seven things that will bite you

Each of these cost real debugging time and is verified by a test.

**1. Column order decides whether a BLOB is free to ignore.** SQLite stores a row's columns in
declaration order, and a large BLOB spills into an overflow page chain. Reading a column positioned
*after* it means walking that whole chain. With `bytes` mid-table, `SELECT size, created FROM media`
cost **302 pages of a 327-page database**. Moving `bytes` last made the same query cost **1**.

**2. An index's leading column decides whether it exists.** Three separate versions of this:
`documents_slug` is `(type, slug)` but a permalink knows only the slug, so resolving one full-scanned
until `(slug, status)` was added — 171 pages to 21. Making `documents_listing` lead with
`collection_id` broke the weblog query that filters `type`+`status` — 339 pages of 417. And
`listParts` filters `document_id` *and* `parent_id = 0`, so given only `(parent_id, ordinal)` the
planner picked that index and scanned every top-level part in the database.

**3. A TF-IDF ceiling tuned for thousands of documents finds nothing in four.** Dropping terms that
appear in more than 30 % of the corpus is a clear win at scale and actively wrong below it: with four
documents, `0.3 × 4 = 1.2` drops every term appearing in more than one — which is every term that
could indicate similarity. Result: silently zero edges. Below 20 documents the ceiling is now only
"appears in literally everything", where idf is exactly 0.

**4. An opaque-origin document cannot load `blob:` subresources.** At `file://` the rendered page is
a `blob:` document with an opaque origin. Pointing an `<img>` at another `blob:` URL — created by the
parent, holding bytes from SQLite — is rejected outright: *Not allowed to load local resource*.
Navigating the frame *to* a blob document is fine; loading one *from inside* is not. Media is
therefore inlined as `data:` URIs in that mode, at the cost of base64's 33 % inflation.

**5. Not every client can answer for the Service Worker.** The worker holds no data — it asks a page
and wraps the reply. But a permalink served at the top level *is* rendered output: an ordinary
document with no application JavaScript in it. Asking it to render its own `<img>` stalls for the
full timeout and then 503s. So the shell announces itself (`cms:hello`) and only announced clients
are ever asked.

**6. The shell is not always at the shell's URL.** When the worker answers a cold permalink it serves
the shell bytes at `/p/hello-world/`, so `new URL('./', location.href)` reports the *permalink's*
directory, and everything derived from it — the content base, the `sw.js` registration path — comes
out wrong. The shell directory has to be recovered from the content segment instead.

**7. `[hidden]` loses to a class.** `.admin { display:flex }` outranks the UA stylesheet's
`[hidden] { display:none }`, so hiding the admin for a standalone permalink silently did nothing
until `.admin[hidden]` said so explicitly.

## Inherited constraints

From the reference implementation, and they still apply:

1. **One statement at a time per connection.** A connection is a single Asyncify state machine.
   `src/db.ts` funnels every statement through one queue. This matters more here: a rendered page
   fires one request per `<img>`, and the worker answers them all from the same connection.
2. **`fake-indexeddb` does not test a VFS.** Hence `test/e2e.test.mjs`.
3. Schema written to stay CRDT-compatible: every column has a `DEFAULT`, primary keys are
   non-nullable, absent parents are `0` rather than `NULL`, and ids are random rather than
   autoincrement — two offline replicas would collide on `max(id)+1`. cr-sqlite is compiled into
   this build, so promoting the tables to CRRs is a later change of mind, not a rewrite.
4. An FTS5 table cannot itself be a CRR, so both indexes are derived local artifacts maintained by
   triggers.

## Deploying

Enable GitHub Pages for `/docs` on `main`. No build configuration is needed; `docs/` already
contains the three files it serves, and `404.html` is what makes a shared permalink work for someone
visiting it for the first time.

## Credits

[wa-sqlite](https://github.com/rhashimoto/wa-sqlite) (Roy Hashimoto) ·
[cr-sqlite](https://github.com/vlcn-io/cr-sqlite) (Matt Wonlaw) · similarity ported from this
repo's own `CROR/rail-document-db`
