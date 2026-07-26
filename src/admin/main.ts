// UI wiring only — every SQLite concern lives in db/schema/documents/parts/relations/…, and every
// serving concern in render/transport.
import { openDatabase, type Db } from '../engine/db.js';
import { migrate, pageStats } from '../model/schema.js';
import {
  childrenOf,
  createDocument,
  deleteDocument,
  getDocument,
  getPublishedBySlug,
  listOrdered,
  reorder,
  slugify,
  subtree,
  updateDocument,
  type Doc,
  type DocumentStatus,
  type DocumentType,
  type Visibility,
} from '../model/documents.js';
import { listCollections } from '../model/collections.js';
import {
  addPart,
  countParts,
  deletePart,
  listParts,
  partData,
  reorderPart,
  updatePart,
  type Part,
} from '../model/parts.js';
import { BUILTIN_WIDGETS } from '../view/widgets.js';
import {
  countRelations,
  link,
  relatedDocuments,
  unlink,
  type RelationType,
} from '../model/relations.js';
import { computeSimilar } from '../model/similarity.js';
import {
  addMediaFile,
  countMedia,
  deleteMedia,
  formatBytes,
  listMedia,
  type MediaRow,
} from '../model/media.js';
import { parseTermList, pruneOrphanTerms, setDocumentTerms, termsForDocument } from '../model/taxonomy.js';
import { getSetting, seedSettings, setSetting } from '../model/settings.js';
import { DEFAULT_TEMPLATES, TEMPLATE_ORDER, getTemplate, seedTheme, setTemplate } from '../view/theme.js';
import { renderPreview } from '../view/render.js';
import { contentBase, createTransport, isSitePath, type Transport } from '../serve/transport.js';
import { seedContent } from '../model/seed.js';

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
  statParts: el('stat-parts'),
  statRel: el('stat-rel'),

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
  newChild: el<HTMLButtonElement>('new-child'),
  docList: el<HTMLUListElement>('doc-list'),

  editor: el('editor'),
  edKind: el('ed-kind'),
  edTitle: el<HTMLInputElement>('ed-title'),
  edSlug: el<HTMLInputElement>('ed-slug'),
  edNumber: el<HTMLInputElement>('ed-number'),
  edSubtitle: el<HTMLInputElement>('ed-subtitle'),
  edExcerpt: el<HTMLTextAreaElement>('ed-excerpt'),
  edCats: el<HTMLInputElement>('ed-cats'),
  edTags: el<HTMLInputElement>('ed-tags'),
  edStatus: el<HTMLSelectElement>('ed-status'),
  edVisibility: el<HTMLSelectElement>('ed-visibility'),
  edCollection: el<HTMLSelectElement>('ed-collection'),
  edParent: el<HTMLSelectElement>('ed-parent'),
  up: el<HTMLButtonElement>('up'),
  down: el<HTMLButtonElement>('down'),

  partsList: el('parts-list'),
  partsCount: el('parts-count'),
  partAddKind: el<HTMLSelectElement>('part-add-kind'),
  partAdd: el<HTMLButtonElement>('part-add'),

  relList: el<HTMLUListElement>('rel-list'),
  relSlug: el<HTMLInputElement>('rel-slug'),
  relType: el<HTMLSelectElement>('rel-type'),
  relAdd: el<HTMLButtonElement>('rel-add'),

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
  simScope: el<HTMLSelectElement>('sim-scope'),
  simRun: el<HTMLButtonElement>('sim-run'),
  simReport: el('sim-report'),
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

  const shareable = transport.linkFor(path);
  ui.siteUrl.textContent = shareable ?? `${path}  (blob: — nothing to share from a file)`;
  ui.siteCopy.disabled = !shareable;
  ui.siteOpen.disabled = !shareable;

  // Only when a Service Worker is serving real URLs is there anything to put in the address bar;
  // pushState to a different path from a file:// document throws.
  if (pushHistory && transport.mode === 'sw' && location.pathname + location.search !== path) {
    history.pushState(null, '', path);
  }
}

function wireFrameBridge(): void {
  addEventListener('message', (event) => {
    const data = event.data as { type?: string; href?: string; q?: string; search?: string } | null;
    if (!data) return;
    if (data.type === 'cms:navigate' && typeof data.href === 'string') {
      void show(resolveHref(data.href, transport.base));
    } else if (data.type === 'cms:query' && typeof data.search === 'string') {
      // The form already serialized itself, so the URL is the query verbatim.
      void show(`${transport.base}query/${data.search ? `?${data.search}` : ''}`);
    } else if (data.type === 'cms:search') {
      // An older theme that only knows about `q`.
      void show(`${transport.base}query/?q=${encodeURIComponent(data.q ?? '')}`);
    }
  });

  addEventListener('popstate', () => {
    if (transport.mode === 'sw' && isSitePath()) {
      void show(location.pathname + location.search, false);
    }
  });
}

// ------------------------------------------------------------------------------------------- //
// document list (the hierarchy)
// ------------------------------------------------------------------------------------------- //

function docRow(doc: Doc, depth: number): HTMLLIElement {
  const li = document.createElement('li');
  if (depth > 0) li.className = `d${Math.min(depth, 4)}`;

  const open = document.createElement('button');
  open.className = 'open';
  open.textContent = doc.number ? `${doc.number} · ${doc.title || '(untitled)'}` : doc.title || '(untitled)';
  open.addEventListener('click', () => void edit(doc.id));

  const kind = document.createElement('span');
  kind.className = 'tag';
  kind.textContent = doc.type;

  const status = document.createElement('span');
  status.className = doc.status === 'published' ? 'tag pub' : 'tag';
  status.textContent = doc.status === 'published' ? 'live' : 'draft';

  const remove = document.createElement('button');
  remove.className = 'del';
  remove.textContent = '✕';
  remove.title = 'delete (with its subtree)';
  remove.addEventListener('click', async () => {
    const kids = await childrenOf(db, doc.id);
    const warning = kids.length
      ? `Delete “${doc.title}” and its ${kids.length} child document(s)?`
      : `Delete “${doc.title}”?`;
    if (!confirm(warning)) return;
    await deleteDocument(db, doc.id);
    await pruneOrphanTerms(db);
    if (editingId === doc.id) closeEditor();
    await refreshAll();
    await show(shownPath, false);
  });

  li.append(open, kind, status);
  if (doc.visibility === 'protected') {
    const lock = document.createElement('span');
    lock.className = 'tag lock';
    lock.textContent = 'sealed';
    li.append(lock);
  }
  li.append(remove);
  return li;
}

async function refreshDocList(): Promise<void> {
  // The whole tree in one pass, then flattened for display — one query, not one per node.
  const roots = await subtree(db, 0);
  ui.docList.replaceChildren();
  if (!roots.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'nothing here yet';
    ui.docList.append(li);
    return;
  }
  const walk = (nodes: typeof roots): void => {
    for (const node of nodes) {
      ui.docList.append(docRow(node, node.depth));
      walk(node.children);
    }
  };
  walk(roots);
}

// ------------------------------------------------------------------------------------------- //
// parts editor
// ------------------------------------------------------------------------------------------- //

/**
 * One editable block per part: kind, anchor, and the payload as JSON.
 *
 * The payload is edited as raw JSON on purpose. A bespoke form per widget kind would have to be
 * written again for every kind anybody adds, and kinds are meant to be cheap — a template row and
 * nothing else. Invalid JSON is reported inline and refuses to save rather than being coerced.
 */
function partBlock(part: Part): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'part-edit';
  box.dataset.partId = String(part.id);

  const bar = document.createElement('div');
  bar.className = 'bar';

  const kind = document.createElement('select');
  kind.className = 'kind';
  const kinds = [...new Set([...BUILTIN_WIDGETS, part.kind])];
  for (const name of kinds) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    kind.append(option);
  }
  kind.value = part.kind;

  const anchor = document.createElement('input');
  anchor.className = 'anchor';
  anchor.value = part.anchor;
  anchor.title = 'fragment id — this part’s own URL';

  const up = document.createElement('button');
  up.className = 'ghost mini';
  up.textContent = '↑';
  up.addEventListener('click', async () => {
    await reorderPart(db, part.id, -1);
    await refreshParts();
  });

  const down = document.createElement('button');
  down.className = 'ghost mini';
  down.textContent = '↓';
  down.addEventListener('click', async () => {
    await reorderPart(db, part.id, 1);
    await refreshParts();
  });

  const remove = document.createElement('button');
  remove.className = 'danger mini';
  remove.textContent = '✕';
  remove.addEventListener('click', async () => {
    if (!confirm('Delete this part?')) return;
    await deletePart(db, part.id);
    await refreshParts();
    await refreshStats();
    await show(shownPath, false);
  });

  bar.append(kind, anchor, up, down, remove);

  const data = document.createElement('textarea');
  data.className = 'data';
  data.spellcheck = false;
  data.value = JSON.stringify(partData(part), null, 2);

  const bad = document.createElement('div');
  bad.className = 'badinfo';
  bad.hidden = true;

  // Validate as you type so a JSON typo is visible before Save is pressed.
  data.addEventListener('input', () => {
    try {
      JSON.parse(data.value);
      bad.hidden = true;
    } catch (err) {
      bad.textContent = err instanceof Error ? err.message : 'invalid JSON';
      bad.hidden = false;
    }
  });

  box.append(bar, data, bad);
  return box;
}

async function refreshParts(): Promise<void> {
  ui.partsList.replaceChildren();
  if (editingId === undefined) return;
  const parts = await listParts(db, editingId);
  ui.partsCount.textContent = String(parts.length);
  if (!parts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'no parts yet — add one below';
    ui.partsList.append(empty);
    return;
  }
  for (const part of parts) ui.partsList.append(partBlock(part));
}

/** Persist every part block. Throws on the first invalid payload, naming which one. */
async function savePartBlocks(): Promise<void> {
  const blocks = Array.from(ui.partsList.querySelectorAll<HTMLDivElement>('.part-edit'));
  for (const [index, box] of blocks.entries()) {
    const id = Number(box.dataset.partId);
    const kind = box.querySelector<HTMLSelectElement>('select.kind')?.value ?? 'prose';
    const anchor = box.querySelector<HTMLInputElement>('input.anchor')?.value.trim() ?? '';
    const raw = box.querySelector<HTMLTextAreaElement>('textarea.data')?.value ?? '{}';
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('payload must be a JSON object');
      }
      data = parsed as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `part ${index + 1} (${kind}): ${err instanceof Error ? err.message : 'invalid JSON'}`,
      );
    }
    await updatePart(db, id, { kind, data, anchor: anchor || undefined });
  }
}

// ------------------------------------------------------------------------------------------- //
// relations
// ------------------------------------------------------------------------------------------- //

async function refreshRelations(): Promise<void> {
  ui.relList.replaceChildren();
  if (editingId === undefined) return;
  const related = await relatedDocuments(db, editingId, { limit: 30 });
  if (!related.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'no links yet — add one, or recompute similarity in Settings';
    ui.relList.append(li);
    return;
  }
  for (const row of related) {
    const li = document.createElement('li');

    const open = document.createElement('button');
    open.className = 'open';
    open.textContent = row.title;
    open.addEventListener('click', () => void edit(row.id));

    const type = document.createElement('span');
    type.className = 'tag';
    type.textContent = row.relation.replace(/_/g, ' ');

    const origin = document.createElement('span');
    origin.className = 'tag';
    origin.textContent = row.origin === 'tfidf' ? row.confidence.toFixed(2) : 'manual';

    const remove = document.createElement('button');
    remove.className = 'del';
    remove.textContent = '✕';
    remove.addEventListener('click', async () => {
      if (editingId === undefined) return;
      await unlink(db, editingId, row.id, row.relation);
      await refreshRelations();
      await refreshStats();
    });

    li.append(open, type, origin, remove);
    ui.relList.append(li);
  }
}

// ------------------------------------------------------------------------------------------- //
// editor
// ------------------------------------------------------------------------------------------- //

function closeEditor(): void {
  editingId = undefined;
  ui.editor.hidden = true;
  ui.newChild.disabled = true;
}

/** Fill the collection and parent pickers. Parent excludes the document's own subtree. */
async function fillPickers(current: Doc): Promise<void> {
  const collections = await listCollections(db);
  ui.edCollection.replaceChildren();
  const none = document.createElement('option');
  none.value = '0';
  none.textContent = '(none)';
  ui.edCollection.append(none);
  for (const collection of collections) {
    const option = document.createElement('option');
    option.value = String(collection.id);
    option.textContent = `${collection.title} (${collection.kind})`;
    ui.edCollection.append(option);
  }
  ui.edCollection.value = String(current.collection_id);

  // Descendants are excluded because re-parenting into your own subtree is a cycle; the model
  // rejects it, but offering it in a dropdown is a trap.
  const descendants = new Set<number>();
  const collect = (nodes: Awaited<ReturnType<typeof subtree>>): void => {
    for (const node of nodes) {
      descendants.add(node.id);
      collect(node.children);
    }
  };
  collect(await subtree(db, current.id));

  const all = await listOrdered(db, { limit: 2000 });
  ui.edParent.replaceChildren();
  const top = document.createElement('option');
  top.value = '0';
  top.textContent = '(top level)';
  ui.edParent.append(top);
  for (const doc of all) {
    if (doc.id === current.id || descendants.has(doc.id)) continue;
    const option = document.createElement('option');
    option.value = String(doc.id);
    option.textContent = `${doc.type}: ${doc.title}`;
    ui.edParent.append(option);
  }
  ui.edParent.value = String(current.parent_id);
}

async function edit(id: number): Promise<void> {
  const doc = await getDocument(db, id);
  if (!doc) return;
  editingId = id;
  const terms = await termsForDocument(db, id);

  ui.edKind.textContent = doc.type;
  ui.edTitle.value = doc.title;
  ui.edSlug.value = doc.slug;
  ui.edNumber.value = doc.number;
  ui.edSubtitle.value = doc.subtitle;
  ui.edExcerpt.value = doc.excerpt;
  ui.edCats.value = terms.filter((t) => t.kind === 'category').map((t) => t.name).join(', ');
  ui.edTags.value = terms.filter((t) => t.kind === 'tag').map((t) => t.name).join(', ');
  ui.edStatus.value = doc.status;
  ui.edVisibility.value = doc.visibility;
  await fillPickers(doc);

  ui.edErr.hidden = true;
  ui.editor.hidden = false;
  ui.newChild.disabled = false;
  await refreshParts();
  await refreshRelations();
}

async function create(type: DocumentType, parentId = 0): Promise<void> {
  const parent = parentId ? await getDocument(db, parentId) : undefined;
  const id = await createDocument(db, {
    type,
    title: type === 'page' ? 'New page' : type === 'post' ? 'New post' : 'New section',
    status: 'draft',
    parentId,
    collectionId: parent?.collection_id ?? 0,
  });
  await addPart(db, id, {
    kind: 'prose',
    anchor: 'body',
    data: { html: '<p>Write something.</p>' },
  });
  await refreshAll();
  await edit(id);
}

async function saveEditor(): Promise<void> {
  if (editingId === undefined) return;
  ui.edErr.hidden = true;
  try {
    // Parts first: if a payload is malformed the document is left untouched, so a failed save
    // does not half-apply.
    await savePartBlocks();

    const title = ui.edTitle.value.trim() || 'Untitled';
    // An emptied slug field means "derive it from the title", as WordPress does.
    const slug = ui.edSlug.value.trim() || slugify(title);
    await updateDocument(db, editingId, {
      title,
      slug,
      number: ui.edNumber.value.trim(),
      subtitle: ui.edSubtitle.value.trim(),
      excerpt: ui.edExcerpt.value.trim(),
      status: ui.edStatus.value as DocumentStatus,
      visibility: ui.edVisibility.value as Visibility,
      collectionId: Number(ui.edCollection.value),
      parentId: Number(ui.edParent.value),
    });
    await setDocumentTerms(db, editingId, 'category', parseTermList(ui.edCats.value));
    await setDocumentTerms(db, editingId, 'tag', parseTermList(ui.edTags.value));
    await pruneOrphanTerms(db);

    const saved = await getDocument(db, editingId);
    if (saved) ui.edSlug.value = saved.slug; // may have been de-duplicated

    await refreshAll();
    await refreshParts();
    // Show the result: the document itself if it is live, otherwise re-render what was on screen.
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

async function loadTemplateIntoEditor(): Promise<void> {
  ui.tplBody.value = await getTemplate(db, ui.tplName.value);
  ui.tplErr.hidden = true;
}

async function refreshStats(): Promise<void> {
  const stats = await pageStats(db);
  const media = await countMedia(db);
  const parts = await countParts(db);
  const relations = await countRelations(db);
  ui.statPages.textContent = `${stats.pages} pages`;
  ui.statParts.textContent = `${parts} parts`;
  ui.statRel.textContent = `${relations.total} links`;
  ui.dbStats.textContent =
    `${parts} parts · ${media.items} media (${formatBytes(media.bytes)}) · ` +
    `${relations.total} relations (${relations.computed} computed) · ` +
    `${stats.pages} × ${stats.pageSize} B = ${formatBytes(stats.pages * stats.pageSize)} in IndexedDB`;
}

async function wipeEverything(): Promise<void> {
  await db.exec(`DELETE FROM document_terms;
                 DELETE FROM terms;
                 DELETE FROM parts;
                 DELETE FROM relations;
                 DELETE FROM document_keys;
                 DELETE FROM recipients;
                 DELETE FROM documents;
                 DELETE FROM collections;
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
  await refreshDocList();
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
  ui.newChild.addEventListener('click', () => {
    if (editingId !== undefined) void create('section', editingId);
  });
  ui.save.addEventListener('click', () => void saveEditor());

  ui.up.addEventListener('click', async () => {
    if (editingId === undefined) return;
    await reorder(db, editingId, -1);
    await refreshDocList();
    await show(shownPath, false);
  });
  ui.down.addEventListener('click', async () => {
    if (editingId === undefined) return;
    await reorder(db, editingId, 1);
    await refreshDocList();
    await show(shownPath, false);
  });

  ui.partAdd.addEventListener('click', async () => {
    if (editingId === undefined) return;
    const kind = ui.partAddKind.value;
    // A payload skeleton per kind would be another registry to maintain; an empty object renders
    // as an empty widget, which is a clear enough prompt to fill it in.
    await addPart(db, editingId, { kind, data: {} });
    await refreshParts();
    await refreshStats();
  });

  ui.relAdd.addEventListener('click', async () => {
    if (editingId === undefined) return;
    ui.edErr.hidden = true;
    const slug = ui.relSlug.value.trim();
    if (!slug) return;
    const target = await getPublishedBySlug(db, slug);
    if (!target) {
      ui.edErr.textContent = `no published document with slug “${slug}”`;
      ui.edErr.hidden = false;
      return;
    }
    await link(db, editingId, target.id, { type: ui.relType.value as RelationType });
    ui.relSlug.value = '';
    await refreshRelations();
    await refreshStats();
    await show(shownPath, false);
  });

  ui.preview.addEventListener('click', async () => {
    if (editingId === undefined) return;
    const doc = await getDocument(db, editingId);
    if (!doc) return;
    // Preview renders the *saved* row, drafts included — the bypass renderPath will not do.
    const html = await renderPreview(db, doc, {
      base: transport.base,
      transport: `${transport.label} · draft preview`,
    });
    await transport.showHtml(html);
    ui.siteUrl.textContent = `draft preview: ${doc.slug}`;
    ui.siteCopy.disabled = true;
    ui.siteOpen.disabled = true;
  });

  ui.view.addEventListener('click', async () => {
    if (editingId === undefined) return;
    const doc = await getDocument(db, editingId);
    if (doc) await show(`${transport.base}${encodeURIComponent(doc.slug)}/`);
  });

  ui.del.addEventListener('click', async () => {
    if (editingId === undefined) return;
    const doc = await getDocument(db, editingId);
    if (!doc || !confirm(`Delete “${doc.title}” and everything under it?`)) return;
    await deleteDocument(db, doc.id);
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
      await setTemplate(db, ui.tplName.value, ui.tplBody.value);
      await show(shownPath, false);
    } catch (err) {
      ui.tplErr.textContent = err instanceof Error ? err.message : String(err);
      ui.tplErr.hidden = false;
    }
  });
  ui.tplReset.addEventListener('click', async () => {
    ui.tplBody.value = DEFAULT_TEMPLATES[ui.tplName.value] ?? '';
    await setTemplate(db, ui.tplName.value, ui.tplBody.value);
    await show(shownPath, false);
  });

  ui.setSave.addEventListener('click', async () => {
    await setSetting(db, 'site.title', ui.setTitle.value.trim());
    await setSetting(db, 'site.tagline', ui.setTagline.value.trim());
    await show(shownPath, false);
  });

  ui.simRun.addEventListener('click', async () => {
    ui.simRun.disabled = true;
    ui.simReport.textContent = 'vectorizing…';
    try {
      const report = await computeSimilar(db, {
        scope: ui.simScope.value === 'part' ? 'part' : 'document',
      });
      ui.simReport.textContent =
        `${report.items} ${report.scope}(s) vectorized → ${report.edges} similar edge(s)`;
      await refreshStats();
      await refreshRelations();
      await show(shownPath, false);
    } catch (err) {
      ui.simReport.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      ui.simRun.disabled = false;
    }
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
    const shareable = transport.linkFor(shownPath);
    if (!shareable) return;
    await navigator.clipboard?.writeText(shareable);
    ui.siteCopy.textContent = 'Copied';
    setTimeout(() => (ui.siteCopy.textContent = 'Copy link'), 1200);
  });
  ui.siteOpen.addEventListener('click', () => {
    const shareable = transport.linkFor(shownPath);
    if (shareable) open(shareable, '_blank');
  });
}

/**
 * A first-ever visit to a shared permalink has no Service Worker yet and no file on disk at that
 * path, so the host serves public/404.html, which bounces here with the original path in `?p=`.
 * Put it back in the address bar before anything reads location — shellDirectory() and
 * isSitePath() both depend on it.
 */
function restoreRequestedPermalink(): void {
  const requested = new URLSearchParams(location.search).get('p');
  if (!requested || !requested.startsWith('/')) return;
  history.replaceState(null, '', requested);
}

async function boot(): Promise<void> {
  restoreRequestedPermalink();
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

  for (const kind of BUILTIN_WIDGETS) {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = kind;
    ui.partAddKind.append(option);
  }

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
