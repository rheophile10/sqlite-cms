// Exercises the claims this project makes, against the real modules in src/ — the router, the
// template engine, the content model, the hierarchy, part-level search, TF-IDF relatedness, and
// demand paging over BLOB media.
//
// render.ts is deliberately DOM-free, so the entire serving path except the transport swap can be
// tested here. The two transports themselves need a browser and live in e2e.test.mjs.
import { pageReads } from './shim.mjs'; // must be first: installs IndexedDB + Web Locks
import assert from 'node:assert/strict';
import test from 'node:test';

const B = '../.build-test/';
const { openDatabase } = await import(B + 'engine/db.js');
const { migrate, pageStats, flattenHtml } = await import(B + 'model/schema.js');
const {
  ancestorsOf,
  childrenOf,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  listOrdered,
  reorder,
  searchDocuments,
  slugify,
  subtree,
  updateDocument,
} = await import(B + 'model/documents.js');
const { ensureCollection, listCollections } = await import(B + 'model/collections.js');
const {
  addPart,
  allParts,
  deriveText,
  documentText,
  getPartByAnchor,
  listParts,
  partData,
  searchParts,
  setParts,
  updatePart,
} = await import(B + 'model/parts.js');
const { renderPart, renderParts, DEFAULT_WIDGETS } = await import(B + 'view/widgets.js');
const { link, unlink, relatedDocuments, clearByOrigin, countRelations } = await import(
  B + 'model/relations.js'
);
const { cosineNeighbours, computeSimilar, tokenize } = await import(B + 'model/similarity.js');
const { addMedia, getMediaBySlug, listMedia, countMedia } = await import(B + 'model/media.js');
const { setDocumentTerms, listTerms, termsForDocument } = await import(B + 'model/taxonomy.js');
const { renderPath, renderPreview, routeOf, clip, formatDate } = await import(B + 'view/render.js');
const { renderTemplate, escapeHtml } = await import(B + 'view/template.js');
const { seedTheme, getTemplate, setTemplate, loadTemplates } = await import(B + 'view/theme.js');
const { seedSettings, setSetting } = await import(B + 'model/settings.js');
const { seedContent } = await import(B + 'model/seed.js');

const OPTIONS = { base: '/p/', transport: 'test' };

/** A fully migrated, seeded site. */
async function site(idbName, { seed = true } = {}) {
  const db = await openDatabase({ idbName });
  await migrate(db);
  await seedTheme(db);
  await seedSettings(db);
  if (seed) await seedContent(db);
  return db;
}

const html = async (db, path, options = OPTIONS) => {
  const served = await renderPath(db, path, options);
  assert.equal(served.kind, 'html', `expected HTML for ${path}`);
  return served;
};

// ─────────────────────────────────────── routing ───────────────────────────────────────

test('routeOf maps paths to routes, base and trailing slashes optional', () => {
  assert.deepEqual(routeOf('/p/', '/p/'), { name: 'index' });
  assert.deepEqual(routeOf('/p', '/p/'), { name: 'index' });
  assert.deepEqual(routeOf('', '/p/'), { name: 'index' });
  assert.deepEqual(routeOf('/p/index.html', '/p/'), { name: 'index' });

  assert.deepEqual(routeOf('/p/hello-world/', '/p/'), { name: 'document', slug: 'hello-world' });
  assert.deepEqual(routeOf('/p/hello-world', '/p/'), { name: 'document', slug: 'hello-world' });
  assert.deepEqual(routeOf('hello-world/', '/p/'), { name: 'document', slug: 'hello-world' });

  assert.deepEqual(routeOf('/p/category/notes/', '/p/'), {
    name: 'archive',
    kind: 'category',
    slug: 'notes',
  });
  assert.deepEqual(routeOf('/p/tag/sqlite/', '/p/'), { name: 'archive', kind: 'tag', slug: 'sqlite' });
  assert.deepEqual(routeOf('/p/media/paging.svg', '/p/'), { name: 'media', slug: 'paging.svg' });
  assert.deepEqual(routeOf('/p/collection/notes/', '/p/'), { name: 'collection', slug: 'notes' });

  // A part addressed on its own.
  assert.deepEqual(routeOf('/p/hello-world/part/the-shape/', '/p/'), {
    name: 'part',
    slug: 'hello-world',
    anchor: 'the-shape',
  });

  assert.deepEqual(routeOf('/p/search/?q=sqlite', '/p/'), { name: 'search', query: 'sqlite' });
  assert.deepEqual(routeOf('/p/search/', '/p/'), { name: 'search', query: '' });

  // A deployment under a sub-path resolves identically.
  assert.deepEqual(routeOf('/sqlite-cms/docs/p/about/', '/sqlite-cms/docs/p/'), {
    name: 'document',
    slug: 'about',
  });
  assert.deepEqual(routeOf('/p/caf%C3%A9/', '/p/'), { name: 'document', slug: 'café' });
});

test('routeOf does not mistake a sibling path for the content base', () => {
  assert.deepEqual(routeOf('/painting/', '/p/'), { name: 'document', slug: 'painting' });
  assert.deepEqual(routeOf('/p?q=1', '/p/'), { name: 'index' });
});

// ────────────────────────────────── template engine ──────────────────────────────────

test('the template engine escapes, interpolates raw, iterates and branches', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');

  // {{x}} escapes; {{{x}}} does not. This distinction is what makes part payloads executable
  // while keeping titles safe.
  const evil = '<script>alert(1)</script>';
  assert.equal(renderTemplate('{{a}}', { a: evil }), escapeHtml(evil));
  assert.equal(renderTemplate('{{{a}}}', { a: evil }), evil);

  assert.equal(
    renderTemplate('{{#each xs}}[{{name}}]{{/each}}', { xs: [{ name: 'a' }, { name: 'b' }] }),
    '[a][b]',
  );
  assert.equal(renderTemplate('{{#each xs}}{{.}}{{sep}}{{/each}}', { xs: [1, 2], sep: '-' }), '1-2-');
  // Nested each over an array of arrays — the table widget depends on this.
  assert.equal(
    renderTemplate('{{#each rows}}<tr>{{#each .}}<td>{{.}}</td>{{/each}}</tr>{{/each}}', {
      rows: [
        ['a', 'b'],
        ['c', 'd'],
      ],
    }),
    '<tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr>',
  );

  assert.equal(renderTemplate('{{#if x}}yes{{else}}no{{/if}}', { x: true }), 'yes');
  assert.equal(renderTemplate('{{#if x}}yes{{else}}no{{/if}}', { x: false }), 'no');
  assert.equal(renderTemplate('{{#if xs}}some{{else}}none{{/if}}', { xs: [] }), 'none');
  assert.equal(renderTemplate('{{a.b.c}}', { a: { b: { c: 'deep' } } }), 'deep');

  // A typo in a template is content, not a crash.
  assert.equal(renderTemplate('[{{nope}}]', {}), '[]');
  assert.equal(renderTemplate('{{#each nope}}x{{/each}}', {}), '');
  assert.equal(renderTemplate('{{/each}}stray', {}), 'stray');
});

test('helpers: HTML flattens, text clips, dates humanise', () => {
  assert.equal(flattenHtml('<p>Hello <b>there</b></p><script>alert(1)</script>'), 'Hello there');
  assert.equal(flattenHtml('a &amp; b &lt;c&gt;&nbsp;d'), 'a & b <c> d');
  assert.match(clip('x'.repeat(400)), /…$/);
  assert.equal(formatDate('2026-07-26 14:03:11'), 'July 26, 2026');
  assert.equal(formatDate('not a date'), 'not a date');
});

// ─────────────────────────────────── documents & hierarchy ───────────────────────────────

test('slugs are derived, deduplicated, and stable across an update', async () => {
  const db = await site('t-slugs', { seed: false });
  assert.equal(slugify('Hello, World! — Part 2'), 'hello-world-part-2');
  assert.equal(slugify('Café Society'), 'cafe-society');
  assert.equal(slugify('   '), 'untitled');

  const a = await createDocument(db, { title: 'Duplicate Title' });
  const b = await createDocument(db, { title: 'Duplicate Title' });
  assert.equal((await getDocument(db, a)).slug, 'duplicate-title');
  assert.equal((await getDocument(db, b)).slug, 'duplicate-title-2');

  await updateDocument(db, a, { title: 'Renamed', slug: 'duplicate-title' });
  assert.equal((await getDocument(db, a)).slug, 'duplicate-title');

  const page = await createDocument(db, { type: 'page', title: 'Duplicate Title' });
  assert.equal((await getDocument(db, page)).slug, 'duplicate-title');
  await db.close();
});

test('documents nest: children, ancestors, subtree and ordering', async () => {
  const db = await site('t-tree', { seed: false });
  const book = await createDocument(db, { type: 'book', title: 'Book', status: 'published' });
  const one = await createDocument(db, {
    type: 'chapter', title: 'One', parentId: book, status: 'published',
  });
  const two = await createDocument(db, {
    type: 'chapter', title: 'Two', parentId: book, status: 'published',
  });
  const inner = await createDocument(db, {
    type: 'section', title: 'Inner', parentId: one, status: 'published',
  });

  assert.deepEqual((await childrenOf(db, book)).map((d) => d.title), ['One', 'Two']);
  assert.deepEqual((await ancestorsOf(db, inner)).map((d) => d.title), ['Book', 'One']);

  const tree = await subtree(db, 0);
  assert.equal(tree.length, 1, 'one root');
  assert.equal(tree[0].children.length, 2);
  assert.equal(tree[0].children[0].children[0].title, 'Inner');
  assert.equal(tree[0].children[0].children[0].depth, 2);

  // Reordering swaps siblings, and listOrdered reflects it.
  await reorder(db, two, -1);
  assert.deepEqual((await childrenOf(db, book)).map((d) => d.title), ['Two', 'One']);

  // A document cannot be moved inside its own subtree.
  await assert.rejects(() => updateDocument(db, book, { parentId: inner }), /own subtree/);

  // Deleting a node takes its subtree with it.
  await deleteDocument(db, one);
  assert.equal(await getDocument(db, inner), undefined, 'descendant should be gone');
  assert.deepEqual((await childrenOf(db, book)).map((d) => d.title), ['Two']);
  await db.close();
});

test('subtree terminates even if the rows describe a cycle', async () => {
  const db = await site('t-cycle', { seed: false });
  const a = await createDocument(db, { title: 'A', status: 'published' });
  const b = await createDocument(db, { title: 'B', parentId: a, status: 'published' });
  // Force a cycle behind the model's back, the way a bad merge could.
  await db.query(`UPDATE documents SET parent_id = ? WHERE id = ?`, [b, a]);
  const tree = await subtree(db, a); // must not hang
  assert.ok(Array.isArray(tree));
  await db.close();
});

test('collections group documents and count only published ones', async () => {
  const db = await site('t-collections', { seed: false });
  const blog = await ensureCollection(db, { title: 'Notes', slug: 'notes' });
  assert.equal(await ensureCollection(db, { title: 'Notes', slug: 'notes' }), blog, 'idempotent');

  await createDocument(db, { title: 'Live', collectionId: blog, status: 'published' });
  await createDocument(db, { title: 'Draft', collectionId: blog, status: 'draft' });

  const [row] = await listCollections(db);
  assert.equal(row.count, 1, 'drafts should not be counted');
  await db.close();
});

// ─────────────────────────────────────── parts ───────────────────────────────────────

test('parts carry typed payloads, derived text, and unique anchors', async () => {
  const db = await site('t-parts', { seed: false });
  const doc = await createDocument(db, { title: 'Host', status: 'published' });

  const id = await addPart(db, doc, {
    kind: 'callout',
    data: { title: 'Careful', html: '<p>Mind the <b>gap</b></p>', tone: 'warn' },
  });
  const part = await (await import(B + 'model/parts.js')).getPart(db, id);
  assert.equal(part.kind, 'callout');
  assert.deepEqual(partData(part).tone, 'warn');
  // Text is flattened from every string in the payload, so a new kind is searchable for free.
  assert.match(part.text, /Careful/);
  assert.match(part.text, /Mind the gap/);
  assert.doesNotMatch(part.text, /<b>/);

  // Anchors are unique within a document because they are URLs.
  const first = await addPart(db, doc, { kind: 'prose', anchor: 'x', data: { html: '<p>a</p>' } });
  const second = await addPart(db, doc, { kind: 'prose', anchor: 'x', data: { html: '<p>b</p>' } });
  const anchors = (await allParts(db, doc)).map((p) => p.anchor);
  assert.ok(anchors.includes('x') && anchors.includes('x-2'), `got ${anchors.join(',')}`);
  assert.ok(first !== second);

  // Keys naming assets are excluded from the searchable projection.
  assert.equal(deriveText({ src: 'clip.mp4', lang: 'ts', caption: 'A clip' }), 'A clip');

  // documentText concatenates for the similarity corpus.
  assert.match(await documentText(db, doc), /Mind the gap/);
  await db.close();
});

test('a sealed part never contributes text to the index', async () => {
  const db = await site('t-sealed', { seed: false });
  const doc = await createDocument(db, { title: 'Has a secret', status: 'published' });
  await addPart(db, doc, { kind: 'prose', data: { html: '<p>public preamble</p>' } });
  const secret = await addPart(db, doc, {
    kind: 'prose',
    data: { html: '<p>xylophone confidential</p>' },
  });

  assert.equal((await searchParts(db, 'xylophone')).length, 1, 'searchable while public');

  // Sealing it must remove it from the index, not merely hide it at render time.
  await updatePart(db, secret, { kind: 'sealed', data: { ciphertext: 'AAAA', hint: 'ask me' } });
  assert.equal((await searchParts(db, 'xylophone')).length, 0, 'sealed text must not be searchable');
  const reread = await (await import(B + 'model/parts.js')).getPart(db, secret);
  assert.equal(reread.text, '', 'sealed parts store no plaintext');

  // The public part around it is unaffected.
  assert.equal((await searchParts(db, 'preamble')).length, 1);
  await db.close();
});

test('search returns parts, ranked, with the document they belong to', async () => {
  const db = await site('t-partsearch');

  const hits = await searchParts(db, 'ordinal');
  assert.ok(hits.length > 0, 'expected passage hits');
  const first = hits[0];
  assert.ok(first.anchor, 'a hit is addressable');
  assert.ok(first.slug, 'a hit knows its document');
  assert.match(first.snippet, /«/, 'snippet delimiters present');
  assert.ok(first.rank <= 0, 'bm25 ranks are negative');

  // The same query as a rendered page links to the part, not just the document.
  const page = await html(db, '/p/search/?q=ordinal');
  assert.match(page.body, /\/part\//, 'results should deep-link to a part');
  assert.match(page.body, /<mark>/);

  assert.equal((await searchParts(db, '')).length, 0);
  assert.ok((await searchParts(db, 'ordina')).length > 0, 'bare words prefix-match');
  assert.ok((await searchParts(db, 'ordinal OR paging')).length > 0, 'operators pass through');

  // Title search is a separate index.
  assert.ok((await searchDocuments(db, 'handbook')).length > 0);
  await db.close();
});

// ─────────────────────────────────────── widgets ───────────────────────────────────────

test('widget renderers turn payloads into HTML and tolerate anything', async () => {
  const db = await site('t-widgets', { seed: false });
  const templates = await loadTemplates(db);
  const ctx = { site: {}, base: '/p/' };
  const doc = await createDocument(db, { title: 'W', status: 'published' });
  const { getPart } = await import(B + 'model/parts.js');

  const render = async (kind, data) => {
    const id = await addPart(db, doc, { kind, data });
    return renderPart(templates, await getPart(db, id), ctx);
  };

  assert.match(await render('prose', { html: '<p>hi</p>' }), /<p>hi<\/p>/);
  assert.match(await render('heading', { level: 2, text: 'Title' }), /<h2[^>]*>Title<\/h2>/);
  assert.match(await render('code', { lang: 'sql', code: 'SELECT 1' }), /SELECT 1/);
  assert.match(await render('figure', { src: 'x.png', alt: 'a' }), /src="\/p\/media\/x\.png"/);
  assert.match(await render('video', { src: 'v.webm', mime: 'video/webm' }), /<video/);
  assert.match(
    await render('table', { columns: ['A'], rows: [['1'], ['2']] }),
    /<th>A<\/th>[\s\S]*<td>1<\/td>[\s\S]*<td>2<\/td>/,
  );
  assert.match(await render('list', { items: ['one', 'two'] }), /<li>one<\/li>\s*<li>two<\/li>/);

  // A sealed part renders a placeholder and never emits its ciphertext.
  const sealed = await render('sealed', { ciphertext: 'SUPERSECRETBASE64', hint: 'ask me' });
  assert.match(sealed, /ask me/);
  assert.doesNotMatch(sealed, /SUPERSECRETBASE64/, 'ciphertext must not reach the page');

  // An unknown kind falls through to the html renderer rather than vanishing.
  assert.match(await render('no-such-widget', { html: '<p>fallback</p>' }), /fallback/);

  // Every built-in has a template.
  for (const name of Object.keys(DEFAULT_WIDGETS)) assert.ok(templates[name], `missing ${name}`);

  // renderParts concatenates in order.
  const parts = await listParts(db, doc);
  const all = renderParts(templates, parts, ctx);
  assert.ok(all.length > 0);
  await db.close();
});

// ────────────────────────────────── relations & similarity ──────────────────────────────

test('cosineNeighbours finds the near-duplicate and ignores the unrelated', () => {
  const corpus = new Map([
    [1, 'the pager reads and writes four kilobyte pages as queries touch them on demand'],
    [2, 'a pager reads four kilobyte pages on demand as the queries touch them, writing back'],
    [3, 'railway signal aspects govern the movement of trains through interlocking plants'],
    [4, 'signal aspects and interlocking plants govern railway train movements'],
  ]);
  const neighbours = cosineNeighbours(corpus, { minTokens: 3, minScore: 0.05, k: 3 });

  assert.equal(neighbours.get(1)[0].id, 2, 'the paraphrase should be the top neighbour');
  assert.equal(neighbours.get(3)[0].id, 4);
  // Cross-topic pairs should not appear at all at this threshold.
  assert.ok(!neighbours.get(1).some((n) => n.id === 3 || n.id === 4));
  assert.ok(neighbours.get(1)[0].score > 0.2, `weak score: ${neighbours.get(1)[0].score}`);

  // Stop words carry no signal.
  assert.deepEqual(tokenize('the and of a AN'), []);
  assert.deepEqual(tokenize('Pager reads Pages'), ['pager', 'reads', 'pages']);

  // Too small a corpus yields nothing rather than throwing.
  assert.equal(cosineNeighbours(new Map([[1, 'lonely document here']])).size, 0);
});

test('relations: manual links are reciprocal, typed, and survive a recompute', async () => {
  const db = await site('t-relations');
  const a = await createDocument(db, { title: 'Older', status: 'published' });
  const b = await createDocument(db, { title: 'Newer', status: 'published' });

  await link(db, b, a, { type: 'supersedes' });
  const fromB = await relatedDocuments(db, b);
  const fromA = await relatedDocuments(db, a);
  assert.equal(fromB[0].relation, 'supersedes');
  assert.equal(fromA[0].relation, 'superseded_by', 'the inverse edge should exist');

  // A self-link is silently refused.
  await link(db, a, a, { type: 'see_also' });
  assert.ok(!(await relatedDocuments(db, a)).some((r) => r.id === a));

  // Computed edges are added without disturbing authored ones…
  const report = await computeSimilar(db, { minScore: 0.02, minTokens: 3 });
  assert.ok(report.items > 0, 'corpus should not be empty');
  const counts = await countRelations(db);
  assert.ok(counts.computed > 0, 'expected tfidf edges');
  assert.equal(
    (await relatedDocuments(db, b)).filter((r) => r.relation === 'supersedes').length,
    1,
    'the authored link must survive',
  );

  // …and clearing the computed origin leaves the authored ones alone.
  await clearByOrigin(db, 'tfidf');
  assert.equal((await countRelations(db)).computed, 0);
  assert.equal((await relatedDocuments(db, b))[0].relation, 'supersedes');

  await unlink(db, b, a, 'supersedes');
  assert.equal((await relatedDocuments(db, b)).length, 0);
  assert.equal((await relatedDocuments(db, a)).length, 0, 'the inverse should go too');
  await db.close();
});

test('similarity relates the two seeded paging documents and renders them', async () => {
  const db = await site('t-similar');
  // Add a document that restates the paging one in different words.
  const echo = await createDocument(db, {
    title: 'Paging, restated',
    status: 'published',
    excerpt: 'again',
  });
  await setParts(db, echo, [
    {
      kind: 'prose',
      data: {
        html: `<p>The pager reads and writes four kilobyte pages as queries touch them, keeping a
        small cache in memory, so the database never has to fit in RAM and a write does not rewrite
        the whole file.</p>`,
      },
    },
  ]);

  const report = await computeSimilar(db, { minScore: 0.05, minTokens: 4 });
  assert.equal(report.scope, 'document');
  assert.ok(report.edges > 0, 'expected similar edges');

  const related = await relatedDocuments(db, echo);
  assert.ok(
    related.some((r) => r.slug === 'demand-paging'),
    `expected demand-paging among ${related.map((r) => r.slug).join(', ')}`,
  );
  assert.ok(related[0].confidence > 0);

  // The related block appears on the rendered page.
  const page = await html(db, '/p/paging-restated/');
  assert.match(page.body, /Related/);
  assert.match(page.body, /Demand paging/);

  // Part scope produces part-to-part edges.
  const partReport = await computeSimilar(db, { scope: 'part', minScore: 0.05, minTokens: 4 });
  assert.equal(partReport.scope, 'part');
  assert.ok(partReport.items > 0);
  await db.close();
});

// ────────────────────────────────────── rendering ──────────────────────────────────────

test('the seeded site renders a full document at every route', async () => {
  const db = await site('t-render');

  const index = await html(db, '/p/');
  assert.match(index.body, /^<!doctype html>/i);
  assert.match(index.body, /Hello from inside the database/);
  assert.match(index.body, /Demand paging, illustrated/);
  assert.equal(index.status, 200);
  assert.match(index.body, /href="\/p\/about\/"/);

  const single = await html(db, '/p/hello-world/');
  assert.match(single.body, /<h1 class="page-title">Hello from inside the database<\/h1>/);
  // Parts rendered through their widgets, in order.
  assert.match(single.body, /class="part prose"/);
  assert.match(single.body, /class="part callout/);
  // A part payload is interpolated raw, so its script survives into the served HTML.
  assert.match(single.body, /<script>[\s\S]*demo-btn[\s\S]*<\/script>/);
  assert.match(single.body, /<base href="\/p\/">/);

  const page = await html(db, '/p/about/');
  assert.match(page.body, /class="post page"/);
  assert.match(page.body, /<table>/, 'the about page uses a table part');

  // A book renders its children as a sub-table-of-contents, and breadcrumbs on the way down.
  const book = await html(db, '/p/handbook/');
  assert.match(book.body, /In this section/);
  assert.match(book.body, /On containers/);
  const nested = await html(db, '/p/ordinals-and-order/');
  assert.match(nested.body, /class="crumbs"/);
  assert.match(nested.body, /On containers/, 'breadcrumb to the parent chapter');

  const collection = await html(db, '/p/collection/handbook-collection/');
  assert.match(collection.body, /class="toc"/);
  assert.match(collection.body, /depth-1/, 'the TOC is indented by depth');
  assert.match(collection.body, /Ordinals and order/);

  const part = await html(db, '/p/hello-world/part/the-shape/');
  assert.match(part.body, /class="part callout/);
  assert.match(part.body, /Read the whole entry/);

  const archive = await html(db, '/p/category/notes/');
  assert.match(archive.body, /Hello from inside the database/);

  const missing = await html(db, '/p/no-such-thing/');
  assert.equal(missing.status, 404);
  assert.equal((await html(db, '/p/tag/nonexistent/')).status, 404);
  assert.equal((await html(db, '/p/collection/nope/')).status, 404);
  assert.equal((await html(db, '/p/hello-world/part/nope/')).status, 404);

  for (const body of [index.body, single.body, page.body, book.body, missing.body]) {
    assert.match(body, /cms:navigate/);
  }
  await db.close();
});

test('drafts are not served, but are previewable', async () => {
  const db = await site('t-drafts', { seed: false });
  const id = await createDocument(db, { title: 'Secret Draft', status: 'draft' });
  await setParts(db, id, [{ kind: 'prose', data: { html: '<p>unpublished</p>' } }]);

  assert.equal((await html(db, '/p/secret-draft/')).status, 404);
  const index = await html(db, '/p/');
  assert.doesNotMatch(index.body, /Secret Draft/);

  const preview = await renderPreview(db, await getDocument(db, id), OPTIONS);
  assert.match(preview, /Secret Draft/);
  assert.match(preview, /unpublished/);

  await updateDocument(db, id, { status: 'published' });
  assert.equal((await html(db, '/p/secret-draft/')).status, 200);
  await db.close();
});

test('the theme comes out of the database, widgets included', async () => {
  const db = await site('t-theme');

  assert.match(await getTemplate(db, 'single'), /page-title/);
  await setTemplate(db, 'single', '<article data-custom>{{post.title}}</article>');
  assert.match(
    (await html(db, '/p/hello-world/')).body,
    /<article data-custom>Hello from inside the database<\/article>/,
  );

  // Editing a *widget* changes every part of that kind.
  await setTemplate(db, 'widget:prose', '<div data-widget-edited>{{{html}}}</div>');
  await setTemplate(db, 'single', '{{{parts}}}');
  assert.match((await html(db, '/p/hello-world/')).body, /data-widget-edited/);

  await setSetting(db, 'site.title', 'Renamed Site');
  assert.match((await html(db, '/p/')).body, /Renamed Site/);

  // Deleting a template row must not brick the site; the built-in is the fallback.
  await db.exec(`DELETE FROM templates WHERE name = 'widget:prose'`);
  assert.match((await html(db, '/p/hello-world/')).body, /class="part prose"/);
  await db.close();
});

test('a deployment sub-path produces correct URLs throughout', async () => {
  const db = await site('t-base');
  const options = { base: '/sqlite-cms/docs/p/', transport: 'test' };
  const index = await html(db, '/sqlite-cms/docs/p/', options);
  assert.match(index.body, /<base href="\/sqlite-cms\/docs\/p\/">/);
  assert.match(index.body, /href="\/sqlite-cms\/docs\/p\/hello-world\/"/);
  assert.match(index.body, /href="\/sqlite-cms\/docs\/p\/category\/notes\/"/);
  await db.close();
});

// ─────────────────────────────── taxonomy, media, migration ───────────────────────────────

test('taxonomy: terms are created on demand and replaced per kind', async () => {
  const db = await site('t-terms', { seed: false });
  const id = await createDocument(db, { title: 'Tagged', status: 'published' });

  await setDocumentTerms(db, id, 'category', ['Notes', 'Notes', '  ']);
  await setDocumentTerms(db, id, 'tag', ['sqlite', 'wasm']);
  assert.deepEqual((await termsForDocument(db, id)).map((t) => `${t.kind}:${t.slug}`), [
    'category:notes',
    'tag:sqlite',
    'tag:wasm',
  ]);

  await setDocumentTerms(db, id, 'tag', ['sqlite']);
  assert.deepEqual((await termsForDocument(db, id)).map((t) => `${t.kind}:${t.slug}`), [
    'category:notes',
    'tag:sqlite',
  ]);

  const cats = await listTerms(db, 'category');
  assert.equal(cats.length, 1);
  assert.equal(cats[0].count, 1);
  await db.close();
});

test('media is served out of the database with its own MIME type', async () => {
  const db = await site('t-media');

  const served = await renderPath(db, '/p/media/paging.svg', OPTIONS);
  assert.equal(served.kind, 'asset');
  assert.equal(served.mime, 'image/svg+xml');
  assert.match(new TextDecoder().decode(served.body), /^<svg/);
  assert.equal((await renderPath(db, '/p/media/nope.png', OPTIONS)).status, 404);

  const bytes = new Uint8Array(256);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i;
  await addMedia(db, 'Some File.BIN', 'application/octet-stream', bytes);
  assert.deepEqual(new Uint8Array((await getMediaBySlug(db, 'some-file.bin')).bytes), bytes);

  await addMedia(db, 'Some File.BIN', 'application/octet-stream', bytes);
  assert.ok(await getMediaBySlug(db, 'some-file-2.bin'), 'names must not clobber');

  assert.equal((await countMedia(db)).items, 3);
  await db.close();
});

test('listing the media library does not read the image bytes', async () => {
  // BLOBs live in overflow pages, so a listing that never selects `bytes` stays cheap. If
  // listMedia ever grows a `SELECT bytes`, or `bytes` stops being the last column, this fails.
  const db = await site('t-media-paging', { seed: false });
  const big = new Uint8Array(600 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  await addMedia(db, 'big.bin', 'application/octet-stream', big);
  await addMedia(db, 'also-big.bin', 'application/octet-stream', big);

  const { pages, pageSize } = await pageStats(db);
  assert.equal(pageSize, 4096);
  assert.ok(pages > 250, `expected a large file, got ${pages} pages`);
  await db.close();

  const cold = await openDatabase({ idbName: 't-media-paging' });
  pageReads.reset();
  assert.equal((await listMedia(cold)).length, 2);
  const listReads = pageReads.count;

  pageReads.reset();
  await getMediaBySlug(cold, 'big.bin');
  const blobReads = pageReads.count;

  assert.ok(listReads > 0);
  assert.ok(listReads < pages / 4, `listing read ${listReads} of ${pages} pages`);
  assert.ok(blobReads > listReads * 4, `one BLOB: ${blobReads} vs listing ${listReads}`);
  console.log(
    `    ${pages} pages in file · listMedia faulted in ${listReads} · one 600 KB BLOB took ${blobReads}`,
  );
  await cold.close();
});

test('rendering one document does not read the whole database', async () => {
  const db = await site('t-render-paging');
  await db.exec('BEGIN');
  for (let i = 0; i < 300; i++) {
    const id = await createDocument(db, { title: `Filler ${i}`, status: 'published' });
    await addPart(db, id, {
      kind: 'prose',
      data: { html: `<p>${'lorem ipsum dolor sit amet '.repeat(40)}</p>` },
    });
  }
  await db.exec('COMMIT');
  const { pages } = await pageStats(db);
  assert.ok(pages > 200, `expected a multi-page database, got ${pages}`);
  await db.close();

  const cold = await openDatabase({ idbName: 't-render-paging' });
  pageReads.reset();
  const served = await renderPath(cold, '/p/hello-world/', OPTIONS);
  const reads = pageReads.count;
  assert.equal(served.status, 200);
  assert.ok(reads < pages / 2, `rendering one document read ${reads} of ${pages} pages`);
  console.log(`    ${pages} pages in file, one permalink render faulted in ${reads}`);
  await cold.close();
});

test('a v1 database migrates to v2 without losing content', async () => {
  // Build the v1 shape by hand, then let migrate() carry it forward. The risk being covered is
  // specific: every v2 table is IF NOT EXISTS, so without a migration a v1 database would gain
  // them and silently keep its content in a table nothing reads.
  const db = await openDatabase({ idbName: 't-migrate' });
  await db.exec(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY NOT NULL, type TEXT NOT NULL DEFAULT 'post',
      slug TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', created TEXT NOT NULL DEFAULT '',
      updated TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE terms (
      id INTEGER PRIMARY KEY NOT NULL, kind TEXT NOT NULL DEFAULT 'category',
      slug TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE post_terms (
      post_id INTEGER NOT NULL DEFAULT 0, term_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (post_id, term_id)
    );
  `);
  await db.query(
    `INSERT INTO posts (id, type, slug, title, body, excerpt, status, created, updated)
     VALUES (7, 'post', 'legacy', 'A v1 Entry', '<p>written under v1</p>', 'old', 'published',
             '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  );
  await db.query(`INSERT INTO terms (id, kind, slug, name) VALUES (3, 'tag', 'legacy', 'legacy')`);
  await db.query(`INSERT INTO post_terms (post_id, term_id) VALUES (7, 3)`);

  await migrate(db);
  await seedTheme(db);
  await seedSettings(db);

  const doc = await getDocument(db, 7);
  assert.ok(doc, 'the v1 post should now be a document');
  assert.equal(doc.title, 'A v1 Entry');
  assert.equal(doc.status, 'published');

  // Its body became one opaque html part, which renders verbatim.
  const parts = await listParts(db, 7);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'html');
  assert.match(partData(parts[0]).html, /written under v1/);
  assert.match(parts[0].text, /written under v1/, 'and is searchable');

  assert.deepEqual((await termsForDocument(db, 7)).map((t) => t.slug), ['legacy']);
  assert.match((await html(db, '/p/legacy/')).body, /written under v1/);

  // The v1 objects are gone, so a second migrate is a no-op rather than a re-import.
  assert.equal(
    Number(await db.scalar(`SELECT count(*) FROM sqlite_schema WHERE name = 'posts'`)),
    0,
  );
  await migrate(db);
  assert.equal((await listParts(db, 7)).length, 1, 'migrating twice must not duplicate');
  await db.close();
});

test('content survives close and reopen', async () => {
  const db = await site('t-persist', { seed: false });
  const id = await createDocument(db, { title: 'Written before the reopen', status: 'published' });
  await setParts(db, id, [
    { kind: 'prose', anchor: 'durable', data: { html: '<p>durable</p>' } },
  ]);
  await setDocumentTerms(db, id, 'tag', ['persistence']);
  await addMedia(db, 'blob.txt', 'text/plain', new TextEncoder().encode('still here'));
  await db.close();

  const reopened = await openDatabase({ idbName: 't-persist' });
  const docs = await listDocuments(reopened);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, 'Written before the reopen');
  assert.ok(await getPartByAnchor(reopened, id, 'durable'));
  assert.deepEqual((await termsForDocument(reopened, id)).map((t) => t.slug), ['persistence']);
  assert.equal(
    new TextDecoder().decode((await getMediaBySlug(reopened, 'blob.txt')).bytes),
    'still here',
  );
  assert.match((await html(reopened, '/p/written-before-the-reopen/')).body, /durable/);
  await reopened.close();
});
