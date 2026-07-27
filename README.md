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
npm test           # model, routing, widgets, query, cards, edges  (40 tests, Node)
npm run test:e2e   # both transports, plus responsive checks     (22 tests)
npm run demo       # narrated walkthrough + screenshots          (21 steps)
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
cards         link/preview definitions — one per site, one per document
recipients
document_keys per-document encryption keys, sealed per keyholder
```

A document has no `body`. Twelve widget kinds ship built in — `prose`, `heading`, `html`, `code`,
`quote`, `list`, `table`, `callout`, `figure`, `video`, `story`, `sealed` — and an unknown kind falls
back to `html`, so any part renders as something.

Routes:

```
/p/                          index — published posts, newest first
/p/<slug>/                   a document: its parts, its children, its related entries
/p/<slug>/part/<anchor>/     one part, on its own
/p/collection/<slug>/        a collection's table of contents, indented by depth
/p/category/<slug>/          archive
/p/tag/<slug>/               archive
/p/query/?…                  the query page — see below. /p/?… does the same
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

## The URL is the query

Every filter is a URL parameter, so a result set is a link: shareable, bookmarkable, and
back-button-able with no client state. Home doubles as the query page — `/p/?q=pager&tag=sqlite`
and `/p/query/?q=pager&tag=sqlite` are the same thing.

| parameter | |
|---|---|
| `match` | **a raw FTS5 expression, verbatim.** Nothing rewritten; a syntax error is reported, not swallowed |
| `like` | **arbitrary text.** Paste an idea, an error, a paragraph — get the passages closest to it |
| `q` | convenience form: bare words are compiled, real FTS5 syntax passes through |
| `tag`, `category` | slug; repeatable (`?tag=a&tag=b`) or comma-separated (`?tag=a,b`) |
| `terms` | how to combine several of them — `all` (default) or `any` |
| `type` | document type: `post`, `page`, `section`, `chapter`, `book`, `rule` |
| `kind` | part kind: `prose`, `callout`, `code`, `table`, … |
| `collection` | collection slug |
| `sort` | `relevance` (default when `q` is present) · `newest` · `oldest` |
| `group` | `parts` (default) or `documents` — folds the page of passages up to their entries |
| `limit`, `offset` | paging; limit is clamped to 1–200 |

Three ways to say what you are looking for, and they compose (AND-ed):

```
/p/query/?match=NEAR(pager pages, 10)      raw FTS5, used exactly as written
/p/query/?q=pager pages                    compiled for you
/p/query/?like=<a pasted paragraph>        reduced to its content words
/p/query/?match=pager&kind=code&tag=sqlite intersected with the filters
```

`q` guesses — it compiles bare words and passes anything that looks like FTS5 syntax straight
through. That is convenient for a person and wrong for a program, which needs to know that what it
wrote is what runs. `match` is for the program: no heuristic, no rewriting.

And a malformed expression **says so**. An empty result set and a syntax error are indistinguishable
to a caller, which is exactly how a broken query compiler shipped here unnoticed — so `runQuery`
returns the engine's complaint in `error`, and the page shows it. A well-formed expression that
happens to match nothing is not an error, and the two stay distinct.

Results are **passages**, each with its own URL. Facet counts are computed over the matching set
rather than the whole site, so a filter that would return nothing is never offered — and every
facet, sort and page control on the page is a plain link that toggles one parameter. There is no
JavaScript state to get out of step with the address bar.

`/p/search/?q=…` still works as an alias for links made before the vocabulary existed.

## Edges

`relations` is polymorphic on `(scope, id)` so the same edge types work between whole documents and
between individual parts. It carries a `confidence`, an `origin` — `manual`, `tfidf`, `number_match`,
`import` — and a nullable `metadata` JSON column for whatever a future edge type needs (a page
reference, a span, a score breakdown) without another migration. **NULL by default, not `{}`**: an
edge with nothing extra to say should say nothing, and the two states must stay distinguishable.

Types: `similar`, `equivalent`, `see_also`, `supersedes`/`superseded_by`, `derived_from`,
`cross_reference`, `amends`, `tests`, `references`. Symmetric and inverse types get their other
direction written automatically so navigation works from both ends — except `tfidf`, where cosine is
symmetric and a bulk run reaches the reverse edge on its own.

This is deliberately the shape CROR's `rail-document-db` already exports: `from_kind`/`to_kind`,
`link_type`, `confidence`, `origin`. Its 51,383 edges — 50,403 `similar` from tfidf, 944 `equivalent`
from number matching, 36 `tests` from flashcards — map straight onto this table, with a rule and a
flashcard both being documents.

## Link previews, and the thing that makes them not work

`cards` holds the definition — title, description, image, Twitter card kind — one row for the site
and one per document, resolved **override-then-fallback at the field level**, so a document that sets
only a title still inherits the site's image. Anything still missing is derived from the document, so
a site gets usable cards without anybody authoring one.

The image is a media slug (or an absolute URL). Bytes go in **SQLite, as media** — a card is ~100 KB,
it belongs to the content, it should replicate with the database, and `/p/media/<slug>` already serves
it. `idb-vfs-store` earns its keep streaming a 2 GB video with range reads; a preview image would
gain nothing and split the media library across two stores.

**But a crawler will never see a card this renderer produces.** Twitter, Slack, Facebook and iMessage
fetch a URL with a plain HTTP client: they run no JavaScript, and a Service Worker is a browser
facility that was never installed for them. A preview that exists only in our rendered HTML is
invisible to precisely the audience it is for. So cards need two things, and both are load-bearing:

1. the tags in the served HTML — `cardFor()` and the `layout` template — so view-source is honest;
2. **static files**: the image at a real URL, and a stub per permalink carrying the same tags. See
   `rheophile-web-cms/og.mjs`, which also makes shared permalinks work without the 404 shim.

Without (2) the card is decoration.

## Who is reading

`RenderOptions.viewer` is `{signedIn, email?, name?, portal?}`, supplied by the shell and **never
stored**. Authentication belongs to whatever owns the session; the renderer only needs enough to draw
an account chip, and the schema has no session table for that reason.

For rheophile.ca that owner is the Supabase-backed **appkit portal** at `/apps/`. Same origin, same
project, so its token lands in the page's `localStorage` and the shell just reads it — no Supabase
client, no keys, no network. See `rheophile-web-cms/src/session.ts`.

At `file://` there is no shared origin and no portal, so there is no session: the chip renders as a
plain Login link. That is the truth rather than a degraded mode — a Supabase session needs a server,
and this runs without one.

A `localStorage` read is a **UI hint, not authority**. Anything that actually needs protecting is
protected by the per-document encryption below, not by whether a chip is drawn.

## Finding out whether you tried this before

Two things aimed at that question specifically.

**`?like=<text>`.** Paste a paragraph and get ranked passages. The implementation is smaller than it
sounds, because **`bm25()` already weights by inverse document frequency**: strip the stop words,
keep the most repeated content words, OR them together, and let the engine's own ranking decide. No
corpus in memory, no model, no vectors. The derived terms come back with the results and the page
shows them — *matched on `database` `pages` `memory`* — because an unexplained similarity hit is not
worth much.

Composes with everything else: `?like=…&kind=code`, or with `q` for "the words I insisted on, among
the passages that look like what I pasted". The whole paste lives in the URL, so a result set is
still a link.

**Stemming.** Both FTS indexes use FTS5's `porter` tokenizer. Without it a search is morphologically
literal — measured against this build, `paging` found *nothing* in text that says "demand-paged", and
`read` found nothing in text that says "reads". Both are one hit with it.

That trade has a cost worth stating plainly. Prefix matching against a stemmed index is **inherently
patchy**: the stem is shorter than the word, so a typed prefix longer than the stem can never match.
Measured: for "paging", 3 characters hits, 4 and 5 miss, 6 hits; for "tokenizer", 6 and 7 miss. No
amount of truncating the prefix rescues it. So bare words are compiled to `("word" OR "word"*)` — the
exact form always hits once a word is complete, and the prefix helps when it can. If live type-ahead
on partial words ever matters more than finding "demand-paged" from "paging", the tool is a second
index on the `trigram` tokenizer (available in this build), not giving up stemming.

Databases built before the tokenizer changed are migrated rather than left behind:
`CREATE VIRTUAL TABLE IF NOT EXISTS` will not change a tokenizer, so `migrateFtsTokenizer` detects it
from the stored DDL, drops, recreates and rebuilds. Safe because both indexes are external-content —
the rows live in `documents` and `parts`, so an FTS table is a derived artifact.

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

`src/` is grouped by what each thing is responsible for, which is also the order data flows through
it — rows come out of `engine`, get shape from `model`, become HTML in `view`, and reach the browser
via `serve`:

```
src/
  engine/   the SQLite seam. db.ts, and the generated wasm payload
  model/    the content model — one file per concern, no HTML anywhere
  view/     rows to HTML — the template language, the theme, widgets, the router
  serve/    how those bytes reach the frame: Service Worker or blob:
  admin/    the editing UI
```

| file | |
|---|---|
| `engine/db.ts` | wasm, VFS registration, the serialized query queue. Copied from the reference implementation |
| `engine/wasm.js` | **generated** by `embed.mjs` — base64 of `crsqlite.wasm`, so the built page makes zero network requests. Gitignored; `wasm.d.ts` types it |
| `model/schema.ts` | the model, plus the v1→v2 migration |
| `model/documents.ts` | documents: CRUD, slugs, the hierarchy, title search |
| `model/parts.ts` | parts: typed payloads, derived text, part-level search |
| `model/collections.ts` | blogs, books, shelves |
| `model/relations.ts` | typed edges, and the "related" queries |
| `model/query.ts` | the URL parameter vocabulary: parse, serialize, run, facet |
| `model/cards.ts` | link-preview definitions, and why a crawler cannot see them |
| `model/similarity.ts` | TF-IDF cosine — pure function plus a db-writing wrapper |
| `model/taxonomy.ts` | categories and tags |
| `model/media.ts` | the media library, as BLOBs |
| `model/settings.ts` | site options |
| `model/seed.ts` | demo content, authored as real parts |
| `view/template.ts` | the template language (`{{x}}`, `{{{raw}}}`, `{{#each}}`, `{{#if}}`) |
| `view/theme.ts` | default page templates and the stylesheet, seeded as rows |
| `view/widgets.ts` | part → HTML, through a template named `widget:<kind>` |
| `view/render.ts` | **the router and renderer.** Path in, status + MIME + body out. DOM-free, so Node can test it |
| `serve/transport.ts` | picks Service Worker or `blob:` from the environment; the only file needing a DOM |
| `admin/main.ts` | admin UI wiring |
| `public/sw.js` | the web server, when there is one. Owns no data — asks a page and wraps the answer in a `Response` |
| `public/404.html` | 1 KB shim so a shared permalink works on a first-ever visit, before any worker exists |
| `serve.mjs` | static server for the hosted path |
| `demo/` | a narrated walkthrough — see below |

## Three ways to check it

| | what it answers |
|---|---|
| `npm test` | 40 Node tests: the model, routing, widgets, the query vocabulary, cards, edges, similarity, paging. Fast, no browser |
| `npm run test:e2e` | 22 Chromium tests: both transports, and no horizontal overflow at 390/768/1440 px |
| `npm run demo` | *Show me it working.* Drives the built app through 21 narrated steps, screenshots each one, prints measured values rather than ticks. `--headed` to watch. See [`demo/`](demo) |

## Mobile and desktop

Every page has to hold up on a phone, and that is asserted rather than assumed. `test/e2e.test.mjs`
loads the content-heaviest entry at **390 / 768 / 1440 px** and requires **zero horizontal
overflow** — in the rendered frame, in the admin shell, and on the query page, which has the most
controls to wrap. Overflow is the right thing to assert because it is objective: a table, a code
block or a wide image escaping its column shows up as a number, not an opinion.

The reflow itself is asserted on the computed value rather than on the media query: the paired
narration-and-clip `story` grid must be one column at 390 px and two at 1440 px. Wide content —
tables, `pre`, the raw-embed frame — scrolls inside its own container rather than pushing the page
sideways.

## Rendering without a shell

`RenderOptions.standalone` omits the navigation bridge. The bridge exists because the frame's parent
owns the address bar; a page prerendered to a static file owns its own, so intercepting clicks would
break every link. With `standalone` set, links, fragments and the search form behave like ordinary
HTML — which is what makes it possible to generate a static site out of the same renderer that serves
the live one.

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

## Ten things that will bite you

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

**7. `Number(null)` is `0`, and `0` is finite.** A `Number.isFinite` guard therefore cannot tell an
absent URL parameter from a real zero. `?limit=` missing fell straight through the guard and got
clamped to the *minimum*, so every query page returned exactly one result. Absent has to be checked
before coercing.

**8. `[hidden]` loses to a class.** `.admin { display:flex }` outranks the UA stylesheet's
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
