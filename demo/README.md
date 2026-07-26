# demo — a narrated walkthrough

```sh
npm run demo          # build, then drive the built app headless
npm run demo:headed   # the same, in a visible browser, slowed down enough to watch
```

Not a third test suite. `npm test` and `npm run test:e2e` are assertion-shaped and quiet — they
answer *is anything broken*. This answers *show me it working*: it drives the real built page
through every capability in order, narrates each step with a timing and a one-line result, drops a
screenshot per step into `screenshots/`, and exits non-zero if anything fails.

Useful when you have been away from the project, when a dependency moved under you, or when you want
evidence rather than a green tick.

## What it covers

Twenty steps, both transports:

**`file://` — no server anywhere.** Boots SQLite from a double-clicked HTML file, confirms the
`blob:` transport was chosen, renders the seeded index from templates that are database rows, clicks
the button installed by a `<script>` living inside a part, and decodes an image whose bytes are a
`BLOB` inlined as a `data:` URI.

**Documents nest.** A collection's table of contents indented by depth, then a descent to a leaf
showing the ancestor chain.

**Search returns the passage.** FTS5 over parts ranked by `bm25()` with marked snippets, then
following a hit to that part on its own URL.

**Authoring and relatedness.** Writes a new post through the parts editor whose prose paraphrases an
existing entry, runs TF-IDF cosine similarity in the tab, and confirms the computed `similar` edge
shows up in the rendered *Related* block. Then adds a typed `callout` part and watches it render
through `widget:callout`. Then feeds the editor malformed JSON and confirms it is refused with a
message naming the part, rather than silently dropped. Then reloads to prove all of it was in
IndexedDB.

**Hosted — real URLs.** Registers the Service Worker, then does the thing that makes the claim
concrete: an ordinary `fetch('/p/hello-world/')` from page JavaScript, checking the status line, the
content type and the bytes. Media with its own content type by the same mechanism. A real 404. A
shareable permalink opened standalone in a fresh tab. And a first-ever visit with no worker
installed, which goes through `404.html` and must still land on the right URL.

## Reading the output

Each line is `step … ok <ms> — <note>`. The note is the interesting part: it carries the measured
value rather than just a tick, so the run is evidence.

```
opens a double-clicked HTML file and boots SQLite … ok 1933 ms — 64 pages
a part carries its own <script>, and it runs … ok 395 ms — 02-live-widget.png — counter reads "2 clicks"
cosine similarity links it to the entry it paraphrases … ok 435 ms — 09-related-entries.png — 8 document(s) vectorized → 6 similar edge(s)
an ordinary fetch() of a permalink returns real text/html from SQLite … ok 24 ms — 200 text/html; charset=utf-8, 11889 bytes
```

`screenshots/` is generated and gitignored — it is wiped at the start of every run.

## Note

The walkthrough **writes to the demo database**: it authors a post, adds a part, and computes
similarity edges. That is deliberate — authoring is one of the things being demonstrated — but it
means the `file://` IndexedDB store is left with an extra entry afterwards. Wipe it from the admin's
Settings tab, or from DevTools → Application → IndexedDB → `cms-site`.
