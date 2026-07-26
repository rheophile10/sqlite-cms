// A narrated walkthrough of the built app, driven by Playwright.
//
// This is not a third test suite. `npm test` and `npm run test:e2e` are assertion-shaped and quiet
// — they answer "is anything broken". This answers a different question: *show me it working*. It
// drives the real built page through every capability in order, says what it is doing as it goes,
// leaves a screenshot per step in demo/screenshots/, and exits non-zero if any step fails.
//
// It covers both transports, because that is the claim the project rests on: the same database and
// the same renderer reached through a Service Worker when hosted and a blob: URL from a file.
//
//   node demo/walkthrough.mjs            headless
//   node demo/walkthrough.mjs --headed   watch it happen
//   npm run demo                         build first, then the above
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../serve.mjs';

const HEADED = process.argv.includes('--headed');
const SHOTS = fileURLToPath(new URL('./screenshots', import.meta.url));
const FILE_URL = `file://${fileURLToPath(new URL('../docs/index.html', import.meta.url))}`;
const READY = '#engine.on';

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

// ── narration ────────────────────────────────────────────────────────────────────────────────

const results = [];
let shotNumber = 0;

const GREY = '\x1b[90m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

function heading(text) {
  console.log(`\n${BOLD}${text}${OFF}`);
}

/** Run one named step, timing it, recording the outcome, and never throwing mid-run. */
async function step(name, body) {
  const started = Date.now();
  process.stdout.write(`  ${name} … `);
  try {
    const note = await body();
    const ms = Date.now() - started;
    console.log(`${GREEN}ok${OFF} ${GREY}${ms} ms${OFF}${note ? ` ${GREY}— ${note}${OFF}` : ''}`);
    results.push({ name, ok: true, note });
  } catch (err) {
    console.log(`${RED}FAILED${OFF}`);
    console.log(`${RED}      ${err instanceof Error ? err.message : String(err)}${OFF}`);
    results.push({ name, ok: false, error: err });
  }
}

async function shot(page, label) {
  shotNumber += 1;
  const file = `${String(shotNumber).padStart(2, '0')}-${label}.png`;
  await page.screenshot({ path: `${SHOTS}/${file}` });
  return file;
}

// ── helpers, matching the ones the e2e suite uses ─────────────────────────────────────────────

/** state:'attached' — #engine sits inside .admin, which standalone-permalink mode hides. */
const waitReady = (page) => page.waitForSelector(READY, { state: 'attached', timeout: 90_000 });

const frameHas = (page, text) =>
  page.frameLocator('#site').getByText(text).first().waitFor({ timeout: 30_000 });

async function siteFrame(page) {
  await page.frameLocator('#site').locator('.masthead').first().waitFor({ timeout: 30_000 });
  const handle = await page.waitForSelector('#site');
  const frame = await handle.contentFrame();
  assert.ok(frame, 'the site frame should be reachable');
  return frame;
}

const waitForTitle = (page, pattern) =>
  page
    .frameLocator('#site')
    .locator('h1.page-title')
    .filter({ hasText: pattern })
    .first()
    .waitFor({ timeout: 30_000 });

/** The editor populates its fields and then its parts list, in two async passes. */
async function editorReady(page, title) {
  await page.waitForFunction(
    (want) => document.querySelector('#ed-title')?.value === want,
    title,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => (document.querySelector('#parts-list')?.children.length ?? 0) > 0,
    undefined,
    { timeout: 30_000 },
  );
}

async function setFirstPart(page, data) {
  const box = page.locator('#parts-list .part-edit').first();
  await box.locator('textarea.data').waitFor({ timeout: 30_000 });
  await box.locator('textarea.data').fill(JSON.stringify(data, null, 2));
}

// ── the walkthrough ──────────────────────────────────────────────────────────────────────────

const browser = await chromium.launch({
  headless: !HEADED,
  slowMo: HEADED ? 220 : 0,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const http = await startServer({ port: 0 });
const pageErrors = [];

console.log(`${BOLD}SQLite CMS — walkthrough${OFF}`);
console.log(`${GREY}screenshots → demo/screenshots/${OFF}`);

// ── 1. file:// ───────────────────────────────────────────────────────────────────────────────

heading('1 · file:// — no server anywhere');

const fileCtx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
const page = await fileCtx.newPage();
page.on('pageerror', (err) => pageErrors.push(`file://: ${err.message}`));

await step('opens a double-clicked HTML file and boots SQLite', async () => {
  await page.goto(FILE_URL);
  await waitReady(page);
  await siteFrame(page);
  assert.match(await page.textContent('#engine'), /cr-sqlite/);
  return await page.textContent('#stat-pages');
});

await step('picks the blob: transport, because a file cannot host a worker', async () => {
  const transport = await page.textContent('#transport');
  assert.match(transport, /blob:/);
  const frame = await siteFrame(page);
  assert.match(frame.url(), /^blob:/);
  return transport.trim();
});

await step('renders the seeded index from templates that are database rows', async () => {
  const body = await (await siteFrame(page)).textContent('body');
  assert.match(body, /Hello from inside the database/);
  assert.match(body, /Demand paging, illustrated/);
  return await shot(page, 'file-admin-and-site');
});

await step('a part carries its own <script>, and it runs', async () => {
  await page.frameLocator('#site').getByRole('link', { name: 'Hello from inside the database' }).click();
  await waitForTitle(page, /Hello from inside the database/);
  const button = page.frameLocator('#site').locator('#demo-btn');
  await button.click();
  await button.click();
  const out = await page.frameLocator('#site').locator('#demo-out').textContent();
  assert.equal(out, '2 clicks');
  return `${await shot(page, 'live-widget')} — counter reads “${out}”`;
});

await step('an image comes out of a BLOB, inlined as a data: URI', async () => {
  await page.click('#site-home');
  await siteFrame(page);
  await page.frameLocator('#site').getByRole('link', { name: 'Demand paging, illustrated' }).click();
  await waitForTitle(page, /Demand paging/);
  const frame = await siteFrame(page);
  await frame.waitForFunction(
    () => {
      const img = document.querySelector('.content img');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    },
    undefined,
    { timeout: 30_000 },
  );
  const { src, width } = await frame.evaluate(() => {
    const img = document.querySelector('.content img');
    return { src: img.getAttribute('src').slice(0, 24), width: img.naturalWidth };
  });
  assert.match(src, /^data:image\//);
  return `${await shot(page, 'media-from-blob')} — decoded ${width}px from ${src}…`;
});

// ── 2. structure ─────────────────────────────────────────────────────────────────────────────

heading('2 · documents nest — a weblog and a book, one schema');

await step('a collection renders as a table of contents, indented by depth', async () => {
  await page.frameLocator('#site').getByRole('link', { name: 'The Very Short Handbook' }).first().click();
  await page.frameLocator('#site').locator('.toc').waitFor({ timeout: 30_000 });
  const frame = await siteFrame(page);
  assert.ok(await frame.$('.toc li.depth-1'), 'expected nested entries');
  const depth = await frame.evaluate(
    () => document.querySelectorAll('.toc li').length,
  );
  return `${await shot(page, 'collection-toc')} — ${depth} entries`;
});

await step('descending to a leaf shows the ancestor chain', async () => {
  await page.frameLocator('#site').getByRole('link', { name: 'Ordinals and order' }).click();
  await page.frameLocator('#site').locator('.crumbs').waitFor({ timeout: 30_000 });
  const crumbs = await (await siteFrame(page)).textContent('.crumbs');
  assert.match(crumbs, /On containers/);
  return `${await shot(page, 'breadcrumbs')} — ${crumbs.replace(/\s+/g, ' ').trim()}`;
});

// ── 3. part-level search ─────────────────────────────────────────────────────────────────────

heading('3 · search returns the passage, not the entry');

await step('FTS5 over parts, ranked by bm25, snippets marked', async () => {
  await page.frameLocator('#site').locator('input[name=q]').fill('ordinal');
  await page.frameLocator('#site').locator('input[name=q]').press('Enter');
  await waitForTitle(page, /Search/);
  const frame = await siteFrame(page);
  const count = await frame.evaluate(
    () => document.querySelectorAll('.postlist.passages li').length,
  );
  assert.ok(count > 0, 'expected passage hits');
  assert.ok(await frame.$('mark'), 'expected a highlighted snippet');
  return `${await shot(page, 'part-search')} — ${count} passages`;
});

await step('a hit deep-links to the part on its own URL', async () => {
  await page.frameLocator('#site').locator('.postlist.passages .excerpt a').first().click();
  await page.frameLocator('#site').locator('.standalone-part').waitFor({ timeout: 30_000 });
  await frameHas(page, 'Read the whole entry');
  const url = await page.textContent('#site-url');
  assert.match(url, /\/part\//);
  return `${await shot(page, 'standalone-part')} — ${url.split(' ')[0]}`;
});

// ── 4. authoring + relatedness ───────────────────────────────────────────────────────────────

heading('4 · authoring, then TF-IDF relatedness computed in the tab');

await step('a new post is written through the parts editor', async () => {
  await page.click('#new-post');
  await editorReady(page, 'New post');
  await page.fill('#ed-title', 'Paging, restated');
  await setFirstPart(page, {
    html:
      '<p>The pager reads and writes four kilobyte pages as queries touch them, keeping a small ' +
      'cache in memory, so the database never has to fit in RAM and a write does not rewrite the ' +
      'whole file.</p>',
  });
  await page.selectOption('#ed-status', 'published');
  await page.click('#save');
  await page.locator('#doc-list button.open', { hasText: 'Paging, restated' }).first().waitFor({
    timeout: 30_000,
  });
  await waitForTitle(page, /Paging, restated/);
  return await shot(page, 'authored-post');
});

await step('cosine similarity links it to the entry it paraphrases', async () => {
  await page.click('#tab-settings');
  await page.click('#sim-run');
  await page.waitForFunction(
    () => /similar edge/.test(document.querySelector('#sim-report')?.textContent ?? ''),
    undefined,
    { timeout: 60_000 },
  );
  const report = (await page.textContent('#sim-report')).trim();

  await page.click('#tab-content');
  await page.click('#view');
  await waitForTitle(page, /Paging, restated/);
  await page.frameLocator('#site').locator('.related').waitFor({ timeout: 30_000 });
  const related = await (await siteFrame(page)).textContent('.related');
  assert.match(related, /Demand paging/, `related block was: ${related}`);
  return `${await shot(page, 'related-entries')} — ${report}`;
});

await step('a typed part renders through its widget', async () => {
  const before = await page.locator('#parts-list .part-edit').count();
  await page.selectOption('#part-add-kind', 'callout');
  await page.click('#part-add');
  await page.waitForFunction(
    (n) => document.querySelectorAll('#parts-list .part-edit').length === n + 1,
    before,
    { timeout: 30_000 },
  );
  await page
    .locator('#parts-list .part-edit')
    .last()
    .locator('textarea.data')
    .fill(JSON.stringify({ title: 'Added by the walkthrough', tone: 'note', html: '<p>Rendered by widget:callout, which is a row in the templates table.</p>' }));
  await page.click('#save');
  await page.frameLocator('#site').locator('.part.callout').last().waitFor({ timeout: 30_000 });
  await frameHas(page, 'Added by the walkthrough');
  return await shot(page, 'typed-part');
});

await step('malformed part JSON is refused rather than silently dropped', async () => {
  await setFirstPart(page, {});
  await page.locator('#parts-list .part-edit').first().locator('textarea.data').fill('{ nope');
  await page.click('#save');
  await page.locator('#ed-err:not([hidden])').waitFor({ timeout: 30_000 });
  const message = (await page.textContent('#ed-err')).trim();
  assert.match(message, /part 1/);
  return message;
});

await step('everything persists across a reload — it was all in IndexedDB', async () => {
  await page.reload();
  await waitReady(page);
  await siteFrame(page);
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
  assert.ok(blocks > 1);
  await page.locator('#doc-list button.open', { hasText: 'Paging, restated' }).first().waitFor({
    timeout: 30_000,
  });
  return `${blocks} SQLite pages in IndexedDB`;
});

await fileCtx.close();

// ── 5. hosted ────────────────────────────────────────────────────────────────────────────────

heading('5 · hosted — the same renderer behind real URLs');

const httpCtx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
const hosted = await httpCtx.newPage();
hosted.on('pageerror', (err) => pageErrors.push(`http: ${err.message}`));

await step('a Service Worker takes over and serves the site', async () => {
  await hosted.goto(`${http.origin}/`);
  await waitReady(hosted);
  await hosted.waitForFunction(
    () => /service worker/.test(document.querySelector('#transport')?.textContent ?? ''),
    undefined,
    { timeout: 60_000 },
  );
  const frame = await siteFrame(hosted);
  assert.match(frame.url(), new RegExp(`^${http.origin}/p/`));
  return (await hosted.textContent('#transport')).trim();
});

await step('an ordinary fetch() of a permalink returns real text/html from SQLite', async () => {
  const res = await hosted.evaluate(async () => {
    const r = await fetch('/p/hello-world/');
    const body = await r.text();
    return { status: r.status, type: r.headers.get('content-type'), bytes: body.length, body };
  });
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/html/);
  assert.match(res.body, /^<!doctype html>/i);
  assert.match(res.body, /Hello from inside the database/);
  return `${res.status} ${res.type}, ${res.bytes} bytes`;
});

await step('media is served with its own content type by the same mechanism', async () => {
  const res = await hosted.evaluate(async () => {
    const r = await fetch('/p/media/paging.svg');
    return { status: r.status, type: r.headers.get('content-type') };
  });
  assert.equal(res.status, 200);
  assert.equal(res.type, 'image/svg+xml');
  return `${res.status} ${res.type}`;
});

await step('a missing document is a real 404, not a soft one', async () => {
  const res = await hosted.evaluate(async () => {
    const r = await fetch('/p/no-such-post/');
    return r.status;
  });
  assert.equal(res, 404);
  return '404';
});

await step('the permalink is shareable, and opens standalone in a fresh tab', async () => {
  assert.equal(await hosted.locator('#site-copy').isDisabled(), false);
  const shared = await httpCtx.newPage();
  await shared.goto(`${http.origin}/p/demand-paging/`);
  await shared.waitForSelector('h1.page-title', { timeout: 60_000 });
  assert.match(await shared.textContent('h1.page-title'), /Demand paging/);
  const file = await shot(shared, 'hosted-standalone-permalink');
  await shared.close();
  return `${file} — ${http.origin}/p/demand-paging/`;
});

await step('a first-ever visit with no worker installed still resolves', async () => {
  // Fresh context: no worker, no IndexedDB. 404.html hands the path to the shell, which restores
  // it — which is what makes a link someone else sent you work.
  const cold = await browser.newContext();
  const coldPage = await cold.newPage();
  await coldPage.goto(`${http.origin}/p/hello-world/`);
  await waitReady(coldPage);
  await coldPage
    .frameLocator('#site')
    .getByText('Hello from inside the database')
    .first()
    .waitFor({ timeout: 60_000 });
  assert.equal(new URL(coldPage.url()).pathname, '/p/hello-world/', 'the shared URL must survive');
  assert.equal(await coldPage.locator('.admin').isHidden(), true, 'admin chrome hidden');
  const file = await shot(coldPage, 'cold-shared-link');
  await cold.close();
  return file;
});

await httpCtx.close();

// ── summary ──────────────────────────────────────────────────────────────────────────────────

await browser.close();
http.server.close();

const failed = results.filter((r) => !r.ok);

console.log(`\n${BOLD}Summary${OFF}`);
console.log(`  ${results.length - failed.length}/${results.length} steps ok`);
console.log(`  screenshots: demo/screenshots/ (${shotNumber} files)`);

if (pageErrors.length) {
  console.log(`\n${RED}Uncaught page errors:${OFF}`);
  for (const message of pageErrors) console.log(`  ${message}`);
}

if (failed.length || pageErrors.length) {
  console.log(`\n${RED}${BOLD}WALKTHROUGH FAILED${OFF}`);
  for (const { name, error } of failed) {
    console.log(`  ${RED}✗${OFF} ${name}`);
    if (error?.stack) console.log(`${GREY}${error.stack.split('\n').slice(0, 3).join('\n')}${OFF}`);
  }
  process.exitCode = 1;
} else {
  console.log(`\n${GREEN}${BOLD}Everything works.${OFF}`);
}
