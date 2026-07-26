// Typed edges between documents, or between parts.
//
// Three kinds of edge end up in here, and keeping them in one table is deliberate:
//
//   manual        an author saying "see also", "this supersedes that"
//   tfidf         computed neighbours from similarity.ts, carrying a confidence
//   number_match  structural inference, e.g. two editions of the same numbered rule
//
// `origin` is what lets a recomputation clear only its own edges and leave an author's alone.
import type { Db } from '../engine/db.js';
import { newId } from './documents.js';

export type RelationScope = 'document' | 'part';
export type RelationType =
  /** Computed neighbours — see similarity.ts. */
  | 'similar'
  /** The same thing said in two places: two editions of one numbered rule. */
  | 'equivalent'
  | 'see_also'
  | 'supersedes'
  | 'superseded_by'
  | 'derived_from'
  | 'cross_reference'
  | 'amends'
  /** A question that examines a passage — a flashcard against the rule it drills. */
  | 'tests'
  /** An explicit citation, with the detail (page, clause) in `metadata`. */
  | 'references';

export type RelationOrigin = 'manual' | 'tfidf' | 'number_match' | 'import';

/** Types that imply an edge the other way, and what that edge is. */
const INVERSE: Partial<Record<RelationType, RelationType>> = {
  supersedes: 'superseded_by',
  superseded_by: 'supersedes',
  see_also: 'see_also',
  similar: 'similar',
  equivalent: 'equivalent',
  cross_reference: 'cross_reference',
  // `tests` and `references` are directional and have no natural inverse: a card tests a rule, and
  // "is tested by" is a query, not an edge worth storing twice.
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
  /** Raw JSON, or null. Use relationMetadata() to get it parsed. */
  metadata: string | null;
}

const COLUMNS = `id, from_scope, from_id, to_scope, to_id, type, confidence, origin, note, metadata`;

/**
 * Parse an edge's metadata. Never throws: the column is free-form by design, and a malformed value
 * should degrade to "no extra detail" rather than take a page down.
 */
export function relationMetadata(relation: Pick<Relation, 'metadata'>): Record<string, unknown> {
  if (!relation.metadata) return {};
  try {
    const parsed: unknown = JSON.parse(relation.metadata);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface LinkOptions {
  type?: RelationType;
  confidence?: number;
  origin?: RelationOrigin;
  note?: string;
  /** Anything extra this edge type needs. Omitted entirely stores NULL, not '{}'. */
  metadata?: Record<string, unknown> | null;
  fromScope?: RelationScope;
  toScope?: RelationScope;
  /**
   * Also write the inverse edge, where the type has one. Defaults to true except for `tfidf`,
   * where the reverse arrives on its own and writing it would double the work.
   */
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
      `INSERT INTO relations
         (id, from_scope, from_id, to_scope, to_id, type, confidence, origin, note, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_scope, from_id, to_scope, to_id, type)
         DO UPDATE SET confidence = excluded.confidence, note = excluded.note,
                       origin = excluded.origin, metadata = excluded.metadata`,
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
        // Absent means NULL. Storing '{}' would make "has no metadata" and "has empty metadata"
        // indistinguishable, and every row pay for a value it does not have.
        options.metadata ? JSON.stringify(options.metadata) : null,
      ],
    );
  };

  await insert(fromScope, fromId, toScope, toId, type);

  // Symmetric and inverse types get their other direction written, so navigation works from both
  // ends. The exception is `tfidf`: cosine is symmetric, so a bulk run reaches the reverse edge on
  // its own when it processes that neighbour, and forcing it would double every write.
  const inverse = INVERSE[type];
  const reciprocal = options.reciprocal ?? origin !== 'tfidf';
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
