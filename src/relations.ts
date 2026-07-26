// Typed edges between documents, or between parts.
//
// Three kinds of edge end up in here, and keeping them in one table is deliberate:
//
//   manual        an author saying "see also", "this supersedes that"
//   tfidf         computed neighbours from similarity.ts, carrying a confidence
//   number_match  structural inference, e.g. two editions of the same numbered rule
//
// `origin` is what lets a recomputation clear only its own edges and leave an author's alone.
import type { Db } from './db.js';
import { newId } from './documents.js';

export type RelationScope = 'document' | 'part';
export type RelationType =
  | 'similar'
  | 'see_also'
  | 'supersedes'
  | 'superseded_by'
  | 'derived_from'
  | 'cross_reference'
  | 'amends';

export type RelationOrigin = 'manual' | 'tfidf' | 'number_match';

/** Types that imply an edge the other way, and what that edge is. */
const INVERSE: Partial<Record<RelationType, RelationType>> = {
  supersedes: 'superseded_by',
  superseded_by: 'supersedes',
  see_also: 'see_also',
  similar: 'similar',
  cross_reference: 'cross_reference',
};

export interface Relation {
  id: number;
  from_scope: RelationScope;
  from_id: number;
  to_scope: RelationScope;
  to_id: number;
  type: RelationType;
  confidence: number;
  origin: RelationOrigin;
  note: string;
}

const COLUMNS = `id, from_scope, from_id, to_scope, to_id, type, confidence, origin, note`;

export interface LinkOptions {
  type?: RelationType;
  confidence?: number;
  origin?: RelationOrigin;
  note?: string;
  fromScope?: RelationScope;
  toScope?: RelationScope;
  /** Also write the inverse edge, where the type has one. Default true for manual links. */
  reciprocal?: boolean;
}

export async function link(
  db: Db,
  fromId: number,
  toId: number,
  options: LinkOptions = {},
): Promise<void> {
  const type = options.type ?? 'see_also';
  const fromScope = options.fromScope ?? 'document';
  const toScope = options.toScope ?? fromScope;
  const origin = options.origin ?? 'manual';
  // A self-edge is always noise, and would show a document as related to itself.
  if (fromScope === toScope && fromId === toId) return;

  const insert = async (
    aScope: RelationScope,
    a: number,
    bScope: RelationScope,
    b: number,
    edgeType: RelationType,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO relations (id, from_scope, from_id, to_scope, to_id, type, confidence, origin, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_scope, from_id, to_scope, to_id, type)
         DO UPDATE SET confidence = excluded.confidence, note = excluded.note, origin = excluded.origin`,
      [
        newId(),
        aScope,
        a,
        bScope,
        b,
        edgeType,
        options.confidence ?? 0,
        origin,
        options.note ?? '',
      ],
    );
  };

  await insert(fromScope, fromId, toScope, toId, type);

  const inverse = INVERSE[type];
  const reciprocal = options.reciprocal ?? origin === 'manual';
  if (reciprocal && inverse) await insert(toScope, toId, fromScope, fromId, inverse);
}

export async function unlink(
  db: Db,
  fromId: number,
  toId: number,
  type: RelationType,
  fromScope: RelationScope = 'document',
  toScope: RelationScope = fromScope,
): Promise<void> {
  await db.query(
    `DELETE FROM relations
      WHERE from_scope = ? AND from_id = ? AND to_scope = ? AND to_id = ? AND type = ?`,
    [fromScope, fromId, toScope, toId, type],
  );
  const inverse = INVERSE[type];
  if (inverse) {
    await db.query(
      `DELETE FROM relations
        WHERE from_scope = ? AND from_id = ? AND to_scope = ? AND to_id = ? AND type = ?`,
      [toScope, toId, fromScope, fromId, inverse],
    );
  }
}

/** Drop every edge from one origin — how a recomputation avoids touching authored links. */
export async function clearByOrigin(
  db: Db,
  origin: RelationOrigin,
  scope?: RelationScope,
): Promise<void> {
  if (scope) {
    await db.query(`DELETE FROM relations WHERE origin = ? AND from_scope = ?`, [origin, scope]);
  } else {
    await db.query(`DELETE FROM relations WHERE origin = ?`, [origin]);
  }
}

export async function relationsFrom(
  db: Db,
  id: number,
  options: { scope?: RelationScope; type?: RelationType; limit?: number } = {},
): Promise<Relation[]> {
  const clauses = ['from_scope = ?', 'from_id = ?'];
  const params: (string | number)[] = [options.scope ?? 'document', id];
  if (options.type) {
    clauses.push('type = ?');
    params.push(options.type);
  }
  params.push(options.limit ?? 50);
  return db.query<Relation>(
    `SELECT ${COLUMNS} FROM relations WHERE ${clauses.join(' AND ')}
      ORDER BY confidence DESC, id LIMIT ?`,
    params,
  );
}

export interface RelatedDoc {
  id: number;
  slug: string;
  title: string;
  number: string;
  type: string;
  excerpt: string;
  created: string;
  relation: RelationType;
  confidence: number;
  origin: RelationOrigin;
}

/**
 * Related documents, resolved for display — the "see also" block under an entry.
 *
 * Joins through in one query rather than fetching edges then documents: the single connection
 * serializes everything, so N+1 here would be N+1 round trips.
 */
export async function relatedDocuments(
  db: Db,
  documentId: number,
  options: { types?: RelationType[]; limit?: number; minConfidence?: number } = {},
): Promise<RelatedDoc[]> {
  const types = options.types ?? ['similar', 'see_also', 'supersedes', 'superseded_by', 'derived_from'];
  // Parameterizing an IN list needs one placeholder per value; the values are our own literals.
  const placeholders = types.map(() => '?').join(', ');
  return db.query<RelatedDoc>(
    `SELECT d.id, d.slug, d.title, d.number, d.type, d.excerpt, d.created,
            r.type AS relation, r.confidence, r.origin
       FROM relations r
       JOIN documents d ON d.id = r.to_id
      WHERE r.from_scope = 'document' AND r.from_id = ?
        AND r.to_scope = 'document'
        AND r.type IN (${placeholders})
        AND r.confidence >= ?
        AND d.status = 'published'
      ORDER BY r.confidence DESC, d.created DESC
      LIMIT ?`,
    [documentId, ...types, options.minConfidence ?? 0, options.limit ?? 8],
  );
}

/** Related parts, resolved with the document each belongs to. */
export interface RelatedPart {
  part_id: number;
  anchor: string;
  kind: string;
  text: string;
  document_id: number;
  slug: string;
  title: string;
  relation: RelationType;
  confidence: number;
}

export async function relatedParts(
  db: Db,
  partId: number,
  options: { limit?: number } = {},
): Promise<RelatedPart[]> {
  return db.query<RelatedPart>(
    `SELECT p.id AS part_id, p.anchor, p.kind, p.text, p.document_id,
            d.slug, d.title, r.type AS relation, r.confidence
       FROM relations r
       JOIN parts p     ON p.id = r.to_id
       JOIN documents d ON d.id = p.document_id
      WHERE r.from_scope = 'part' AND r.from_id = ? AND r.to_scope = 'part'
        AND d.status = 'published'
      ORDER BY r.confidence DESC
      LIMIT ?`,
    [partId, options.limit ?? 8],
  );
}

export async function countRelations(db: Db): Promise<{ total: number; computed: number }> {
  return {
    total: Number(await db.scalar(`SELECT count(*) FROM relations`)) || 0,
    computed: Number(await db.scalar(`SELECT count(*) FROM relations WHERE origin = 'tfidf'`)) || 0,
  };
}
