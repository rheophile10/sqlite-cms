// Drives the built page in Chromium, twice: once from a real file:// URL and once from
// http://127.0.0.1. That pairing is the point of the project — the same database and the same
// renderer, reached through two different transports, with the environment choosing.
//
// The file:// half proves there is no server. The http half proves the URLs are real: it fetches
// a permalink with plain fetch() and checks the status line, the content type and the bytes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../serve.mjs';

const FILE_URL = `file://${fileURLToPath(new URL('../docs/index.html', import.meta.url))}`;
const READY = '#engine.on';

let browser;
let http;

test.before(async () => {
  // --disable-dev-shm-usage: containers often have a tiny /dev/shm, and this page carries a
  // 1.7 MB base64 wasm payload, which is enough to crash the tab without it.
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  http = await startServer({ port: 0 });
});

test.after(async () => {
  await browser?.close();
  http?.server.close();
});

/**
 * Wait for boot to finish. state:'attached' rather than the default 'visible' on purpose:
 * #engine lives inside .admin, which standalone-permalink mode hides at the end of boot, so a
 * visibility-based wait races that hide and can never succeed.
 */
async function waitReady(page) {
  await page.waitForSelector(READY, { state: 'attached', timeout: 90_000 });
}

/** Fresh context => empty IndexedDB and no registered worker, so each test starts from nothing. */
async function openShell(url) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(url);
  await waitReady(page);
  return { page, context, errors };
}

// Everything below reaches into the frame through Playwright's frame API rather than
// `iframe.contentDocument`. That is not a style preference: at file:// a blob: document has an
// opaque origin, so contentDocument is null from the shell's own JavaScript. The application
// never needs it — the bridge is postMessage, which crosses origins — but a test does, and
// Playwright can see in because it drives the browser rather than the page.

/** The live <iframe> as a Frame, once it has actually rendered something. */
async function siteFrame(page) {
  await page.frameLocator('#site').locator('.masthead').first().waitFor({ timeout: 30_000 });
  const handle = await page.waitForSelector('#site');
  const frame = await handle.contentFrame();
  assert.ok(frame, 'the site frame should be reachable');
  return frame;
}

/** Wait until the frame's <h1> matches, which is how a navigation is observed. */
async function waitForTitle(page, pattern) {
  await page
    .frameLocator('#site')
    .locator('h1.page-title')
    .filter({ hasText: pattern })
    .first()
    .waitFor({ timeout: 30_000 });
}

/** Wait for arbitrary text anywhere in the rendered page. */
async function waitForText(page, text) {
  await page.frameLocator('#site').getByText(text).first().waitFor({ timeout: 30_000 });
}

/**
 * Wait until the editor holds the document we asked for.
 *
 * Both opening and creating repopulate the fields asynchronously, so typing straight after the
 * click can be overwritten by the load that follows it. Every test that edits goes through here.
 */
async function editorReady(page, title) {
  await page.waitForFunction(
    (expected) => document.querySelector('#ed-title')?.value === expected,
    title,
    { timeout: 30_000 },
  );
  // The parts list is populated by a second async pass after the document fields. Without
  // waiting for it, `.part-edit` locators resolve against blocks that are about to be replaced.
  await page.waitForFunction(
    () => (document.querySelector('#parts-list')?.children.length ?? 0) > 0,
    undefined,
    { timeout: 30_000 },
  );
}

/** Click "New post"/"New page" and wait for its blank record to be loaded for editing. */
async function newDocument(page, selector, defaultTitle) {
  await page.click(selector);
  await editorReady(page, defaultTitle);
}

/** Open an existing document from the admin list and wait for it to load. */
async function openDocument(page, title) {
  await page.locator('#doc-list button.open', { hasText: title }).click();
  await editorReady(page, title);
}

/**
 * Overwrite the first part's payload. v2 documents have no body field — content is a list of
 * parts, each edited as its renderer's JSON — so "type a body" means writing that JSON.
 */
async function setBody(page, html) {
  const box = page.locator('#parts-list .part-edit').first();
  await box.locator('textarea.data').waitFor({ timeout: 30_000 });
  await box.locator('textarea.data').fill(JSON.stringify({ html }, null, 2));
}

/**
 * Save, and wait until the write has actually landed — observed via the admin list, which is
 * refreshed from the database at the end of the save. Clicking straight on to the next action
 * otherwise races the in-flight save, which then re-renders over whatever the next action did.
 */
async function saveDocument(page, title) {
  await page.click('#save');
  await page.locator('#doc-list button.open', { hasText: title }).first().waitFor({ timeout: 30_000 });
}

/** A loaded <img> inside the frame, as {src, width}. Fails if it never decoded. */
async function frameImage(page, selector = '.content img') {
  const frame = await siteFrame(page);
  await frame.waitForFunction(
    (sel) => {
      const img = document.querySelector(sel);
      return Boolean(img && img.complete && img.naturalWidth > 0);
    },
    selector,
    { timeout: 30_000 },
  );
  return frame.evaluate((sel) => {
    const img = document.querySelector(sel);
    return { src: img.getAttribute('src'), width: img.naturalWidth };
  }, selector);
}

// ══════════════════════════════════════ file:// ══════════════════════════════════════

test('file://: boots with no server and renders the site into a blob: document', async () => {
  const { page, context, errors } = await openShell(FILE_URL);

  assert.match(await page.textContent('#engine'), /cr-sqlite/);
  assert.match(await page.textContent('#transport'), /blob:/);
  assert.match(await page.textContent('#transport'), /file:\/\//);

  const frame = await siteFrame(page);
  assert.match(frame.url(), /^blob:/, 'the frame should be showing a blob: document');

  // The seeded index, composed from templates that are themselves rows in the database.
  const body = await frame.textContent('body');
  assert.match(body, /Hello from inside the database/);
  assert.match(body, /Demand paging, illustrated/);
  assert.match(body, /served via/);

  // Pages really are in IndexedDB, one record per SQLite page.
  const blocks = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('cms-site');
        req.onsuccess = () => {
          const store = req.result.transaction('blocks', 'readonly').objectStore('blocks');
          const count = store.count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(count.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  assert.ok(blocks > 1, `expected multiple page blocks in IndexedDB, got ${blocks}`);

  assert.deepEqual(errors, []);
  await context.close();
});

test('file://: links navigate, and a post ships its own working JavaScript', async () => {
  const { page, context, errors } = await openShell(FILE_URL);
  await siteFrame(page);

  // Click a link inside the rendered document; the bridge routes it back to the shell.
  await page.frameLocator('#site').getByRole('link', { name: 'Hello from inside the database' }).click();
  await waitForTitle(page, /Hello from inside the database/);

  const frame = await siteFrame(page);

  // The <script> stored in the post body runs: clicking increments a counter it installed.
  const button = page.frameLocator('#site').locator('#demo-btn');
  await button.click();
  await button.click();
  assert.equal(await page.frameLocator('#site').locator('#demo-out').textContent(), '2 clicks');

  // The script also reported its own context. In blob mode the rendered document's protocol is
  // blob: and its origin is opaque — which is precisely why the shell talks to it by postMessage
  // rather than reaching into contentDocument.
  const reported = await frame.textContent('#demo-ctx');
  assert.match(reported, /Running at blob:/);
  assert.match(reported, /origin: null/);

  assert.deepEqual(errors, []);
  await context.close();
});

test('file://: an image is served out of the media BLOB as a data: URI', async () => {
  const { page, context, errors } = await openShell(FILE_URL);
  await siteFrame(page);

  await page.frameLocator('#site').getByRole('link', { name: 'Demand paging, illustrated' }).click();
  await waitForTitle(page, /Demand paging/);

  // A blob document cannot fetch from "the site", so the <img> src is rewritten to carry the
  // bytes straight out of SQLite. It must be a data: URI, not a blob: one — an opaque-origin
  // document is not permitted to load blob:null/… subresources. Assert it actually decoded.
  const { src, width } = await frameImage(page);
  assert.match(src, /^data:image\/svg\+xml;base64,/, 'media should be inlined as a data: URI');
  assert.equal(width, 640, 'the SVG from the database should have decoded at its real size');

  assert.deepEqual(errors, []);
  await context.close();
});

test('file://: FTS5 search runs from inside the rendered page', async () => {
  const { page, context, errors } = await openShell(FILE_URL);
  await siteFrame(page);

  // 'pager' is in the prose of a part. 'paging' would only match a *title* — FTS5 tokenizes
  // "demand-paged" as demand+paged, so a prefix query for paging* misses the body entirely.
  await page.frameLocator('#site').locator('input[name=q]').fill('pager');
  await page.frameLocator('#site').locator('input[name=q]').press('Enter');
  await waitForTitle(page, /Search/);

  const frame = await siteFrame(page);
  const body = await frame.textContent('body');
  assert.match(body, /passage\(s\) for/);
  assert.doesNotMatch(body, /^0 passage/, 'expected at least one passage hit');
  assert.match(body, /Demand paging, illustrated/, 'the containing document should be named');
  // Snippets come back with the match wrapped in <mark>.
  assert.ok(await frame.$('mark'), 'expected a highlighted snippet');

  assert.deepEqual(errors, []);
  await context.close();
});

test('file://: an edit in the admin changes what the site serves, and survives a reload', async () => {
  const { page, context, errors } = await openShell(FILE_URL);
  await siteFrame(page);

  // Open the seeded post and retitle it.
  await openDocument(page, 'Hello from inside the database');
  await page.fill('#ed-title', 'Edited From The Admin');
  await page.click('#save');
  await waitForTitle(page, /Edited From The Admin/);

  // A new post, published, appears on the site index.
  await newDocument(page, '#new-post', 'New post');
  await page.fill('#ed-title', 'Second Post');
  await setBody(page, '<p>body of the second post</p>');
  await page.selectOption('#ed-status', 'published');
  await page.click('#save');
  await waitForTitle(page, /Second Post/);

  await page.click('#site-home');
  await waitForText(page, 'Second Post');

  // Reload: everything came out of IndexedDB, so it is all still there.
  await page.reload();
  await waitReady(page);
  await siteFrame(page);
  const body = await (await siteFrame(page)).textContent('body');
  assert.match(body, /Edited From The Admin/);
  assert.match(body, /Second Post/);

  assert.deepEqual(errors, []);
  await context.close();
});

test('file://: a draft is previewable but not reachable as a page', async () => {
  const { page, context, errors } = await openShell(FILE_URL);
  await siteFrame(page);

  await newDocument(page, '#new-post', 'New post');
  await page.fill('#ed-title', 'Unpublished Thing');
  await setBody(page, '<p>draft body here</p>');
  await saveDocument(page, 'Unpublished Thing'); // stays a draft

  // Preview renders it anyway.
  await page.click('#preview');
  await waitForText(page, 'draft body here');
  assert.match(await page.textContent('#site-url'), /draft preview/);

  // But visiting its URL does not.
  await page.click('#view');
  await waitForTitle(page, /Not found/);

  assert.deepEqual(errors, []);
  await context.close();
});

// ═════════════════════════════════════ http:// ═════════════════════════════════════

test('http: a Service Worker takes over and serves the site at real URLs', async () => {
  const { page, context, errors } = await openShell(`${http.origin}/`);

  await page.waitForFunction(() => /service worker/.test(document.querySelector('#transport')?.textContent ?? ''), undefined, { timeout: 60_000 });
  assert.match(await page.textContent('#transport'), /service worker/);

  const frame = await siteFrame(page);
  // Not a blob: this time — a genuine URL under the content prefix.
  assert.match(frame.url(), new RegExp(`^${http.origin}/p/`), `unexpected frame url: ${frame.url()}`);
  assert.match(await frame.textContent('body'), /Hello from inside the database/);
  assert.match(await frame.textContent('body'), /service worker/);

  // The shell offers a shareable link, which it cannot do at file://.
  assert.equal(await page.locator('#site-copy').isDisabled(), false);
  assert.match(await page.textContent('#site-url'), new RegExp(`^${http.origin}/p/`));

  assert.deepEqual(errors, []);
  await context.close();
});

test('http: fetching a permalink returns real text/html generated from SQLite', async () => {
  const { page, context, errors } = await openShell(`${http.origin}/`);
  await page.waitForFunction(() => /service worker/.test(document.querySelector('#transport')?.textContent ?? ''), undefined, { timeout: 60_000 });
  await siteFrame(page);

  // The strongest form of the claim: an ordinary fetch, answered by the worker out of the
  // database, with the status line and headers of a normal web server.
  const response = await page.evaluate(async () => {
    const res = await fetch('/p/hello-world/');
    return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
  });
  assert.equal(response.status, 200);
  assert.match(response.type, /text\/html/);
  assert.match(response.body, /^<!doctype html>/i);
  assert.match(response.body, /Hello from inside the database/);
  assert.match(response.body, /<script>/, 'the post body ships executable JavaScript');

  // A missing document is a real 404, not a soft one.
  const missing = await page.evaluate(async () => {
    const res = await fetch('/p/no-such-post/');
    return { status: res.status, body: await res.text() };
  });
  assert.equal(missing.status, 404);
  assert.match(missing.body, /Not found/);

  // Media comes back with its own content type, from the same mechanism.
  const media = await page.evaluate(async () => {
    const res = await fetch('/p/media/paging.svg');
    return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
  });
  assert.equal(media.status, 200);
  assert.equal(media.type, 'image/svg+xml');
  assert.match(media.text, /^<svg/);

  assert.deepEqual(errors, []);
  await context.close();
});

test('http: a permalink pasted into a tab with the admin already open renders directly', async () => {
  const context = await browser.newContext();
  const shell = await context.newPage();
  await shell.goto(`${http.origin}/`);
  await waitReady(shell);
  await shell.waitForFunction(() => /service worker/.test(document.querySelector('#transport')?.textContent ?? ''), undefined, { timeout: 60_000 });

  // A second tab on a permalink. A client exists, so the worker answers from the database and
  // the post arrives as the top-level document.
  const direct = await context.newPage();
  await direct.goto(`${http.origin}/p/demand-paging/`);
  await direct.waitForSelector('h1.page-title', { timeout: 60_000 });
  assert.match(await direct.textContent('h1.page-title'), /Demand paging/);

  // The image on that page is served from the BLOB by a real URL, not a blob: rewrite. It is
  // rendered output with no application JavaScript of its own, so the worker has to route this
  // subresource to the other tab's connection.
  await direct.waitForFunction(
    () => {
      const el = document.querySelector('.content img');
      return Boolean(el && el.complete && el.naturalWidth > 0);
    },
    undefined,
    { timeout: 30_000 },
  );
  const { src, width } = await direct.evaluate(() => {
    const el = document.querySelector('.content img');
    return { src: el.getAttribute('src'), width: el.naturalWidth };
  });
  assert.match(src, /media\/paging\.svg$/);
  assert.equal(width, 640);

  await context.close();
});

test('http: a permalink opened cold, with no page running, still renders', async () => {
  const context = await browser.newContext();

  // Install the worker, then close every page so there is no client left to ask.
  const installer = await context.newPage();
  await installer.goto(`${http.origin}/`);
  await waitReady(installer);
  await installer.waitForFunction(() => /service worker/.test(document.querySelector('#transport')?.textContent ?? ''), undefined, { timeout: 60_000 });
  await installer.close();

  // Cold: the worker has no client, so it serves the shell, which boots and renders the
  // permalink itself. The admin chrome is hidden — this is the site, not the editor.
  const cold = await context.newPage();
  const errors = [];
  cold.on('pageerror', (err) => errors.push(err.message));
  await cold.goto(`${http.origin}/p/hello-world/`);
  await waitReady(cold);

  await cold
    .frameLocator('#site')
    .getByText('Hello from inside the database')
    .first()
    .waitFor({ timeout: 60_000 });
  assert.equal(await cold.locator('.admin').isHidden(), true, 'admin chrome should be hidden');

  assert.deepEqual(errors, []);
  await context.close();
});

test('http: a shared permalink works on a first-ever visit, with no worker installed', async () => {
  // The static-host path: fresh context, so no Service Worker and no IndexedDB. Nothing exists on
  // disk at /p/hello-world/, so the host serves 404.html, which bounces to the shell with the
  // path in ?p=. The shell restores the address bar and renders it.
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(`${http.origin}/p/hello-world/`);
  await waitReady(page);

  await page
    .frameLocator('#site')
    .getByText('Hello from inside the database')
    .first()
    .waitFor({ timeout: 60_000 });

  // The bounce must not be visible in the final URL — a shared link has to survive being shared.
  assert.equal(new URL(page.url()).pathname, '/p/hello-world/');
  assert.equal(new URL(page.url()).search, '', 'the ?p= hand-off should not linger');
  assert.equal(await page.locator('.admin').isHidden(), true, 'admin chrome should be hidden');

  assert.deepEqual(errors, []);
  await context.close();
});

test('http: a genuine 404 is not bounced anywhere', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto(`${http.origin}/not-a-thing.txt`);
  assert.equal(response.status(), 404);
  assert.match(await page.textContent('body'), /404/);
  assert.equal(new URL(page.url()).pathname, '/not-a-thing.txt', 'should stay put');
  await context.close();
});

test('file://: a search result deep-links to the part it matched', async () => {
  const { page, context, errors } = await openShell(FILE_URL);
  await siteFrame(page);

  // "ordinal" appears in one passage of one section of the seeded handbook.
  await page.frameLocator('#site').locator('input[name=q]').fill('ordinal');
  await page.frameLocator('#site').locator('input[name=q]').press('Enter');
  await waitForTitle(page, /Search/);

  const frame = await siteFrame(page);
  assert.match(await frame.textContent('body'), /passage\(s\) for/);
  assert.ok(await frame.$('mark'), 'expected a highlighted snippet');

  // Following the hit lands on the part on its own, not the whole entry.
  await page.frameLocator('#site').locator('.postlist.passages .excerpt a').first().click();
  await page.frameLocator('#site').locator('.standalone-part').waitFor({ timeout: 30_000 });
  const part = await siteFrame(page);
  assert.match(await part.textContent('body'), /Read the whole entry/);

  assert.deepEqual(errors, []);
  await context.close();
});

test('file://: the hierarchy renders as a table of contents and breadcrumbs', async () => {
  const { page, context, errors } = await openShell(FILE_URL);
  await siteFrame(page);

  // The seeded book is in the nav as a collection.
  await page.frameLocator('#site').getByRole('link', { name: 'The Very Short Handbook' }).first().click();
  await page.frameLocator('#site').locator('.toc').waitFor({ timeout: 30_000 });

  const toc = await siteFrame(page);
  const body = await toc.textContent('body');
  assert.match(body, /On containers/);
  assert.match(body, /Ordinals and order/);
  // Depth is expressed as a class the stylesheet indents.
  assert.ok(await toc.$('.toc li.depth-1'), 'expected nested TOC entries');

  // Descending to a leaf shows the ancestor chain.
  await page.frameLocator('#site').getByRole('link', { name: 'Ordinals and order' }).click();
  await page.frameLocator('#site').locator('.crumbs').waitFor({ timeout: 30_000 });
  assert.match(await (await siteFrame(page)).textContent('.crumbs'), /On containers/);

  assert.deepEqual(errors, []);
  await context.close();
});

test('file://: TF-IDF similarity runs in the browser and writes related links', async () => {
  const { page, context, errors } = await openShell(FILE_URL);
  await siteFrame(page);

  const before = await page.textContent('#stat-rel');
  assert.match(before, /^0 links/, 'seeded content should start with no relations');

  await page.click('#tab-settings');
  await page.click('#sim-run');
  // The report names how many items were vectorized and how many edges resulted.
  await page.waitForFunction(
    () => /similar edge/.test(document.querySelector('#sim-report')?.textContent ?? ''),
    undefined,
    { timeout: 60_000 },
  );
  const report = await page.textContent('#sim-report');
  assert.match(report, /document\(s\) vectorized/);

  // Edges landed in the database, and the pill reflects it.
  await page.waitForFunction(
    () => !/^0 links/.test(document.querySelector('#stat-rel')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );

  // Part scope works too, over a different corpus.
  await page.selectOption('#sim-scope', 'part');
  await page.click('#sim-run');
  await page.waitForFunction(
    () => /part\(s\) vectorized/.test(document.querySelector('#sim-report')?.textContent ?? ''),
    undefined,
    { timeout: 60_000 },
  );

  assert.deepEqual(errors, []);
  await context.close();
});

test('file://: adding a typed part renders through its widget', async () => {
  const { page, context, errors } = await openShell(FILE_URL);
  await siteFrame(page);

  await openDocument(page, 'About');
  const partsBefore = await page.locator('#parts-list .part-edit').count();
  await page.selectOption('#part-add-kind', 'callout');
  await page.click('#part-add');
  await page.waitForFunction(
    (n) => document.querySelectorAll('#parts-list .part-edit').length === n + 1,
    partsBefore,
    { timeout: 30_000 },
  );

  // The new part is last; fill its payload and save.
  const box = page.locator('#parts-list .part-edit').last();
  await box.locator('textarea.data').fill(
    JSON.stringify({ title: 'Added live', tone: 'note', html: '<p>through the widget</p>' }),
  );
  await page.click('#save');

  await page.frameLocator('#site').locator('.part.callout').last().waitFor({ timeout: 30_000 });
  const frame = await siteFrame(page);
  const body = await frame.textContent('body');
  assert.match(body, /Added live/);
  assert.match(body, /through the widget/);

  assert.deepEqual(errors, []);
  await context.close();
});

test('file://: invalid part JSON is refused with a message, not silently dropped', async () => {
  const { page, context, errors } = await openShell(FILE_URL);
  await siteFrame(page);

  await openDocument(page, 'About');
  const box = page.locator('#parts-list .part-edit').first();
  await box.locator('textarea.data').fill('{ this is not json');
  await page.click('#save');

  await page.locator('#ed-err:not([hidden])').waitFor({ timeout: 30_000 });
  assert.match(await page.textContent('#ed-err'), /part 1/);

  // The stored content is untouched — a failed save must not half-apply.
  await page.click('#view');
  await waitForTitle(page, /About/);
  assert.match(await (await siteFrame(page)).textContent('body'), /demonstration of a CMS/);

  assert.deepEqual(errors, []);
  await context.close();
});
