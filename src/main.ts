// UI wiring only — every SQLite concern lives in db/schema/content/taxonomy/media/theme, and
// every serving concern in render/transport.
import { openDatabase, type Db } from './db.js';
import { migrate, pageStats } from './schema.js';
import {
  countPosts,
  createPost,
  deletePost,
  getPost,
  listPosts,
  slugify,
  updatePost,
  type Post,
  type PostStatus,
  type PostType,
} from './content.js';
import {
  addMediaFile,
  countMedia,
  deleteMedia,
  formatBytes,
  listMedia,
  type MediaRow,
} from './media.js';
import { parseTermList, pruneOrphanTerms, setPostTerms, termsForPost } from './taxonomy.js';
import { getSetting, seedSettings, setSetting } from './settings.js';
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_ORDER,
  getTemplate,
  seedTheme,
  setTemplate,
  type TemplateName,
} from './theme.js';
import { renderPreview } from './render.js';
import { contentBase, createTransport, isSitePath, type Transport } from './transport.js';
import { seedContent } from './seed.js';

const IDB_NAME = 'cms-site';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const ui = {
  shell: el('shell'),
  engine: el('engine'),
  transport: el('transport'),
  statPages: el('stat-pages'),
  statMedia: el('stat-media'),

  tabs: {
    content: el<HTMLButtonElement>('tab-content'),
    media: el<HTMLButtonElement>('tab-media'),
    theme: el<HTMLButtonElement>('tab-theme'),
    settings: el<HTMLButtonElement>('tab-settings'),
  },
  panels: {
    content: el('panel-content'),
    media: el('panel-media'),
    theme: el('panel-theme'),
    settings: el('panel-settings'),
  },

  newPost: el<HTMLButtonElement>('new-post'),
  newPage: el<HTMLButtonElement>('new-page'),
  postList: el<HTMLUListElement>('post-list'),
  editor: el('editor'),
  edKind: el('ed-kind'),
  edTitle: el<HTMLInputElement>('ed-title'),
  edSlug: el<HTMLInputElement>('ed-slug'),
  edBody: el<HTMLTextAreaElement>('ed-body'),
  edExcerpt: el<HTMLTextAreaElement>('ed-excerpt'),
  edCats: el<HTMLInputElement>('ed-cats'),
  edTags: el<HTMLInputElement>('ed-tags'),
  edStatus: el<HTMLSelectElement>('ed-status'),
  save: el<HTMLButtonElement>('save'),
  preview: el<HTMLButtonElement>('preview'),
  view: el<HTMLButtonElement>('view'),
  del: el<HTMLButtonElement>('delete'),
  edErr: el('ed-err'),

  mediaFile: el<HTMLInputElement>('media-file'),
  mediaList: el<HTMLUListElement>('media-list'),
  mediaErr: el('media-err'),

  tplName: el<HTMLSelectElement>('tpl-name'),
  tplBody: el<HTMLTextAreaElement>('tpl-body'),
  tplSave: el<HTMLButtonElement>('tpl-save'),
  tplReset: el<HTMLButtonElement>('tpl-reset'),
  tplErr: el('tpl-err'),

  setTitle: el<HTMLInputElement>('set-title'),
  setTagline: el<HTMLInputElement>('set-tagline'),
  setSave: el<HTMLButtonElement>('set-save'),
  dbStats: el('db-stats'),
  dbReseed: el<HTMLButtonElement>('db-reseed'),
  dbWipe: el<HTMLButtonElement>('db-wipe'),

  siteHome: el<HTMLButtonElement>('site-home'),
  siteReload: el<HTMLButtonElement>('site-reload'),
  siteUrl: el('site-url'),
  siteCopy: el<HTMLButtonElement>('site-copy'),
  siteOpen: el<HTMLButtonElement>('site-open'),
  site: el<HTMLIFrameElement>('site'),
};

let db: Db;
let transport: Transport;
let editingId: number | undefined;
/** The site path currently in the frame, so a save can re-render exactly what is on screen. */
let shownPath = contentBase();

// ------------------------------------------------------------------------------------------- //
// site frame
// ------------------------------------------------------------------------------------------- //

/** Resolve an href from inside the frame. A dummy origin, because file:// has none. */
function resolveHref(href: string, base: string): string {
  const url = new URL(href, `https://cms.invalid${base}`);
  return url.pathname + url.search;
}

async function show(path: string, pushHistory = true): Promise<void> {
  shownPath = path;
  await transport.show(path);

  const link = transport.linkFor(path);
  ui.siteUrl.textContent = link ?? `${path}  (blob: — nothing to share from a file)`;
  ui.siteCopy.disabled = !link;
  ui.siteOpen.disabled = !link;

  // Only when a Service Worker is serving real URLs is there anything to put in the address
  // bar; pushState to a different path from a file:// document throws.
  if (pushHistory && transport.mode === 'sw' && location.pathname + location.search !== path) {
    history.pushState(null, '', path);
  }
}

function wireFrameBridge(): void {
  addEventListener('message', (event) => {
    const data = event.data as { type?: string; href?: string; q?: string } | null;
    if (!data) return;
    if (data.type === 'cms:navigate' && typeof data.href === 'string') {
      void show(resolveHref(data.href, transport.base));
    } else if (data.type === 'cms:search') {
      const q = encodeURIComponent(data.q ?? '');
      void show(`${transport.base}search/?q=${q}`);
    }
  });

  addEventListener('popstate', () => {
    if (transport.mode === 'sw' && isSitePath()) {
      void show(location.pathname + location.search, false);
    }
  });
}

// ------------------------------------------------------------------------------------------- //
// content
// ------------------------------------------------------------------------------------------- //

function postRow(post: Post): HTMLLIElement {
  const li = document.createElement('li');

  const open = document.createElement('button');
  open.className = 'open';
  open.textContent = post.title || '(untitled)';
  open.addEventListener('click', () => void edit(post.id));

  const kind = document.createElement('span');
  kind.className = 'tag';
  kind.textContent = post.type;

  const status = document.createElement('span');
  status.className = post.status === 'published' ? 'tag pub' : 'tag';
  status.textContent = post.status === 'published' ? 'live' : 'draft';

  const remove = document.createElement('button');
  remove.className = 'del';
  remove.textContent = '✕';
  remove.title = 'delete';
  remove.addEventListener('click', async () => {
    if (!confirm(`Delete “${post.title}”?`)) return;
    await deletePost(db, post.id);
    await pruneOrphanTerms(db);
    if (editingId === post.id) closeEditor();
    await refreshAll();
  });

  li.append(open, kind, status, remove);
  return li;
}

function closeEditor(): void {
  editingId = undefined;
  ui.editor.hidden = true;
}

async function refreshPostList(): Promise<void> {
  const posts = await listPosts(db);
  ui.postList.replaceChildren();
  if (!posts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'nothing here yet';
    ui.postList.append(li);
    return;
  }
  for (const post of posts) ui.postList.append(postRow(post));
}

async function edit(id: number): Promise<void> {
  const post = await getPost(db, id);
  if (!post) return;
  editingId = id;
  const terms = await termsForPost(db, id);

  ui.edKind.textContent = post.type;
  ui.edTitle.value = post.title;
  ui.edSlug.value = post.slug;
  ui.edBody.value = post.body;
  ui.edExcerpt.value = post.excerpt;
  ui.edCats.value = terms.filter((t) => t.kind === 'category').map((t) => t.name).join(', ');
  ui.edTags.value = terms.filter((t) => t.kind === 'tag').map((t) => t.name).join(', ');
  ui.edStatus.value = post.status;
  ui.edErr.hidden = true;
  ui.editor.hidden = false;
  ui.editor.scrollIntoView({ block: 'nearest' });
}

async function create(type: PostType): Promise<void> {
  const id = await createPost(db, {
    type,
    title: type === 'page' ? 'New page' : 'New post',
    body: '<p>Write something.</p>',
    status: 'draft',
  });
  await refreshAll();
  await edit(id);
}

async function saveEditor(): Promise<void> {
  if (editingId === undefined) return;
  ui.edErr.hidden = true;
  try {
    const title = ui.edTitle.value.trim() || 'Untitled';
    // An emptied slug field means "derive it from the title", as WordPress does.
    const slug = ui.edSlug.value.trim() || slugify(title);
    await updatePost(db, editingId, {
      title,
      slug,
      body: ui.edBody.value,
      excerpt: ui.edExcerpt.value.trim(),
      status: ui.edStatus.value as PostStatus,
    });
    await setPostTerms(db, editingId, 'category', parseTermList(ui.edCats.value));
    await setPostTerms(db, editingId, 'tag', parseTermList(ui.edTags.value));
    await pruneOrphanTerms(db);

    const saved = await getPost(db, editingId);
    if (saved) ui.edSlug.value = saved.slug; // may have been de-duplicated

    await refreshAll();
    // Show the result: the post itself if it is live, otherwise re-render what was on screen.
    if (saved && saved.status === 'published') {
      await show(`${transport.base}${encodeURIComponent(saved.slug)}/`);
    } else {
      await show(shownPath, false);
    }
  } catch (err) {
    ui.edErr.textContent = err instanceof Error ? err.message : String(err);
    ui.edErr.hidden = false;
  }
}

// ------------------------------------------------------------------------------------------- //
// media
// ------------------------------------------------------------------------------------------- //

function mediaRow(row: MediaRow): HTMLLIElement {
  const li = document.createElement('li');

  const open = document.createElement('button');
  open.className = 'open';
  open.textContent = row.slug;
  open.title = 'open in the frame';
  open.addEventListener('click', () => void show(`${transport.base}media/${row.slug}`));

  const size = document.createElement('span');
  size.className = 'tag';
  size.textContent = formatBytes(row.size);

  const remove = document.createElement('button');
  remove.className = 'del';
  remove.textContent = '✕';
  remove.title = 'delete';
  remove.addEventListener('click', async () => {
    if (!confirm(`Delete ${row.slug}?`)) return;
    await deleteMedia(db, row.id);
    await refreshAll();
  });

  li.append(open, size, remove);
  return li;
}

async function refreshMedia(): Promise<void> {
  const rows = await listMedia(db);
  ui.mediaList.replaceChildren();
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'no media yet';
    ui.mediaList.append(li);
    return;
  }
  for (const row of rows) ui.mediaList.append(mediaRow(row));
}

async function upload(files: FileList): Promise<void> {
  ui.mediaErr.hidden = true;
  try {
    // One at a time: each insert is a write through the single connection anyway.
    for (const file of Array.from(files)) await addMediaFile(db, file);
    await refreshAll();
  } catch (err) {
    ui.mediaErr.textContent = err instanceof Error ? err.message : String(err);
    ui.mediaErr.hidden = false;
  }
}

// ------------------------------------------------------------------------------------------- //
// theme + settings
// ------------------------------------------------------------------------------------------- //

const currentTemplate = (): TemplateName => ui.tplName.value as TemplateName;

async function loadTemplateIntoEditor(): Promise<void> {
  ui.tplBody.value = await getTemplate(db, currentTemplate());
  ui.tplErr.hidden = true;
}

async function refreshStats(): Promise<void> {
  const stats = await pageStats(db);
  const media = await countMedia(db);
  const posts = await countPosts(db);
  ui.statPages.textContent = `${stats.pages} pages`;
  ui.statMedia.textContent = `${media.items} media`;
  ui.dbStats.textContent =
    `${posts} documents · ${media.items} media (${formatBytes(media.bytes)}) · ` +
    `${stats.pages} × ${stats.pageSize} B pages = ` +
    `${formatBytes(stats.pages * stats.pageSize)} in IndexedDB`;
}

async function wipeEverything(): Promise<void> {
  // Order matters only for readability; there are no foreign keys declared.
  await db.exec(`DELETE FROM post_terms;
                 DELETE FROM terms;
                 DELETE FROM posts;
                 DELETE FROM media;
                 DELETE FROM settings;
                 DELETE FROM templates;`);
  await seedTheme(db);
  await seedSettings(db);
  closeEditor();
}

// ------------------------------------------------------------------------------------------- //
// boot
// ------------------------------------------------------------------------------------------- //

async function refreshAll(): Promise<void> {
  // Sequential on purpose. db.query() serializes anyway, but reading it as a sequence keeps the
  // single-connection constraint visible at the call site.
  await refreshPostList();
  await refreshMedia();
  await refreshStats();
}

function selectTab(which: keyof typeof ui.panels): void {
  for (const key of Object.keys(ui.panels) as (keyof typeof ui.panels)[]) {
    const active = key === which;
    ui.panels[key].hidden = !active;
    ui.tabs[key].setAttribute('aria-selected', String(active));
  }
}

function wire(): void {
  for (const key of Object.keys(ui.tabs) as (keyof typeof ui.tabs)[]) {
    ui.tabs[key].addEventListener('click', () => selectTab(key));
  }

  ui.newPost.addEventListener('click', () => void create('post'));
  ui.newPage.addEventListener('click', () => void create('page'));
  ui.save.addEventListener('click', () => void saveEditor());

  ui.preview.addEventListener('click', async () => {
    if (editingId === undefined) return;
    const post = await getPost(db, editingId);
    if (!post) return;
    // Preview renders the *saved* row, drafts included — the bypass renderPath will not do.
    const html = await renderPreview(db, post, {
      base: transport.base,
      transport: `${transport.label} · draft preview`,
    });
    await transport.showHtml(html);
    ui.siteUrl.textContent = `draft preview: ${post.slug}`;
    ui.siteCopy.disabled = true;
    ui.siteOpen.disabled = true;
  });

  ui.view.addEventListener('click', async () => {
    if (editingId === undefined) return;
    const post = await getPost(db, editingId);
    if (post) await show(`${transport.base}${encodeURIComponent(post.slug)}/`);
  });

  ui.del.addEventListener('click', async () => {
    if (editingId === undefined) return;
    const post = await getPost(db, editingId);
    if (!post || !confirm(`Delete “${post.title}”?`)) return;
    await deletePost(db, post.id);
    await pruneOrphanTerms(db);
    closeEditor();
    await refreshAll();
    await show(transport.base);
  });

  ui.mediaFile.addEventListener('change', () => {
    if (ui.mediaFile.files?.length) void upload(ui.mediaFile.files);
    ui.mediaFile.value = '';
  });

  ui.tplName.addEventListener('change', () => void loadTemplateIntoEditor());
  ui.tplSave.addEventListener('click', async () => {
    ui.tplErr.hidden = true;
    try {
      await setTemplate(db, currentTemplate(), ui.tplBody.value);
      await show(shownPath, false);
    } catch (err) {
      ui.tplErr.textContent = err instanceof Error ? err.message : String(err);
      ui.tplErr.hidden = false;
    }
  });
  ui.tplReset.addEventListener('click', async () => {
    ui.tplBody.value = DEFAULT_TEMPLATES[currentTemplate()];
    await setTemplate(db, currentTemplate(), ui.tplBody.value);
    await show(shownPath, false);
  });

  ui.setSave.addEventListener('click', async () => {
    await setSetting(db, 'site.title', ui.setTitle.value.trim());
    await setSetting(db, 'site.tagline', ui.setTagline.value.trim());
    await show(shownPath, false);
  });

  ui.dbReseed.addEventListener('click', async () => {
    if (!confirm('Restore the demo content? Existing documents are kept.')) return;
    await seedContent(db);
    await refreshAll();
    await show(transport.base);
  });

  ui.dbWipe.addEventListener('click', async () => {
    if (!confirm('Delete all content, media, theme edits and settings?')) return;
    await wipeEverything();
    await refreshAll();
    await loadTemplateIntoEditor();
    await show(transport.base);
  });

  ui.siteHome.addEventListener('click', () => void show(transport.base));
  ui.siteReload.addEventListener('click', () => void show(shownPath, false));
  ui.siteCopy.addEventListener('click', async () => {
    const link = transport.linkFor(shownPath);
    if (!link) return;
    await navigator.clipboard?.writeText(link);
    ui.siteCopy.textContent = 'Copied';
    setTimeout(() => (ui.siteCopy.textContent = 'Copy link'), 1200);
  });
  ui.siteOpen.addEventListener('click', () => {
    const link = transport.linkFor(shownPath);
    if (link) open(link, '_blank');
  });
}

async function boot(): Promise<void> {
  db = await openDatabase({ idbName: IDB_NAME });
  await migrate(db);
  await seedTheme(db);
  await seedSettings(db);
  await seedContent(db);

  transport = await createTransport(db, ui.site);

  ui.engine.textContent = 'cr-sqlite · IndexedDB VFS';
  ui.engine.classList.add('on');
  ui.transport.textContent = transport.label;
  ui.transport.classList.add(transport.mode === 'sw' ? 'on' : 'warn');

  for (const name of TEMPLATE_ORDER) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    ui.tplName.append(option);
  }
  await loadTemplateIntoEditor();

  ui.setTitle.value = await getSetting(db, 'site.title');
  ui.setTagline.value = await getSetting(db, 'site.tagline');

  await refreshAll();
  wireFrameBridge();
  wire();

  // Landed on a permalink rather than the admin: this document was served by the worker for a
  // shareable URL, so show that page and get the admin chrome out of the way.
  if (transport.mode === 'sw' && isSitePath()) {
    ui.shell.style.gridTemplateColumns = '1fr';
    const admin = document.querySelector('.admin');
    if (admin instanceof HTMLElement) admin.hidden = true;
    await show(location.pathname + location.search, false);
  } else {
    await show(transport.base, false);
  }
}

boot().catch((err: unknown) => {
  document.body.replaceChildren();
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = `Failed to start:\n${
    err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  }`;
  document.body.append(pre);
  console.error(err);
});
