// Crude-but-effective relatedness: TF-IDF vectors and cosine similarity, no dependencies and no
// network. A direct port of CROR's rail-document-db/pipelines/similarity.py, which observed that
// lexical cosine works unusually well on a corpus where texts inherit near-identical wording —
// it surfaces both restatements and merely thematic neighbours.
//
// Two layers, on purpose:
//
//   cosineNeighbours()  pure function over a Map of id → text. No database, no I/O, unit-testable.
//   computeSimilar()    reads the corpus, calls the above, writes relations(origin='tfidf').
//
// The docstring on the Python original anticipates the upgrade path and it still holds: when
// embeddings are available, keep this shape, add a vectors table, and swap the vector source.
// `relations` and every consumer of it stay exactly as they are.
import type { Db } from './db.js';
import { link, clearByOrigin, type RelationScope } from './relations.js';

/**
 * Words carrying no topical signal. Kept as one string for the same reason the Python does: it is
 * a list to be read and edited by a human, not a data structure.
 */
const STOP = new Set(
  (
    'the a an and or of to in on for by is are be as at with from that this it ' +
    'must will shall not no any each other such which who when where been being have has had ' +
    'may can if then than so but all one two more most also into upon out over under between ' +
    'he she they them his her its their you your we our i was were would could should there here'
  ).split(/\s+/),
);

/** Words of three letters or more, lowercased, minus the stop list. */
export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  return words.filter((word) => !STOP.has(word));
}

export interface SimilarityOptions {
  /** Neighbours kept per item. */
  k?: number;
  /** Cosine score below which an edge is not worth recording. */
  minScore?: number;
  /** Items with fewer tokens than this are skipped — stubs match everything weakly. */
  minTokens?: number;
  /**
   * Terms appearing in more than this fraction of the corpus are dropped. Their idf is near zero
   * so they contribute almost nothing to the score, but they dominate the inverted-index scan.
   */
  maxDocumentFraction?: number;
}

const DEFAULTS: Required<SimilarityOptions> = {
  k: 12,
  minScore: 0.09,
  minTokens: 6,
  maxDocumentFraction: 0.3,
};

export interface Neighbour {
  id: number;
  score: number;
}

/**
 * Top-k cosine neighbours for every item, over TF-IDF vectors.
 *
 * Scoring goes through an inverted index rather than comparing every pair: with vectors this
 * sparse, only items sharing a term can have a non-zero score, so the O(n²) pass is avoided.
 * That is what makes it viable to run in a browser tab over a few thousand items.
 */
export function cosineNeighbours(
  corpus: ReadonlyMap<number, string>,
  options: SimilarityOptions = {},
): Map<number, Neighbour[]> {
  const { k, minScore, minTokens, maxDocumentFraction } = { ...DEFAULTS, ...options };

  const tokens = new Map<number, string[]>();
  for (const [id, text] of corpus) {
    const words = tokenize(text);
    if (words.length >= minTokens) tokens.set(id, words);
  }

  const total = tokens.size;
  if (total < 2) return new Map();

  // Document frequency, then inverse document frequency for the terms worth keeping.
  const documentFrequency = new Map<string, number>();
  for (const words of tokens.values()) {
    for (const word of new Set(words)) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }
  // The df ceiling exists to drop terms whose idf is near zero: they contribute almost nothing to
  // a score but dominate the inverted-index scan. On a large corpus that is a clear win.
  //
  // On a *small* one it is actively wrong, and this is where the Python original's assumptions do
  // not carry over. It ran over thousands of rules; a weblog might have four entries, and
  // 0.3 × 4 = 1.2 drops every term appearing in more than one document — which is to say every
  // term that could possibly indicate similarity. The result is silently zero edges.
  //
  // So below SMALL_CORPUS the ceiling is only "appears in literally everything", where idf is
  // exactly 0 and the term genuinely cannot discriminate.
  const SMALL_CORPUS = 20;
  const ceiling = total < SMALL_CORPUS ? total : maxDocumentFraction * total;
  const idf = new Map<string, number>();
  for (const [word, count] of documentFrequency) {
    if (count < ceiling) idf.set(word, Math.log(total / count));
  }

  // Sublinear tf, weighted by idf, then L2-normalized so a dot product *is* the cosine.
  const vectors = new Map<number, Map<string, number>>();
  for (const [id, words] of tokens) {
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);

    const vector = new Map<string, number>();
    for (const [word, count] of counts) {
      const weight = idf.get(word);
      if (weight !== undefined) vector.set(word, (1 + Math.log(count)) * weight);
    }
    let norm = 0;
    for (const value of vector.values()) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (const [word, value] of vector) vector.set(word, value / norm);
    if (vector.size) vectors.set(id, vector);
  }

  const inverted = new Map<string, [number, number][]>();
  for (const [id, vector] of vectors) {
    for (const [word, weight] of vector) {
      const postings = inverted.get(word);
      if (postings) postings.push([id, weight]);
      else inverted.set(word, [[id, weight]]);
    }
  }

  const result = new Map<number, Neighbour[]>();
  for (const [id, vector] of vectors) {
    const scores = new Map<number, number>();
    for (const [word, weight] of vector) {
      for (const [other, otherWeight] of inverted.get(word) ?? []) {
        if (other === id) continue;
        scores.set(other, (scores.get(other) ?? 0) + weight * otherWeight);
      }
    }
    const top = [...scores.entries()]
      .filter(([, score]) => score >= minScore)
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([other, score]) => ({ id: other, score: Math.round(score * 1000) / 1000 }));
    if (top.length) result.set(id, top);
  }
  return result;
}

export interface ComputeOptions extends SimilarityOptions {
  /** Relate whole documents, or individual parts. */
  scope?: RelationScope;
}

export interface ComputeReport {
  scope: RelationScope;
  items: number;
  edges: number;
}

/**
 * Recompute `similar` edges for the whole corpus.
 *
 * Clears only origin='tfidf' edges of this scope, so authored links survive. Edges are written
 * one-directionally per neighbour; because cosine is symmetric the reverse edge almost always
 * arrives on its own when that neighbour is processed, and forcing it would double the writes.
 */
export async function computeSimilar(db: Db, options: ComputeOptions = {}): Promise<ComputeReport> {
  const scope: RelationScope = options.scope ?? 'document';
  const corpus =
    scope === 'document' ? await documentCorpus(db) : await partCorpus(db);

  const neighbours = cosineNeighbours(corpus, options);
  await clearByOrigin(db, 'tfidf', scope);

  let edges = 0;
  for (const [id, list] of neighbours) {
    for (const neighbour of list) {
      await link(db, id, neighbour.id, {
        type: 'similar',
        fromScope: scope,
        toScope: scope,
        confidence: neighbour.score,
        origin: 'tfidf',
        reciprocal: false,
      });
      edges++;
    }
  }
  return { scope, items: corpus.size, edges };
}

/**
 * Every published document as one string of text, assembled from its parts.
 *
 * One grouped query rather than a text lookup per document: everything funnels through the single
 * connection, so a per-document query would be a round trip per document. group_concat does not
 * promise an order, which does not matter — this is a bag of words either way.
 */
async function documentCorpus(db: Db): Promise<Map<number, string>> {
  const rows = await db.query<{ id: number; text: string }>(
    `SELECT p.document_id AS id, group_concat(p.text, ' ') AS text
       FROM parts p JOIN documents d ON d.id = p.document_id
      WHERE d.status = 'published' AND p.kind IS NOT 'sealed'
      GROUP BY p.document_id`,
  );
  return new Map(rows.filter((row) => row.text).map((row) => [row.id, row.text]));
}

/** Every part of a published document, individually. Sealed parts hold no text and drop out. */
async function partCorpus(db: Db): Promise<Map<number, string>> {
  const rows = await db.query<{ id: number; text: string }>(
    `SELECT p.id, p.text
       FROM parts p JOIN documents d ON d.id = p.document_id
      WHERE d.status = 'published' AND p.kind IS NOT 'sealed' AND p.text IS NOT ''`,
  );
  return new Map(rows.map((row) => [row.id, row.text]));
}
