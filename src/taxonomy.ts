// Categories and tags. One table, one join table — wp_terms and wp_term_relationships with
// the taxonomy folded into a `kind` column, since two taxonomies is all this needs.
import type { Db } from './db.js';
import { newId, slugify } from './documents.js';

export type TermKind = 'category' | 'tag';

export interface Term {
  id: number;
  kind: TermKind;
  slug: string;
  name: string;
}

export interface TermWithCount extends Term {
  count: number;
}

/** Get a term by name, creating it if absent. Returns its id. */
export async function ensureTerm(db: Db, kind: TermKind, name: string): Promise<number> {
  const slug = slugify(name);
  const existing = await db.scalar(`SELECT id FROM terms WHERE kind = ? AND slug = ?`, [
    kind,
    slug,
  ]);
  if (existing !== null) return Number(existing);
  const id = newId();
  await db.query(`INSERT INTO terms (id, kind, slug, name) VALUES (?, ?, ?, ?)`, [
    id,
    kind,
    slug,
    name.trim(),
  ]);
  return id;
}

export async function getTermBySlug(
  db: Db,
  kind: TermKind,
  slug: string,
): Promise<Term | undefined> {
  return (
    await db.query<Term>(`SELECT id, kind, slug, name FROM terms WHERE kind = ? AND slug = ?`, [
      kind,
      slug,
    ])
  )[0];
}

/** Terms attached to a document, categories before tags. */
export async function termsForDocument(db: Db, documentId: number): Promise<Term[]> {
  return db.query<Term>(
    `SELECT t.id, t.kind, t.slug, t.name
       FROM terms t JOIN document_terms pt ON pt.term_id = t.id
      WHERE pt.document_id = ?
      ORDER BY CASE t.kind WHEN 'category' THEN 0 ELSE 1 END, t.name`,
    [documentId],
  );
}

/**
 * Replace a document's terms of one kind wholesale. Names are free text from the editor —
 * comma-separated — so blanks and duplicates are filtered here rather than at the call site.
 */
export async function setDocumentTerms(
  db: Db,
  documentId: number,
  kind: TermKind,
  names: readonly string[],
): Promise<void> {
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];

  // Drop existing links of this kind only; the other taxonomy is untouched.
  await db.query(
    `DELETE FROM document_terms
      WHERE document_id = ?
        AND term_id IN (SELECT id FROM terms WHERE kind = ?)`,
    [documentId, kind],
  );

  for (const name of wanted) {
    const termId = await ensureTerm(db, kind, name);
    await db.query(`INSERT OR IGNORE INTO document_terms (document_id, term_id) VALUES (?, ?)`, [
      documentId,
      termId,
    ]);
  }
}

/** Parse the editor's comma-separated term field. */
export function parseTermList(input: string): string[] {
  return input
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** All terms of a kind that have at least one published document — the site's term cloud. */
export async function listTerms(db: Db, kind: TermKind): Promise<TermWithCount[]> {
  return db.query<TermWithCount>(
    `SELECT t.id, t.kind, t.slug, t.name, count(p.id) AS count
       FROM terms t
       JOIN document_terms pt ON pt.term_id = t.id
       JOIN documents p   ON p.id = pt.document_id AND p.status = 'published'
      WHERE t.kind = ?
      GROUP BY t.id
      ORDER BY count DESC, t.name`,
    [kind],
  );
}

/** Remove terms no longer attached to any document. Called after deleting one. */
export async function pruneOrphanTerms(db: Db): Promise<void> {
  await db.exec(
    `DELETE FROM terms WHERE id NOT IN (SELECT DISTINCT term_id FROM document_terms)`,
  );
}
