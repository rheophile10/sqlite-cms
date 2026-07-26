// Exercises the claims this project makes, against the real modules in src/ — the router, the
// template engine, the content model, and demand paging over BLOB media.
//
// render.ts is deliberately DOM-free, so the entire serving path except the transport swap can
// be tested here. The two transports themselves need a browser and live in e2e.test.mjs.
import { pageReads } from './shim.mjs'; // must be first: installs IndexedDB + Web Locks
import assert from 'node:assert/strict';
import test from 'node:test';

const { openDatabase } = await import('../.build-test/db.js');
const { migrate, pageStats } = await import('../.build-test/schema.js');
const { createPost, getPost, listPosts, searchPosts, slugify, updatePost } = await import(
  '../.build-test/content.js'
);
const { addMedia, getMediaBySlug, listMedia, countMedia } = await import(
  '../.build-test/media.js'
);
const { setPostTerms, listTerms, termsForPost } = await import('../.build-test/taxonomy.js');
const { renderPath, renderPreview, routeOf, deriveExcerpt, formatDate } = await import(
  '../.build-test/render.js'
);
const { renderTemplate, escapeHtml } = await import('../.build-test/template.js');
const { seedTheme, getTemplate, setTemplate } = await import('../.build-test/theme.js');
const { seedSettings, setSetting } = await import('../.build-test/settings.js');
const { seedContent } = await import('../.build-test/seed.js');

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

  assert.deepEqual(routeOf('/p/search/?q=sqlite', '/p/'), { name: 'search', query: 'sqlite' });
  assert.deepEqual(routeOf('/p/search/', '/p/'), { name: 'search', query: '' });

  // A deployment under a sub-path resolves identically.
  assert.deepEqual(routeOf('/sqlite-cms/docs/p/about/', '/sqlite-cms/docs/p/'), {
    name: 'document',
    slug: 'about',
  });
  // Percent-encoding survives the round trip.
  assert.deepEqual(routeOf('/p/caf%C3%A9/', '/p/'), { name: 'document', slug: 'café' });
});

// ────────────────────────────────── template engine ──────────────────────────────────

test('the template engine escapes, interpolates raw, iterates and branches', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');

  // {{x}} escapes; {{{x}}} does not. This distinction is what makes post bodies executable
  // while keeping titles safe.
  const evil = '<script>alert(1)</script>';
  assert.equal(renderTemplate('{{a}}', { a: evil }), escapeHtml(evil));
  assert.equal(renderTemplate('{{{a}}}', { a: evil }), evil);

  assert.equal(
    renderTemplate('{{#each xs}}[{{name}}]{{/each}}', { xs: [{ name: 'a' }, { name: 'b' }] }),
    '[a][b]',
  );
  // `.` is the current item, and outer scope stays reachable from inside a section.
  assert.equal(renderTemplate('{{#each xs}}{{.}}{{sep}}{{/each}}', { xs: [1, 2], sep: '-' }), '1-2-');

  assert.equal(renderTemplate('{{#if x}}yes{{else}}no{{/if}}', { x: true }), 'yes');
  assert.equal(renderTemplate('{{#if x}}yes{{else}}no{{/if}}', { x: false }), 'no');
  assert.equal(renderTemplate('{{#if xs}}some{{else}}none{{/if}}', { xs: [] }), 'none');
  assert.equal(renderTemplate('{{a.b.c}}', { a: { b: { c: 'deep' } } }), 'deep');

  // A typo in a template is content, not a crash.
  assert.equal(renderTemplate('[{{nope}}]', {}), '[]');
  assert.equal(renderTemplate('{{#each nope}}x{{/each}}', {}), '');
  assert.equal(renderTemplate('{{/each}}stray', {}), 'stray');
});

test('helpers: excerpts strip markup and scripts, dates are humanised', () => {
  assert.equal(
    deriveExcerpt('<p>Hello <b>there</b></p><script>alert(1)</script>'),
    'Hello there',
  );
  assert.match(deriveExcerpt('x'.repeat(400)), /…$/);
  assert.equal(formatDate('2026-07-26 14:03:11'), 'July 26, 2026');
  assert.equal(formatDate('not a date'), 'not a date');
});

// ─────────────────────────────────── content model ───────────────────────────────────

test('slugs are derived, deduplicated, and stable across an update', async () => {
  const db = await site('t-slugs', { seed: false });
  assert.equal(slugify('Hello, World! — Part 2'), 'hello-world-part-2');
  assert.equal(slugify('Café Society'), 'cafe-society');
  assert.equal(slugify('   '), 'untitled');

  const a = await createPost(db, { title: 'Duplicate Title' });
  const b = await createPost(db, { title: 'Duplicate Title' });
  const c = await createPost(db, { title: 'Duplicate Title' });
  assert.equal((await getPost(db, a)).slug, 'duplicate-title');
  assert.equal((await getPost(db, b)).slug, 'duplicate-title-2');
  assert.equal((await getPost(db, c)).slug, 'duplicate-title-3');

  // A post keeps its own slug when updated — it must not collide with itself.
  await updatePost(db, a, { title: 'Renamed', slug: 'duplicate-title' });
  assert.equal((await getPost(db, a)).slug, 'duplicate-title');

  // A page may share a slug with a post; they are different types.
  const page = await createPost(db, { type: 'page', title: 'Duplicate Title' });
  assert.equal((await getPost(db, page)).slug, 'duplicate-title');
  await db.close();
});

test('taxonomy: terms are created on demand and replaced per kind', async () => {
  const db = await site('t-terms', { seed: false });
  const id = await createPost(db, { title: 'Tagged', status: 'published' });

  await setPostTerms(db, id, 'category', ['Notes', 'Notes', '  ']);
  await setPostTerms(db, id, 'tag', ['sqlite', 'wasm']);
  let terms = await termsForPost(db, id);
  assert.deepEqual(terms.map((t) => `${t.kind}:${t.slug}`), [
    'category:notes',
    'tag:sqlite',
    'tag:wasm',
  ]);

  // Replacing tags must leave the category alone.
  await setPostTerms(db, id, 'tag', ['sqlite']);
  terms = await termsForPost(db, id);
  assert.deepEqual(terms.map((t) => `${t.kind}:${t.slug}`), ['category:notes', 'tag:sqlite']);

  const cats = await listTerms(db, 'category');
  assert.equal(cats.length, 1);
  assert.equal(cats[0].count, 1);
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
  assert.equal(index.mime, 'text/html; charset=utf-8');
  // Pages are linked from the layout menu; posts are in the listing.
  assert.match(index.body, /href="\/p\/about\/"/);

  const single = await html(db, '/p/hello-world/');
  assert.match(single.body, /<h1 class="page-title">Hello from inside the database<\/h1>/);
  // The body is interpolated raw, so its script survives into the served HTML. This is the
  // "native javascript" claim, checked at the level render.ts is responsible for.
  assert.match(single.body, /<script>[\s\S]*demo-btn[\s\S]*<\/script>/);
  // Relative media URLs need a <base> or they would resolve under the permalink.
  assert.match(single.body, /<base href="\/p\/">/);

  const page = await html(db, '/p/about/');
  assert.match(page.body, /class="post page"/, 'a page should use the page template');

  const archive = await html(db, '/p/category/notes/');
  assert.match(archive.body, /Hello from inside the database/);
  assert.match(archive.body, /2 post\(s\)/);

  const missing = await html(db, '/p/no-such-thing/');
  assert.equal(missing.status, 404);
  assert.match(missing.body, /Not found/);

  const missingTerm = await html(db, '/p/tag/nonexistent/');
  assert.equal(missingTerm.status, 404);

  // Every rendered document carries the navigation bridge.
  for (const body of [index.body, single.body, page.body, archive.body, missing.body]) {
    assert.match(body, /cms:navigate/);
  }
  await db.close();
});

test('search renders bm25-ranked results with marked snippets', async () => {
  const db = await site('t-search');

  const results = await html(db, '/p/search/?q=paging');
  assert.match(results.body, /result\(s\) for/);
  assert.match(results.body, /Demand paging, illustrated/);
  assert.match(results.body, /<mark>/, 'snippet delimiters should become <mark>');

  // Snippet text is escaped before « » are promoted, so author markup cannot leak through.
  const hits = await searchPosts(db, 'paging');
  assert.ok(hits.length > 0);
  assert.ok(hits[0].rank <= 0, 'bm25 ranks are negative');

  assert.equal((await searchPosts(db, '')).length, 0);
  assert.ok((await searchPosts(db, 'pagin')).length > 0, 'bare words prefix-match');
  assert.ok((await searchPosts(db, 'paging OR javascript')).length > 0, 'operators pass through');

  const blank = await html(db, '/p/search/');
  assert.match(blank.body, /Type a query above/);
  await db.close();
});

test('drafts are not served, but are previewable', async () => {
  const db = await site('t-drafts', { seed: false });
  const id = await createPost(db, {
    title: 'Secret Draft',
    body: '<p>unpublished</p>',
    status: 'draft',
  });

  const served = await html(db, '/p/secret-draft/');
  assert.equal(served.status, 404, 'a draft must not be reachable by URL');

  const index = await html(db, '/p/');
  assert.doesNotMatch(index.body, /Secret Draft/);
  assert.match(index.body, /Nothing published yet/);

  // The admin preview bypasses the status filter deliberately.
  const preview = await renderPreview(db, await getPost(db, id), OPTIONS);
  assert.match(preview, /Secret Draft/);
  assert.match(preview, /unpublished/);

  await updatePost(db, id, { status: 'published' });
  assert.equal((await html(db, '/p/secret-draft/')).status, 200);
  await db.close();
});

test('the theme comes out of the database and edits take effect', async () => {
  const db = await site('t-theme');

  assert.match(await getTemplate(db, 'single'), /page-title/);
  await setTemplate(db, 'single', '<article data-custom>{{post.title}}</article>');
  const rendered = await html(db, '/p/hello-world/');
  assert.match(rendered.body, /<article data-custom>Hello from inside the database<\/article>/);
  // The layout still wraps it — only the inner template changed.
  assert.match(rendered.body, /<\/html>/);

  // Site settings reach the layout.
  await setSetting(db, 'site.title', 'Renamed Site');
  assert.match((await html(db, '/p/')).body, /Renamed Site/);

  // Deleting a template row must not brick the site; the built-in is the fallback.
  await db.exec(`DELETE FROM templates WHERE name = 'single'`);
  assert.match((await html(db, '/p/hello-world/')).body, /page-title/);
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

// ──────────────────────────────── media, served from BLOBs ────────────────────────────────

test('media is served out of the database with its own MIME type', async () => {
  const db = await site('t-media');

  const served = await renderPath(db, '/p/media/paging.svg', OPTIONS);
  assert.equal(served.kind, 'asset');
  assert.equal(served.status, 200);
  assert.equal(served.mime, 'image/svg+xml');
  assert.match(new TextDecoder().decode(served.body), /^<svg/);

  const missing = await renderPath(db, '/p/media/nope.png', OPTIONS);
  assert.equal(missing.kind, 'asset');
  assert.equal(missing.status, 404);

  // Round-trip arbitrary bytes, not just text.
  const bytes = new Uint8Array(256);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i;
  await addMedia(db, 'Some File.BIN', 'application/octet-stream', bytes);
  const back = await getMediaBySlug(db, 'some-file.bin');
  assert.deepEqual(new Uint8Array(back.bytes), bytes, 'BLOB bytes must survive exactly');

  // Uploading the same name twice does not clobber.
  await addMedia(db, 'Some File.BIN', 'application/octet-stream', bytes);
  assert.ok(await getMediaBySlug(db, 'some-file-2.bin'));

  const counts = await countMedia(db);
  assert.equal(counts.items, 3);
  assert.ok(counts.bytes > 512);
  await db.close();
});

test('listing the media library does not read the image bytes', async () => {
  // The on-thesis claim for media: BLOBs live in overflow pages, so a listing that never selects
  // `bytes` stays cheap no matter how large the library is. If listMedia ever grows a
  // `SELECT bytes`, this test fails loudly.
  const db = await site('t-media-paging', { seed: false });

  const big = new Uint8Array(600 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  await addMedia(db, 'big.bin', 'application/octet-stream', big);
  await addMedia(db, 'also-big.bin', 'application/octet-stream', big);

  const { pages, pageSize } = await pageStats(db);
  assert.equal(pageSize, 4096);
  assert.ok(pages > 250, `expected a large file, got ${pages} pages`);
  await db.close();

  // Reopen for a cold page cache, so reads must come from IndexedDB.
  const cold = await openDatabase({ idbName: 't-media-paging' });
  pageReads.reset();
  const rows = await listMedia(cold);
  const listReads = pageReads.count;
  assert.equal(rows.length, 2);

  pageReads.reset();
  await getMediaBySlug(cold, 'big.bin');
  const blobReads = pageReads.count;

  assert.ok(listReads > 0, 'the listing should still fault in the pages it needs');
  assert.ok(
    listReads < pages / 4,
    `listing should not read the whole file: ${listReads} of ${pages} pages`,
  );
  assert.ok(
    blobReads > listReads * 4,
    `fetching one BLOB should cost far more than listing all of them: ${blobReads} vs ${listReads}`,
  );
  console.log(
    `    ${pages} pages in file · listMedia faulted in ${listReads} · one 600 KB BLOB took ${blobReads}`,
  );
  await cold.close();
});

test('rendering one post does not read the whole database', async () => {
  const db = await site('t-render-paging');
  // Bulk up the database so "only the pages it needs" is a meaningful claim.
  await db.exec('BEGIN');
  for (let i = 0; i < 400; i++) {
    await createPost(db, {
      title: `Filler ${i}`,
      body: `<p>${'lorem ipsum dolor sit amet '.repeat(40)}</p>`,
      status: 'published',
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
  assert.ok(
    reads < pages / 2,
    `rendering one post should not read ${pages} pages; it read ${reads}`,
  );
  console.log(`    ${pages} pages in file, one permalink render faulted in ${reads}`);
  await cold.close();
});

test('content survives close and reopen', async () => {
  const db = await site('t-persist', { seed: false });
  const id = await createPost(db, {
    title: 'Written before the reopen',
    body: '<p>durable</p>',
    status: 'published',
  });
  await setPostTerms(db, id, 'tag', ['persistence']);
  await addMedia(db, 'blob.txt', 'text/plain', new TextEncoder().encode('still here'));
  await db.close();

  const reopened = await openDatabase({ idbName: 't-persist' });
  const posts = await listPosts(reopened);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, 'Written before the reopen');
  assert.deepEqual((await termsForPost(reopened, id)).map((t) => t.slug), ['persistence']);
  assert.equal(
    new TextDecoder().decode((await getMediaBySlug(reopened, 'blob.txt')).bytes),
    'still here',
  );
  // Seeded templates persisted too, so the site still renders after a restart.
  assert.match((await html(reopened, '/p/written-before-the-reopen/')).body, /durable/);
  await reopened.close();
});

test('routeOf does not mistake a sibling path for the content base', () => {
  // '/painting/' shares a prefix with the base '/p/' but is not inside it.
  assert.deepEqual(routeOf('/painting/', '/p/'), { name: 'document', slug: 'painting' });
  assert.deepEqual(routeOf('/p?q=1', '/p/'), { name: 'index' });
});
