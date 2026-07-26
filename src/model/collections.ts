// Collections: a blog, or a book, or a shelf of books.
//
// The container a document tree hangs off. A weblog needs exactly one and mostly ignores it; a
// corpus of rule books needs one per book, which is what makes "sections and subsections within
// a blog" and "chapters within a book" the same mechanism.
import type { Db } from '../engine/db.js';
import { newId, slugify } from './documents.js';

export type CollectionKind = 'blog' | 'book' | 'shelf';

export interface Collection {
  id: number;
  slug: string;
  kind: CollectionKind;
  title: string;
  subtitle: string;
  ordinal: number;
  created: string;
}

export interface CollectionWithCount extends Collection {
  count: number;
}

const COLUMNS = `id, slug, kind, title, subtitle, ordinal, created`;

export async function createCollection(
  db: Db,
  input: { title: string; slug?: string; kind?: CollectionKind; subtitle?: string; ordinal?: number },
): Promise<number> {
  const id = newId();
  await db.query(
    `INSERT INTO collections (id, slug, kind, title, subtitle, ordinal, created)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      id,
      slugify(input.slug || input.title),
      input.kind ?? 'blog',
      input.title,
      input.subtitle ?? '',
      input.ordinal ?? 0,
    ],
  );
  return id;
}

/** Get by slug, creating it if absent — what an importer wants. */
export async function ensureCollection(
  db: Db,
  input: { title: string; slug?: string; kind?: CollectionKind; subtitle?: string },
): Promise<number> {
  const slug = slugify(input.slug || input.title);
  const existing = await db.scalar(`SELECT id FROM collections WHERE slug = ?`, [slug]);
  if (existing !== null) return Number(existing);
  return createCollection(db, { ...input, slug });
}

export async function getCollection(db: Db, id: number): Promise<Collection | undefined> {
  return (await db.query<Collection>(`SELECT ${COLUMNS} FROM collections WHERE id = ?`, [id]))[0];
}

export async function getCollectionBySlug(db: Db, slug: string): Promise<Collection | undefined> {
  return (
    await db.query<Collection>(`SELECT ${COLUMNS} FROM collections WHERE slug = ?`, [slug])
  )[0];
}

export async function updateCollection(
  db: Db,
  id: number,
  edits: { title?: string; subtitle?: string; kind?: CollectionKind; ordinal?: number },
): Promise<void> {
  const existing = await getCollection(db, id);
  if (!existing) throw new Error(`no collection ${id}`);
  await db.query(
    `UPDATE collections SET title = ?, subtitle = ?, kind = ?, ordinal = ? WHERE id = ?`,
    [
      edits.title ?? existing.title,
      edits.subtitle ?? existing.subtitle,
      edits.kind ?? existing.kind,
      edits.ordinal ?? existing.ordinal,
      id,
    ],
  );
}

/**
 * Collections with a count of the published documents in each.
 *
 * LEFT JOIN so an empty collection still appears — the admin needs to see one it has just made.
 */
export async function listCollections(db: Db): Promise<CollectionWithCount[]> {
  return db.query<CollectionWithCount>(
    `SELECT c.id, c.slug, c.kind, c.title, c.subtitle, c.ordinal, c.created,
            count(d.id) AS count
       FROM collections c
       LEFT JOIN documents d ON d.collection_id = c.id AND d.status = 'published'
      GROUP BY c.id
      ORDER BY c.ordinal, c.title`,
  );
}

/** Delete the collection only; its documents are detached, not destroyed. */
export async function deleteCollection(db: Db, id: number): Promise<void> {
  await db.query(`UPDATE documents SET collection_id = 0 WHERE collection_id = ?`, [id]);
  await db.query(`DELETE FROM collections WHERE id = ?`, [id]);
}
