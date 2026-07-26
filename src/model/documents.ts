// Documents: CRUD, slugs, and the hierarchy.
//
// One table holds posts, pages, book sections and numbered rules, arranged as a tree via
// parent_id + ordinal. That tree is the "sections and subsections" structure: a book is a
// document of type `book` whose children are `chapter`s whose children are `section`s, and a
// weblog is the degenerate case where everything is a top-level `post`.
//
// A document has no body. Its content is its `parts` — see parts.ts.
import type { Db } from '../engine/db.js';

export type DocumentType = 'post' | 'page' | 'section' | 'chapter' | 'book' | 'rule';
export type DocumentStatus = 'draft' | 'published';
export type Visibility = 'public' | 'protected';

export interface Doc {
  id: number;
  collection_id: number;
  parent_id: number;
  ordinal: number;
  type: DocumentType;
  slug: string;
  number: string;
  title: string;
  subtitle: string;
  excerpt: string;
  status: DocumentStatus;
  visibility: Visibility;
  source_url: string;
  created: string;
  updated: string;
}

/** A node in the hierarchy, with its children resolved. */
export interface DocNode extends Doc {
  children: DocNode[];
  depth: number;
}

/**
 * Random rather than autoincrement on purpose: under CRDT, two replicas both picking
 * "max(id)+1" offline would collide and merge into one row. 2^46 keeps it inside the
 * double-safe integer range so it survives a JSON round-trip through a changeset.
 */
export const newId = (): number => Math.floor(Math.random() * 2 ** 46) + 1;

/** WordPress's sanitize_title, more or less: lowercase, alphanumerics and single dashes. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip the combining accents NFKD just split out
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, ''); // slice may have left a trailing dash
  return slug || 'untitled';
}

/**
 * Resolve a slug that does not collide within its type, appending -2, -3, … as WordPress does.
 * `exceptId` lets a document keep its own slug when being updated.
 */
export async function uniqueSlug(
  db: Db,
  type: DocumentType,
  desired: string,
  exceptId?: number,
): Promise<string> {
  const base = slugify(desired);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const clash = await db.scalar(
      `SELECT count(*) FROM documents WHERE type = ? AND slug = ? AND id IS NOT ?`,
      [type, candidate, exceptId ?? null],
    );
    if (!Number(clash)) return candidate;
  }
}

const COLUMNS = `id, collection_id, parent_id, ordinal, type, slug, number, title, subtitle,
                 excerpt, status, visibility, source_url, created, updated`;

export interface NewDoc {
  type?: DocumentType;
  title: string;
  slug?: string;
  number?: string;
  subtitle?: string;
  excerpt?: string;
  status?: DocumentStatus;
  visibility?: Visibility;
  collectionId?: number;
  parentId?: number;
  ordinal?: number;
  sourceUrl?: string;
}

/** Next free ordinal among a parent's children, so appends land at the end. */
async function nextOrdinal(db: Db, parentId: number): Promise<number> {
  const max = await db.scalar(`SELECT max(ordinal) FROM documents WHERE parent_id = ?`, [parentId]);
  return max === null ? 0 : Number(max) + 1;
}

export async function createDocument(db: Db, input: NewDoc): Promise<number> {
  const id = newId();
  const type = input.type ?? 'post';
  const parentId = input.parentId ?? 0;
  const slug = await uniqueSlug(db, type, input.slug || input.title);
  await db.query(
    `INSERT INTO documents
       (id, collection_id, parent_id, ordinal, type, slug, number, title, subtitle,
        excerpt, status, visibility, source_url, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      input.collectionId ?? 0,
      parentId,
      input.ordinal ?? (await nextOrdinal(db, parentId)),
      type,
      slug,
      input.number ?? '',
      input.title,
      input.subtitle ?? '',
      input.excerpt ?? '',
      input.status ?? 'draft',
      input.visibility ?? 'public',
      input.sourceUrl ?? '',
    ],
  );
  return id;
}

export interface DocEdits {
  title?: string;
  slug?: string;
  number?: string;
  subtitle?: string;
  excerpt?: string;
  status?: DocumentStatus;
  visibility?: Visibility;
  collectionId?: number;
  parentId?: number;
  ordinal?: number;
  sourceUrl?: string;
}

/** Patch only the supplied fields. Re-slugs (uniquely) if `slug` is given. */
export async function updateDocument(db: Db, id: number, edits: DocEdits): Promise<void> {
  const existing = await getDocument(db, id);
  if (!existing) throw new Error(`no document ${id}`);

  if (edits.parentId !== undefined && (await createsCycle(db, id, edits.parentId))) {
    throw new Error('a document cannot be moved inside its own subtree');
  }

  const slug =
    edits.slug === undefined ? existing.slug : await uniqueSlug(db, existing.type, edits.slug, id);

  await db.query(
    `UPDATE documents
        SET title = ?, subtitle = ?, number = ?, excerpt = ?, status = ?, visibility = ?,
            slug = ?, collection_id = ?, parent_id = ?, ordinal = ?, source_url = ?,
            updated = datetime('now')
      WHERE id = ?`,
    [
      edits.title ?? existing.title,
      edits.subtitle ?? existing.subtitle,
      edits.number ?? existing.number,
      edits.excerpt ?? existing.excerpt,
      edits.status ?? existing.status,
      edits.visibility ?? existing.visibility,
      slug,
      edits.collectionId ?? existing.collection_id,
      edits.parentId ?? existing.parent_id,
      edits.ordinal ?? existing.ordinal,
      edits.sourceUrl ?? existing.source_url,
      id,
    ],
  );
}

/**
 * Would re-parenting `id` under `candidateParent` put it inside its own subtree? Walking up from
 * the candidate is cheaper than walking down from the node, and the depth guard means a database
 * that has somehow acquired a cycle cannot hang the editor.
 */
async function createsCycle(db: Db, id: number, candidateParent: number): Promise<boolean> {
  let cursor = candidateParent;
  for (let depth = 0; cursor !== 0 && depth < 64; depth++) {
    if (cursor === id) return true;
    const parent = await db.scalar(`SELECT parent_id FROM documents WHERE id = ?`, [cursor]);
    cursor = Number(parent ?? 0);
  }
  return false;
}

/**
 * Delete a document, its parts, its subtree, and every edge that referenced any of them.
 * There are no foreign keys — cr-sqlite merges rows without them — so the cascade is explicit.
 */
export async function deleteDocument(db: Db, id: number): Promise<void> {
  for (const child of await childrenOf(db, id)) await deleteDocument(db, child.id);
  await db.query(`DELETE FROM parts WHERE document_id = ?`, [id]);
  await db.query(`DELETE FROM document_terms WHERE document_id = ?`, [id]);
  await db.query(`DELETE FROM document_keys WHERE document_id = ?`, [id]);
  await db.query(
    `DELETE FROM relations
      WHERE (from_scope = 'document' AND from_id = ?) OR (to_scope = 'document' AND to_id = ?)`,
    [id, id],
  );
  await db.query(`DELETE FROM documents WHERE id = ?`, [id]);
}

export async function getDocument(db: Db, id: number): Promise<Doc | undefined> {
  return (await db.query<Doc>(`SELECT ${COLUMNS} FROM documents WHERE id = ?`, [id]))[0];
}

export async function getDocumentBySlug(
  db: Db,
  type: DocumentType,
  slug: string,
): Promise<Doc | undefined> {
  return (
    await db.query<Doc>(`SELECT ${COLUMNS} FROM documents WHERE type = ? AND slug = ?`, [type, slug])
  )[0];
}

/**
 * Resolve a permalink slug without knowing the type — which is what a request for `/about/`
 * actually gives us. Posts win a tie; they are the common case.
 */
export async function getPublishedBySlug(db: Db, slug: string): Promise<Doc | undefined> {
  return (
    await db.query<Doc>(
      `SELECT ${COLUMNS} FROM documents
        WHERE slug = ? AND status = 'published'
        ORDER BY CASE type WHEN 'post' THEN 0 WHEN 'page' THEN 1 ELSE 2 END
        LIMIT 1`,
      [slug],
    )
  )[0];
}

export interface ListOptions {
  type?: DocumentType;
  status?: DocumentStatus;
  collectionId?: number;
  parentId?: number;
  limit?: number;
}

function where(options: ListOptions): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.type) {
    clauses.push('type = ?');
    params.push(options.type);
  }
  if (options.status) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  if (options.collectionId !== undefined) {
    clauses.push('collection_id = ?');
    params.push(options.collectionId);
  }
  if (options.parentId !== undefined) {
    clauses.push('parent_id = ?');
    params.push(options.parentId);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Chronological listing — the weblog view. */
export async function listDocuments(db: Db, options: ListOptions = {}): Promise<Doc[]> {
  const { sql, params } = where(options);
  return db.query<Doc>(
    `SELECT ${COLUMNS} FROM documents ${sql} ORDER BY created DESC, id DESC LIMIT ?`,
    [...params, options.limit ?? 200],
  );
}

/** Structural listing — the table-of-contents view, in author-defined order. */
export async function listOrdered(db: Db, options: ListOptions = {}): Promise<Doc[]> {
  const { sql, params } = where(options);
  return db.query<Doc>(
    `SELECT ${COLUMNS} FROM documents ${sql} ORDER BY ordinal, id LIMIT ?`,
    [...params, options.limit ?? 2000],
  );
}

export async function childrenOf(db: Db, parentId: number): Promise<Doc[]> {
  return db.query<Doc>(
    `SELECT ${COLUMNS} FROM documents WHERE parent_id = ? ORDER BY ordinal, id`,
    [parentId],
  );
}

/** Root-to-parent chain, for breadcrumbs. Depth-guarded against a malformed tree. */
export async function ancestorsOf(db: Db, id: number): Promise<Doc[]> {
  const chain: Doc[] = [];
  let cursor = (await getDocument(db, id))?.parent_id ?? 0;
  for (let depth = 0; cursor !== 0 && depth < 64; depth++) {
    const parent = await getDocument(db, cursor);
    if (!parent) break;
    chain.unshift(parent);
    cursor = parent.parent_id;
  }
  return chain;
}

/**
 * The subtree under `rootId` as nested nodes.
 *
 * Reads every candidate row once and assembles the tree in memory rather than issuing a query
 * per node: a book with 900 sections would otherwise be 900 round trips through the single
 * connection queue. `published` restricts to what the site may show.
 */
export async function subtree(
  db: Db,
  rootId: number,
  options: { collectionId?: number; publishedOnly?: boolean } = {},
): Promise<DocNode[]> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.collectionId !== undefined) {
    clauses.push('collection_id = ?');
    params.push(options.collectionId);
  }
  if (options.publishedOnly) clauses.push(`status = 'published'`);
  const rows = await db.query<Doc>(
    `SELECT ${COLUMNS} FROM documents
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY ordinal, id`,
    params,
  );

  const byParent = new Map<number, Doc[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parent_id);
    if (siblings) siblings.push(row);
    else byParent.set(row.parent_id, [row]);
  }

  // A tree assembled from arbitrary rows can contain a cycle, which would recurse forever.
  // Visiting each id at most once bounds it without needing to detect the cycle first.
  const visited = new Set<number>();
  function build(parentId: number, depth: number): DocNode[] {
    const nodes: DocNode[] = [];
    for (const row of byParent.get(parentId) ?? []) {
      if (visited.has(row.id)) continue;
      visited.add(row.id);
      nodes.push({ ...row, depth, children: build(row.id, depth + 1) });
    }
    return nodes;
  }

  return build(rootId, 0);
}

export async function countDocuments(db: Db, options: ListOptions = {}): Promise<number> {
  const { sql, params } = where(options);
  return Number(await db.scalar(`SELECT count(*) FROM documents ${sql}`, params)) || 0;
}

/** Move a document among its siblings. Returns the new ordinal. */
export async function reorder(db: Db, id: number, direction: -1 | 1): Promise<void> {
  const doc = await getDocument(db, id);
  if (!doc) return;
  const siblings = await childrenOf(db, doc.parent_id);
  const at = siblings.findIndex((s) => s.id === id);
  const swapWith = siblings[at + direction];
  if (at < 0 || !swapWith) return;
  await db.query(`UPDATE documents SET ordinal = ? WHERE id = ?`, [swapWith.ordinal, id]);
  await db.query(`UPDATE documents SET ordinal = ? WHERE id = ?`, [doc.ordinal, swapWith.id]);
}

/** FTS5 operators, which must reach the engine verbatim rather than being quoted as terms. */
const FTS5_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * Turn plain words into an FTS5 expression. Anything that looks like real FTS5 syntax — quotes,
 * parens, `*`, `-`, `:`, or a bare operator keyword — is passed through untouched so the query
 * language stays available.
 *
 * Each word becomes `("word" OR "word"*)`: the exact form and the prefix form, OR-ed. The exact form
 * is there because the index is **stemmed**, and prefix matching against a stemmed index is
 * inherently patchy — the stem is shorter than the word, so a typed prefix longer than the stem can
 * never match. Measured against this build: for "paging", 3 characters hits, 4 and 5 miss, 6 hits;
 * for "tokenizer", 6 and 7 miss. A complete word always hits, which is why it is OR-ed in.
 *
 * The consequence worth knowing: type-ahead on a *partial* word is unreliable here, and truncating
 * the prefix does not rescue it. If live type-ahead ever matters more than finding "demand-paged"
 * from "paging", the tool is a second index on FTS5's `trigram` tokenizer — available in this build —
 * not giving up stemming.
 *
 * Groups are juxtaposed, which FTS5 reads as AND: every word must appear somehow.
 */
export function toMatchExpression(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean);
  const isPlainWords = /^[\w\s]+$/.test(query) && !tokens.some((t) => FTS5_OPERATORS.has(t));
  if (!isPlainWords) return query;
  return tokens.map((word) => `("${word}" OR "${word}"*)`).join(' ');
}


export interface DocHit {
  id: number;
  type: DocumentType;
  slug: string;
  title: string;
  number: string;
  created: string;
  rank: number;
}

/** Title/number search. Complements searchParts() in parts.ts, which searches bodies. */
export async function searchDocuments(db: Db, query: string, limit = 20): Promise<DocHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    return await db.query<DocHit>(
      `SELECT d.id, d.type, d.slug, d.title, d.number, d.created, bm25(documents_fts) AS rank
         FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
        WHERE documents_fts MATCH ? AND d.status = 'published'
        ORDER BY rank
        LIMIT ?`,
      [toMatchExpression(trimmed), limit],
    );
  } catch {
    return []; // malformed FTS5 expression while mid-typing
  }
}
