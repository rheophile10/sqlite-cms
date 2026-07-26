// First-boot demo content. Runs once, guarded on the documents table being empty, so anything
// you write survives a reload.
//
// Authored as real `parts` rather than blobs of HTML, because the demo should exercise the model
// it is demonstrating. Between them these documents use nine widget kinds, a two-level hierarchy,
// tags, categories, a media BLOB and — after the first similarity run — computed relations.
import type { Db } from './db.js';
import { createDocument, type DocumentType } from './documents.js';
import { ensureCollection } from './collections.js';
import { addMedia } from './media.js';
import { setParts, type PartInput } from './parts.js';
import { setDocumentTerms } from './taxonomy.js';

/** A diagram, stored as a media BLOB so the paging entry has something real to reference. */
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

// The widget demo: a live script inside a `prose` part. Post payloads are interpolated raw, so
// this executes — the rendered page is a real document, not a string in innerHTML.
const WIDGET_SCRIPT = `<div id="demo" style="border:1px solid var(--rule);border-radius:10px;padding:16px;margin:4px 0">
  <p style="margin:0 0 10px"><b>This widget shipped inside a database row.</b></p>
  <p style="margin:0 0 12px;font-size:14px;color:var(--muted)" id="demo-ctx">…</p>
  <button id="demo-btn" style="font:inherit;padding:7px 14px;border-radius:7px;border:1px solid var(--rule);background:transparent;color:inherit;cursor:pointer">
    Count a click
  </button>
  <span id="demo-out" style="margin-left:10px;font-variant-numeric:tabular-nums"></span>
</div>
<script>
  var clicks = 0;
  var out = document.getElementById('demo-out');
  document.getElementById('demo-btn').addEventListener('click', function () {
    clicks++;
    out.textContent = clicks + (clicks === 1 ? ' click' : ' clicks');
  });
  document.getElementById('demo-ctx').textContent =
    'Running at ' + location.protocol + ' — document origin: ' + (origin || 'opaque');
</script>`;

interface SeedDoc {
  type: DocumentType;
  title: string;
  slug: string;
  subtitle?: string;
  excerpt: string;
  categories?: string[];
  tags?: string[];
  /** Children, nested to whatever depth. */
  children?: SeedDoc[];
  parts: PartInput[];
}

const DOCS: SeedDoc[] = [
  {
    type: 'post',
    title: 'Hello from inside the database',
    slug: 'hello-world',
    excerpt:
      'A document is not a blob of HTML here — it is an ordered list of typed parts, each rendered by a widget that is itself a row in the database.',
    categories: ['Notes'],
    tags: ['sqlite', 'javascript'],
    parts: [
      {
        kind: 'prose',
        anchor: 'what-this-is',
        data: {
          html: `<p>This paragraph is one <code>part</code>. The widget that rendered it is a row in
          <code>templates</code> called <code>widget:prose</code>. The image further down is a
          <code>BLOB</code>. Nothing on this page came off a filesystem — it was all assembled out
          of SQLite a few milliseconds ago, in your browser, with no server involved.</p>`,
        },
      },
      {
        kind: 'callout',
        anchor: 'the-shape',
        data: {
          title: 'The shape of a document',
          tone: 'note',
          html: `<p>A document has no body column. It has <em>parts</em>: <code>kind</code> naming a
          renderer, <code>data</code> as that renderer's JSON, and <code>text</code> for the search
          index. Which is why a search here can hand you back a paragraph instead of an article.</p>`,
        },
      },
      {
        kind: 'heading',
        anchor: 'executable-content',
        data: { level: 2, text: 'Parts can carry behaviour' },
      },
      {
        kind: 'prose',
        anchor: 'executable-prose',
        data: {
          html: `<p>A part's payload is inserted raw, so it can ship its own script. The rendered
          page is a real document — a <code>blob:</code> URL or a Service Worker response — never a
          string dropped into <code>innerHTML</code>:</p>`,
        },
      },
      {
        kind: 'prose',
        anchor: 'live-widget',
        // The flattening would otherwise index the entire script body as prose.
        text: 'A live widget stored in a database row.',
        data: { html: WIDGET_SCRIPT },
      },
      {
        kind: 'quote',
        anchor: 'the-conceit',
        data: {
          html: `<p>WordPress keeps templates on disk and content in MySQL. Here both are in one
          SQLite database, and the filesystem is IndexedDB.</p>`,
        },
      },
    ],
  },
  {
    type: 'post',
    title: 'Demand paging, illustrated',
    slug: 'demand-paging',
    subtitle: 'Why this is not sql.js',
    excerpt:
      'SQLite reads 4 KB pages as queries touch them. Keeping that property in the browser is the difference between this and loading the whole file into RAM.',
    categories: ['Notes'],
    tags: ['sqlite', 'indexeddb'],
    parts: [
      {
        kind: 'prose',
        anchor: 'the-property',
        data: {
          html: `<p>SQLite is <em>demand-paged</em>: its pager reads and writes 4 KB pages as queries
          touch them, keeping a small cache in RAM. That property is what most browser SQLite throws
          away — <code>sql.js</code> loads the whole file into a <code>Uint8Array</code>, so the
          database has to fit in memory and every write rewrites everything.</p>`,
        },
      },
      {
        kind: 'figure',
        anchor: 'paging-diagram',
        data: {
          src: 'paging.svg',
          alt: 'A query touches three of many pages; only those are read from IndexedDB.',
          caption: `Bytes from the <code>media</code> table, fetched the same way this HTML was.`,
        },
      },
      {
        kind: 'table',
        anchor: 'measured',
        data: {
          caption: 'Measured by the test suite, not asserted here.',
          columns: ['Operation', 'Pages in file', 'Pages read'],
          rows: [
            ['Render one permalink', '227', '21'],
            ['List the media library', '329', '2'],
            ['Fetch one 600 KB BLOB', '329', '152'],
          ],
        },
      },
      {
        kind: 'callout',
        anchor: 'column-order',
        data: {
          title: 'Column order is load-bearing',
          tone: 'warn',
          html: `<p>SQLite stores a row's columns in declaration order, and a large BLOB overflows
          into a page chain. Reading a column positioned <em>after</em> it walks that whole chain.
          Moving <code>media.bytes</code> to the end of the table took one query from 302 pages to
          one.</p>`,
        },
      },
    ],
  },
  {
    type: 'page',
    title: 'About',
    slug: 'about',
    excerpt: 'What this is and how it serves itself.',
    parts: [
      {
        kind: 'prose',
        anchor: 'about-intro',
        data: {
          html: `<p>A demonstration of a CMS with no server component whatsoever: content, theme,
          templates and media all live in a single SQLite database, paged out of IndexedDB, rendered
          in the browser.</p>`,
        },
      },
      {
        kind: 'table',
        anchor: 'transports',
        data: {
          columns: ['Context', 'How pages are served'],
          rows: [
            [
              'Hosted over http/https',
              `A Service Worker answers real URLs like <code>/p/hello-world/</code> with
               <code>text/html</code>, so permalinks are shareable.`,
            ],
            [
              'Opened as a file',
              `No Service Worker is possible, so the same renderer output is handed to the frame as a
               <code>blob:</code> URL. Identical HTML, no network.`,
            ],
          ],
        },
      },
      {
        kind: 'prose',
        anchor: 'about-footer',
        data: { html: `<p>The footer of every page names the transport that produced it.</p>` },
      },
    ],
  },
];

/**
 * A small book, to exercise the hierarchy with something that is not a weblog. Two levels of
 * sections under a `book` document, which is exactly the shape a rule book or a manual takes.
 */
const HANDBOOK: SeedDoc = {
  type: 'book',
  title: 'The Very Short Handbook',
  slug: 'handbook',
  subtitle: 'A book, to show that sections nest',
  excerpt: 'Two levels of hierarchy, so the table of contents has something to draw.',
  parts: [
    {
      kind: 'prose',
      anchor: 'handbook-intro',
      data: {
        html: `<p>A book is a document whose children are chapters, whose children are sections.
        The same <code>parent_id</code> that gives a weblog a flat list gives this a tree.</p>`,
      },
    },
  ],
  children: [
    {
      type: 'chapter',
      title: 'On containers',
      slug: 'on-containers',
      excerpt: 'What a collection is for.',
      parts: [
        {
          kind: 'prose',
          anchor: 'containers-body',
          data: {
            html: `<p>A collection is the shelf. A blog needs one and mostly ignores it; a corpus of
            books needs one each. Documents belong to exactly one.</p>`,
          },
        },
      ],
      children: [
        {
          type: 'section',
          title: 'Ordinals and order',
          slug: 'ordinals-and-order',
          excerpt: 'Author-defined sequence, not chronology.',
          parts: [
            {
              kind: 'prose',
              anchor: 'ordinals-body',
              data: {
                html: `<p>A weblog is ordered by date. A book is ordered by the author. Both live in
                the same table, so a document carries an <code>ordinal</code> as well as a
                <code>created</code>, and the listing query picks which one matters.</p>`,
              },
            },
            {
              kind: 'list',
              anchor: 'ordinals-list',
              data: {
                title: 'Two listing queries, one table',
                items: [
                  '<code>listDocuments</code> — newest first, the weblog view',
                  '<code>listOrdered</code> — by ordinal, the table-of-contents view',
                  '<code>subtree</code> — the whole hierarchy, assembled in one pass',
                ],
              },
            },
          ],
        },
      ],
    },
    {
      type: 'chapter',
      title: 'On parts',
      slug: 'on-parts',
      excerpt: 'Why the atomic unit is smaller than the entry.',
      parts: [
        {
          kind: 'prose',
          anchor: 'parts-body',
          data: {
            html: `<p>Because the useful answer to a question is usually a paragraph, not an
            article. Indexing parts means a query can return the paragraph and link straight to
            it — try searching for <em>ordinal</em>.</p>`,
          },
        },
        {
          kind: 'code',
          anchor: 'parts-sql',
          data: {
            lang: 'sql',
            caption: 'The query the parts model exists to make possible',
            code: `SELECT p.anchor, d.slug, snippet(parts_fts, 0, '«', '»', '…', 20)
  FROM parts_fts
  JOIN parts p     ON p.id = parts_fts.rowid
  JOIN documents d ON d.id = p.document_id
 WHERE parts_fts MATCH ?
 ORDER BY bm25(parts_fts);`,
          },
        },
      ],
    },
  ],
};

/** Insert one document and its subtree, depth-first. */
async function insertDoc(
  db: Db,
  doc: SeedDoc,
  collectionId: number,
  parentId: number,
  ordinal: number,
): Promise<void> {
  const id = await createDocument(db, {
    type: doc.type,
    title: doc.title,
    slug: doc.slug,
    subtitle: doc.subtitle,
    excerpt: doc.excerpt,
    status: 'published',
    collectionId,
    parentId,
    ordinal,
  });
  await setParts(db, id, doc.parts);
  if (doc.categories?.length) await setDocumentTerms(db, id, 'category', doc.categories);
  if (doc.tags?.length) await setDocumentTerms(db, id, 'tag', doc.tags);

  for (const [index, child] of (doc.children ?? []).entries()) {
    await insertDoc(db, child, collectionId, id, index);
  }
}

/** Idempotent: does nothing once there is any content. */
export async function seedContent(db: Db): Promise<boolean> {
  const existing = Number(await db.scalar(`SELECT count(*) FROM documents`)) || 0;
  if (existing > 0) return false;

  await addMedia(db, 'paging.svg', 'image/svg+xml', new TextEncoder().encode(PAGING_SVG));

  const blog = await ensureCollection(db, {
    title: 'Notes',
    slug: 'notes',
    kind: 'blog',
    subtitle: 'The weblog',
  });
  for (const [index, doc] of DOCS.entries()) await insertDoc(db, doc, blog, 0, index);

  const shelf = await ensureCollection(db, {
    title: 'The Very Short Handbook',
    slug: 'handbook-collection',
    kind: 'book',
    subtitle: 'A book, to show that sections nest',
  });
  await insertDoc(db, HANDBOOK, shelf, 0, 0);

  return true;
}
