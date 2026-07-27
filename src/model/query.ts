// Querying the database from URL parameters.
//
// The URL *is* the query. Every filter is a parameter, so a result set is a link: shareable,
// bookmarkable, and back-button-able without any client state. `/p/query/?q=pager&tag=sqlite` is a
// full-text search intersected with a tag, and it means the same thing tomorrow.
//
//   match      a raw FTS5 expression, passed through verbatim. Nothing is rewritten
//   like       arbitrary text — paste a paragraph and get the passages closest to it
//   q          convenience form: bare words are compiled; real FTS5 syntax passes through
//   tag        tag slug; repeatable, or comma-separated
//   category   category slug; repeatable, or comma-separated
//   terms      how to combine several tags/categories — `all` (default) or `any`
//   type       document type: post | page | section | chapter | book | rule
//   kind       part kind: prose | callout | code | table | …
//   collection collection slug
//   sort       relevance (default when q is present) | newest | oldest
//   group      parts (default) | documents
//   limit      1..200, default 30
//   offset     for paging
//
// Results are *parts* by default, because a passage is the useful answer and it has its own URL.
// `group=documents` folds the current page of passages up to the documents they came from.
import type { Db, SqlValue } from '../engine/db.js';
import { toMatchExpression, type DocumentType } from './documents.js';
import { tokenize } from './similarity.js';

export type Sort = 'relevance' | 'newest' | 'oldest';
export type Grouping = 'parts' | 'documents';
export type TermMode = 'all' | 'any';

export interface Query {
  q: string;
  /**
   * A raw FTS5 expression, used exactly as given.
   *
   * `q` guesses: it compiles bare words and passes anything that looks like FTS5 syntax through. The
   * guess is convenient for a person and wrong for a program, which needs to know that what it wrote
   * is what runs. Hence this — no heuristic, no rewriting, and a syntax error is reported rather than
   * swallowed into an empty result.
   */
  match: string;
  /** Arbitrary text to find passages *like*. See likeExpression(). */
  like: string;
  tags: string[];
  categories: string[];
  types: DocumentType[];
  kinds: string[];
  collection: string;
  termMode: TermMode;
  sort: Sort;
  group: Grouping;
  limit: number;
  offset: number;
}

export const EMPTY_QUERY: Query = {
  q: '',
  match: '',
  like: '',
  tags: [],
  categories: [],
  types: [],
  kinds: [],
  collection: '',
  termMode: 'all',
  // 'newest', not 'relevance': with no `q` there is nothing to rank against, and parseQuery would
  // never return relevance for an empty query. Anything else here makes EMPTY_QUERY serialize to a
  // non-empty string, so the "clear all" link would carry a redundant sort.
  sort: 'newest',
  group: 'parts',
  limit: 30,
  offset: 0,
};

const DOCUMENT_TYPES = new Set<string>(['post', 'page', 'section', 'chapter', 'book', 'rule']);

/**
 * Read a parameter that may appear several times, or once comma-separated, or both. Accepting all
 * three is deliberate: `?tag=a&tag=b` is what a form produces, `?tag=a,b` is what a person types.
 */
function multi(params: URLSearchParams, name: string): string[] {
  const values = params
    .getAll(name)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(values)];
}

/**
 * A bounded integer parameter, or the fallback.
 *
 * The absent case has to be checked before coercing, because `Number(null)` is `0` — finite, and
 * therefore indistinguishable from a real zero by a `Number.isFinite` guard. Left unhandled, a URL
 * with no `limit` clamped to the *minimum* instead of the default, and every query page returned a
 * single result.
 */
function bounded(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Never throws. A hand-edited URL is user input; a nonsense value falls back to the default. */
export function parseQuery(params: URLSearchParams): Query {
  const q = (params.get('q') ?? '').trim();
  const match = (params.get('match') ?? '').trim().slice(0, 1000);
  // Capped: this arrives in a URL, and a whole document pasted in would be neither a useful query
  // nor a reasonable thing to put in an address bar. The opening paragraphs carry the idea.
  const like = (params.get('like') ?? '').trim().slice(0, 2000);
  const sortRaw = params.get('sort');
  const sort: Sort =
    sortRaw === 'newest' || sortRaw === 'oldest'
      ? sortRaw
      : // Relevance is meaningless without something full-text to rank against.
        q || match || like
        ? 'relevance'
        : 'newest';

  return {
    q,
    match,
    like,
    tags: multi(params, 'tag'),
    categories: multi(params, 'category'),
    types: multi(params, 'type').filter((t): t is DocumentType => DOCUMENT_TYPES.has(t)),
    kinds: multi(params, 'kind'),
    collection: (params.get('collection') ?? '').trim().toLowerCase(),
    termMode: params.get('terms') === 'any' ? 'any' : 'all',
    sort,
    group: params.get('group') === 'documents' ? 'documents' : 'parts',
    limit: bounded(params.get('limit'), 30, 1, 200),
    offset: bounded(params.get('offset'), 0, 0, 100_000),
  };
}

/** Serialize back to parameters, omitting anything at its default so URLs stay legible. */
export function queryToParams(query: Query): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.match) params.set('match', query.match);
  if (query.like) params.set('like', query.like);
  for (const tag of query.tags) params.append('tag', tag);
  for (const category of query.categories) params.append('category', category);
  for (const type of query.types) params.append('type', type);
  for (const kind of query.kinds) params.append('kind', kind);
  if (query.collection) params.set('collection', query.collection);
  if (query.termMode !== 'all') params.set('terms', query.termMode);
  // Relevance is the implied default when q is present, newest when it is not.
  const impliedSort: Sort = query.q || query.match || query.like ? 'relevance' : 'newest';
  if (query.sort !== impliedSort) params.set('sort', query.sort);
  if (query.group !== 'parts') params.set('group', query.group);
  if (query.limit !== 30) params.set('limit', String(query.limit));
  if (query.offset) params.set('offset', String(query.offset));
  return params;
}

export const queryToString = (query: Query): string => queryToParams(query).toString();

/** True when nothing was asked for — the caller should show the index, not an empty result set. */
export function isEmptyQuery(query: Query): boolean {
  return (
    !query.q &&
    !query.match &&
    !query.like &&
    !query.tags.length &&
    !query.categories.length &&
    !query.types.length &&
    !query.kinds.length &&
    !query.collection
  );
}

/** Add or remove one value of a repeatable parameter, and reset paging. Used for facet links. */
export function toggleTerm(
  query: Query,
  field: 'tags' | 'categories' | 'kinds' | 'types',
  value: string,
): Query {
  const current = query[field] as string[];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  return { ...query, [field]: next, offset: 0 } as Query;
}

// ── SQL assembly ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn pasted text into an FTS5 expression: "find passages like this".
 *
 * The trick is that **bm25 already weights by inverse document frequency**, so there is no need to
 * compute idf here and no need to hold the corpus in memory. Strip the stop words, keep the most
 * repeated content words, OR them together, and let the engine's own ranking decide which passages
 * are closest. Stemming does the morphology.
 *
 * Terms are quoted, which also makes this safe against text that happens to contain FTS5 syntax —
 * pasted prose is full of hyphens, colons and asterisks that would otherwise be read as operators.
 *
 * Returns the terms as well as the expression, because showing *why* something matched is most of
 * what makes a result trustworthy.
 */
export function likeExpression(text: string, maxTerms = 16): { expression: string; terms: string[] } {
  const counts = new Map<string, number>();
  for (const word of tokenize(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
  if (!counts.size) return { expression: '', terms: [] };

  const terms = [...counts.entries()]
    // Frequency within the pasted text is the only signal available here; bm25 supplies the rest.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([word]) => word);

  return { expression: terms.map((word) => `"${word}"`).join(' OR '), terms };
}

/** One WHERE clause and the parameters it needs. */
interface Clause {
  from: string;
  where: string;
  params: SqlValue[];
}

/** The whole FROM/WHERE shared by results, count and facets. */
interface Fragment extends Clause {
  /** Content words derived from `like`, for showing why a result matched. */
  terms: string[];
  /** The composed FTS5 expression, or undefined when the query is not full-text at all. */
  match?: string;
}

const placeholders = (values: readonly unknown[]): string => values.map(() => '?').join(', ');

/**
 * Documents carrying the given terms of one kind.
 *
 * `all` needs the GROUP BY … HAVING count trick: a row can only match one term at a time, so
 * intersecting several means counting how many distinct ones a document matched.
 */
function termFilter(kind: 'tag' | 'category', slugs: string[], mode: TermMode): Clause | null {
  if (!slugs.length) return null;
  const base = `SELECT dt.document_id
                  FROM document_terms dt JOIN terms t ON t.id = dt.term_id
                 WHERE t.kind = ? AND t.slug IN (${placeholders(slugs)})`;
  if (mode === 'any') {
    return { from: '', where: `d.id IN (${base})`, params: [kind, ...slugs] };
  }
  return {
    from: '',
    where: `d.id IN (${base} GROUP BY dt.document_id HAVING count(DISTINCT t.slug) = ?)`,
    params: [kind, ...slugs, slugs.length],
  };
}

/**
 * The FROM and WHERE shared by results, count and facets — built once so the four queries cannot
 * drift apart and start describing different result sets.
 */
function buildFragment(query: Query): Fragment {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  // The MATCH clause has to come first: parameters are positional, and every other clause is
  // appended after it.
  const like = query.like ? likeExpression(query.like) : { expression: '', terms: [] };
  // Either source of a full-text expression puts the FTS table in the query. With both, they are
  // AND-ed: the words you insisted on, among the passages that look like what you pasted.
  const expressions = [
    ...(query.q ? [toMatchExpression(query.q)] : []),
    // Verbatim. If it is malformed that is worth saying out loud, which runQuery does.
    ...(query.match ? [query.match] : []),
    ...(like.expression ? [`(${like.expression})`] : []),
  ];
  const match = expressions.length > 1 ? expressions.map((e) => `(${e})`).join(' AND ') : expressions[0];

  const from = match
    ? `FROM parts_fts
         JOIN parts p     ON p.id = parts_fts.rowid
         JOIN documents d ON d.id = p.document_id`
    : `FROM parts p JOIN documents d ON d.id = p.document_id`;
  if (match) {
    clauses.push('parts_fts MATCH ?');
    params.push(match);
  }

  clauses.push(`d.status = 'published'`, `d.visibility = 'public'`);

  if (query.kinds.length) {
    clauses.push(`p.kind IN (${placeholders(query.kinds)})`);
    params.push(...query.kinds);
    // An explicit kind=sealed would otherwise be honoured; sealed parts hold no readable text.
    clauses.push(`p.kind IS NOT 'sealed'`);
  } else {
    clauses.push(`p.kind IS NOT 'sealed'`);
  }

  if (query.types.length) {
    clauses.push(`d.type IN (${placeholders(query.types)})`);
    params.push(...query.types);
  }

  if (query.collection) {
    clauses.push(`d.collection_id IN (SELECT id FROM collections WHERE slug = ?)`);
    params.push(query.collection);
  }

  for (const filter of [
    termFilter('tag', query.tags, query.termMode),
    termFilter('category', query.categories, query.termMode),
  ]) {
    if (!filter) continue;
    clauses.push(filter.where);
    params.push(...filter.params);
  }

  return { from, where: clauses.join('\n   AND '), params, terms: like.terms, match };
}

function orderBy(query: Query, isFullText: boolean): string {
  if (query.sort === 'relevance' && isFullText) return 'bm25(parts_fts), d.created DESC';
  if (query.sort === 'oldest') return 'd.created ASC, d.id, p.ordinal';
  return 'd.created DESC, d.id DESC, p.ordinal';
}

// ── results ──────────────────────────────────────────────────────────────────────────────────

export interface QueryPart {
  part_id: number;
  anchor: string;
  kind: string;
  document_id: number;
  text: string;
  slug: string;
  title: string;
  number: string;
  type: string;
  created: string;
  /** FTS5 snippet with matches in «», or a plain clip when there is no full-text expression. */
  snippet: string;
  rank: number;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
}

export interface QueryResult {
  query: Query;
  parts: QueryPart[];
  /** Total matching parts, ignoring limit and offset. */
  total: number;
  /** Content words derived from `like`, so a result can show why it matched. */
  terms: string[];
  /**
   * The engine's complaint, when the expression was malformed.
   *
   * An empty result set and a syntax error look identical to a caller, which is how a broken query
   * compiler shipped unnoticed. A half-typed query still returns no rows rather than throwing — but
   * it now says why.
   */
  error?: string;
  facets: {
    tags: FacetValue[];
    categories: FacetValue[];
    kinds: FacetValue[];
    types: FacetValue[];
  };
}

/** Facet counts over the matching set, so a filter that would return nothing is not offered. */
async function termFacets(
  db: Db,
  fragment: Fragment,
  kind: 'tag' | 'category',
): Promise<FacetValue[]> {
  return db.query<FacetValue>(
    `SELECT t.slug AS value, t.name AS label, count(DISTINCT d.id) AS count
       ${fragment.from}
       JOIN document_terms dtf ON dtf.document_id = d.id
       JOIN terms t            ON t.id = dtf.term_id AND t.kind = ?
      WHERE ${fragment.where}
      GROUP BY t.id
      ORDER BY count DESC, t.name
      LIMIT 24`,
    [kind, ...fragment.params],
  );
}

/**
 * Run a query. Four statements: the page of results, the total, and two facet passes — all built
 * from one shared FROM/WHERE so they cannot describe different result sets.
 */
export async function runQuery(db: Db, query: Query): Promise<QueryResult> {
  const fragment = buildFragment(query);

  // snippet() and bm25() are only available when an FTS5 table is in the query.
  const isFullText = Boolean(fragment.match);
  const snippet = isFullText
    ? `snippet(parts_fts, 0, '«', '»', '…', 22)`
    : `substr(p.text, 1, 240)`;
  const rank = isFullText ? `bm25(parts_fts)` : `0`;

  let parts: QueryPart[] = [];
  let total = 0;
  try {
    parts = await db.query<QueryPart>(
      `SELECT p.id AS part_id, p.anchor, p.kind, p.document_id, p.text,
              d.slug, d.title, d.number, d.type, d.created,
              ${snippet} AS snippet, ${rank} AS rank
         ${fragment.from}
        WHERE ${fragment.where}
        ORDER BY ${orderBy(query, isFullText)}
        LIMIT ? OFFSET ?`,
      [...fragment.params, query.limit, query.offset],
    );
    total =
      Number(
        await db.scalar(`SELECT count(*) ${fragment.from} WHERE ${fragment.where}`, fragment.params),
      ) || 0;
  } catch (err) {
    // A malformed FTS5 expression — easily produced mid-typing, or by hand in `match` — must not
    // take the page down. It must also not masquerade as "nothing found".
    return {
      query,
      parts: [],
      total: 0,
      terms: fragment.terms,
      error: err instanceof Error ? err.message : String(err),
      facets: { tags: [], categories: [], kinds: [], types: [] },
    };
  }

  const kinds = await db.query<FacetValue>(
    `SELECT p.kind AS value, p.kind AS label, count(*) AS count
       ${fragment.from}
      WHERE ${fragment.where}
      GROUP BY p.kind
      ORDER BY count DESC, p.kind`,
    fragment.params,
  );
  const types = await db.query<FacetValue>(
    `SELECT d.type AS value, d.type AS label, count(DISTINCT d.id) AS count
       ${fragment.from}
      WHERE ${fragment.where}
      GROUP BY d.type
      ORDER BY count DESC, d.type`,
    fragment.params,
  );

  return {
    query,
    parts,
    total,
    terms: fragment.terms,
    facets: {
      tags: await termFacets(db, fragment, 'tag'),
      categories: await termFacets(db, fragment, 'category'),
      kinds,
      types,
    },
  };
}

export interface GroupedDocument {
  document_id: number;
  slug: string;
  title: string;
  number: string;
  type: string;
  created: string;
  passages: QueryPart[];
}

/**
 * Fold a page of passages up to the documents they came from, keeping the order they arrived in —
 * which is the ranking. Deliberately operates on the page rather than the whole result set: it is a
 * different *view* of these results, not a different query.
 */
export function groupByDocument(parts: readonly QueryPart[]): GroupedDocument[] {
  const order: number[] = [];
  const byId = new Map<number, GroupedDocument>();
  for (const part of parts) {
    let group = byId.get(part.document_id);
    if (!group) {
      group = {
        document_id: part.document_id,
        slug: part.slug,
        title: part.title,
        number: part.number,
        type: part.type,
        created: part.created,
        passages: [],
      };
      byId.set(part.document_id, group);
      order.push(part.document_id);
    }
    group.passages.push(part);
  }
  return order.map((id) => byId.get(id)!);
}
