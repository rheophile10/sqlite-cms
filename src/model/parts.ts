// Parts: the atomic content unit.
//
// A part is `kind` + `data` + `text`:
//
//   kind   names a widget renderer (see widgets.ts). 'prose', 'callout', 'video', 'table', …
//   data   the JSON payload that renderer expects. Shape is the renderer's business, not ours.
//   text   the flattened prose, and the only thing the FTS index sees
//
// Keeping `text` as a stored column rather than deriving it at query time is what lets a search
// return *a paragraph* with a snippet, ranked by bm25, without the renderer being involved. It
// costs a denormalized copy, which setPartText() below is careful to keep in step.
//
// `anchor` gives every part a stable fragment id, which is what makes a part addressable:
// /p/<slug>/#<anchor> for the fragment, and /p/<slug>/part/<anchor>/ for the part on its own.
import type { Db } from '../engine/db.js';
import { flattenHtml } from './schema.js';
import { newId, slugify, toMatchExpression } from './documents.js';

/** Widget kinds with built-in renderers. Others render through the `html` fallback. */
export type PartKind =
  | 'prose'
  | 'heading'
  | 'html'
  | 'code'
  | 'quote'
  | 'list'
  | 'table'
  | 'callout'
  | 'figure'
  | 'video'
  | 'story'
  | 'sealed';

export interface Part {
  id: number;
  document_id: number;
  parent_id: number;
  ordinal: number;
  kind: string;
  anchor: string;
  /** Raw JSON as stored. Use partData() to get it parsed. */
  data: string;
  text: string;
}

export interface PartInput {
  kind: string;
  data: Record<string, unknown>;
  /** Overrides the derived flattening. Pass '' for a part that should not be searchable. */
  text?: string;
  anchor?: string;
  parentId?: number;
  ordinal?: number;
}

const COLUMNS = `id, document_id, parent_id, ordinal, kind, anchor, data, text`;

/**
 * Parse a part's payload. Never throws: `data` is author-editable in the admin, and a JSON typo
 * should render an empty widget rather than take the page down.
 */
export function partData(part: Part): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(part.data);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The searchable projection of a payload.
 *
 * Deliberately generic: it walks whatever strings the payload happens to contain rather than
 * knowing each widget's shape, so a new widget kind is searchable the moment it exists without
 * anything here changing. Keys that hold markup are flattened; keys that name assets or
 * languages are skipped, because "mp4" is not a search term anybody wants.
 */
const NON_TEXT_KEYS = new Set(['src', 'href', 'poster', 'lang', 'language', 'mime', 'id', 'slug']);

export function deriveText(data: Record<string, unknown>): string {
  const found: string[] = [];
  const walk = (value: unknown, key: string): void => {
    if (typeof value === 'string') {
      if (!NON_TEXT_KEYS.has(key)) found.push(/<[a-z][\s\S]*>/i.test(value) ? flattenHtml(value) : value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(data, '');
  return found.join(' ').replace(/\s+/g, ' ').trim();
}

/** A part's anchor must be unique within its document, since it is a URL. */
async function uniqueAnchor(
  db: Db,
  documentId: number,
  desired: string,
  exceptId?: number,
): Promise<string> {
  const base = slugify(desired || 'part');
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const clash = await db.scalar(
      `SELECT count(*) FROM parts WHERE document_id = ? AND anchor = ? AND id IS NOT ?`,
      [documentId, candidate, exceptId ?? null],
    );
    if (!Number(clash)) return candidate;
  }
}

async function nextOrdinal(db: Db, documentId: number): Promise<number> {
  const max = await db.scalar(`SELECT max(ordinal) FROM parts WHERE document_id = ?`, [documentId]);
  return max === null ? 0 : Number(max) + 1;
}

/** A reasonable anchor when the author has not chosen one: the first few words of the text. */
function anchorFrom(input: PartInput, text: string): string {
  if (input.anchor) return input.anchor;
  const words = text.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  return words || input.kind;
}

export async function addPart(db: Db, documentId: number, input: PartInput): Promise<number> {
  const id = newId();
  const text = input.text ?? deriveText(input.data);
  const anchor = await uniqueAnchor(db, documentId, anchorFrom(input, text));
  await db.query(
    `INSERT INTO parts (id, document_id, parent_id, ordinal, kind, anchor, data, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      documentId,
      input.parentId ?? 0,
      input.ordinal ?? (await nextOrdinal(db, documentId)),
      input.kind,
      anchor,
      JSON.stringify(input.data),
      text,
    ],
  );
  return id;
}

export async function updatePart(
  db: Db,
  id: number,
  edits: { kind?: string; data?: Record<string, unknown>; text?: string; anchor?: string },
): Promise<void> {
  const existing = await getPart(db, id);
  if (!existing) throw new Error(`no part ${id}`);

  const data = edits.data ?? partData(existing);
  const kind = edits.kind ?? existing.kind;
  // A sealed part must never carry plaintext in `text`; the FTS trigger also guards this, but
  // the column itself is what a changeset would replicate.
  const text = kind === 'sealed' ? '' : edits.text ?? deriveText(data);
  const anchor =
    edits.anchor === undefined
      ? existing.anchor
      : await uniqueAnchor(db, existing.document_id, edits.anchor, id);

  await db.query(`UPDATE parts SET kind = ?, data = ?, text = ?, anchor = ? WHERE id = ?`, [
    kind,
    JSON.stringify(data),
    text,
    anchor,
    id,
  ]);
}

export async function deletePart(db: Db, id: number): Promise<void> {
  for (const child of await db.query<Part>(`SELECT ${COLUMNS} FROM parts WHERE parent_id = ?`, [id])) {
    await deletePart(db, child.id);
  }
  await db.query(
    `DELETE FROM relations WHERE (from_scope = 'part' AND from_id = ?) OR (to_scope = 'part' AND to_id = ?)`,
    [id, id],
  );
  await db.query(`DELETE FROM parts WHERE id = ?`, [id]);
}

export async function getPart(db: Db, id: number): Promise<Part | undefined> {
  return (await db.query<Part>(`SELECT ${COLUMNS} FROM parts WHERE id = ?`, [id]))[0];
}

export async function getPartByAnchor(
  db: Db,
  documentId: number,
  anchor: string,
): Promise<Part | undefined> {
  return (
    await db.query<Part>(`SELECT ${COLUMNS} FROM parts WHERE document_id = ? AND anchor = ?`, [
      documentId,
      anchor,
    ])
  )[0];
}

/** A document's top-level parts, in order. Nested parts come back via childPartsOf(). */
export async function listParts(db: Db, documentId: number): Promise<Part[]> {
  return db.query<Part>(
    `SELECT ${COLUMNS} FROM parts WHERE document_id = ? AND parent_id = 0 ORDER BY ordinal, id`,
    [documentId],
  );
}

/** Every part of a document regardless of nesting — for search indexing and similarity. */
export async function allParts(db: Db, documentId: number): Promise<Part[]> {
  return db.query<Part>(
    `SELECT ${COLUMNS} FROM parts WHERE document_id = ? ORDER BY ordinal, id`,
    [documentId],
  );
}

export async function childPartsOf(db: Db, parentPartId: number): Promise<Part[]> {
  return db.query<Part>(
    `SELECT ${COLUMNS} FROM parts WHERE parent_id = ? ORDER BY ordinal, id`,
    [parentPartId],
  );
}

/** Replace a document's parts wholesale. Used by importers and by the admin's parts editor. */
export async function setParts(
  db: Db,
  documentId: number,
  inputs: readonly PartInput[],
): Promise<void> {
  await db.query(`DELETE FROM parts WHERE document_id = ?`, [documentId]);
  for (const [index, input] of inputs.entries()) {
    await addPart(db, documentId, { ...input, ordinal: input.ordinal ?? index });
  }
}

/** Move a part among its siblings. */
export async function reorderPart(db: Db, id: number, direction: -1 | 1): Promise<void> {
  const part = await getPart(db, id);
  if (!part) return;
  const siblings = await db.query<Part>(
    `SELECT ${COLUMNS} FROM parts WHERE document_id = ? AND parent_id = ? ORDER BY ordinal, id`,
    [part.document_id, part.parent_id],
  );
  const at = siblings.findIndex((s) => s.id === id);
  const swapWith = siblings[at + direction];
  if (at < 0 || !swapWith) return;
  await db.query(`UPDATE parts SET ordinal = ? WHERE id = ?`, [swapWith.ordinal, id]);
  await db.query(`UPDATE parts SET ordinal = ? WHERE id = ?`, [part.ordinal, swapWith.id]);
}

/** The whole document as flat text — what similarity.ts vectorizes. Skips sealed parts. */
export async function documentText(db: Db, documentId: number): Promise<string> {
  const rows = await db.query<{ text: string }>(
    `SELECT text FROM parts WHERE document_id = ? AND kind IS NOT 'sealed' ORDER BY ordinal, id`,
    [documentId],
  );
  return rows.map((r) => r.text).join(' ').trim();
}

export interface PartHit {
  part_id: number;
  anchor: string;
  kind: string;
  document_id: number;
  slug: string;
  title: string;
  number: string;
  type: string;
  created: string;
  /** FTS5 snippet over the part text, matches wrapped in «». */
  snippet: string;
  rank: number;
}

/**
 * Search *parts*, returning each with the document it belongs to.
 *
 * This is the query the whole parts model exists to make possible: a hit is a paragraph, a
 * clause or a table, addressable on its own, not a whole entry you then have to scan by eye.
 * Restricted to published documents, and sealed parts index as empty so they cannot match.
 */
export async function searchParts(db: Db, query: string, limit = 30): Promise<PartHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    return await db.query<PartHit>(
      `SELECT p.id AS part_id, p.anchor, p.kind, p.document_id,
              d.slug, d.title, d.number, d.type, d.created,
              snippet(parts_fts, 0, '«', '»', '…', 20) AS snippet,
              bm25(parts_fts) AS rank
         FROM parts_fts
         JOIN parts p     ON p.id = parts_fts.rowid
         JOIN documents d ON d.id = p.document_id
        WHERE parts_fts MATCH ?
          AND d.status = 'published'
          AND d.visibility = 'public'
        ORDER BY rank
        LIMIT ?`,
      [toMatchExpression(trimmed), limit],
    );
  } catch {
    return []; // malformed FTS5 expression while mid-typing
  }
}

export async function countParts(db: Db): Promise<number> {
  return Number(await db.scalar(`SELECT count(*) FROM parts`)) || 0;
}
