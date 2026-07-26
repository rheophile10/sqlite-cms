// Posts and pages: CRUD, slugs, and FTS5 search. Every read goes through the demand-paged
// VFS, so rendering one post faults in that post's pages and nothing else — the media library
// can be enormous without slowing a page view down.
import type { Db } from './db.js';

export type PostType = 'post' | 'page';
export type PostStatus = 'draft' | 'published';

export interface Post {
  id: number;
  type: PostType;
  slug: string;
  title: string;
  body: string;
  excerpt: string;
  status: PostStatus;
  created: string;
  updated: string;
}

export interface SearchHit {
  id: number;
  type: PostType;
  slug: string;
  title: string;
  status: PostStatus;
  created: string;
  /** FTS5 snippet over the body with matches wrapped in «». */
  snippet: string;
  /** bm25 relevance; more negative is a better match. */
  rank: number;
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
    .replace(/[\u0300-\u036f]/g, '') // strip the combining accents NFKD just split out
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, ''); // slice may have left a trailing dash
  return slug || 'untitled';
}

/**
 * Resolve a slug that does not collide within its type, appending -2, -3, … as WordPress
 * does. `exceptId` lets a post keep its own slug when being updated.
 */
export async function uniqueSlug(
  db: Db,
  type: PostType,
  desired: string,
  exceptId?: number,
): Promise<string> {
  const base = slugify(desired);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const clash = await db.scalar(
      `SELECT count(*) FROM posts WHERE type = ? AND slug = ? AND id IS NOT ?`,
      [type, candidate, exceptId ?? null],
    );
    if (!Number(clash)) return candidate;
  }
}

export interface NewPost {
  type?: PostType;
  title: string;
  body?: string;
  excerpt?: string;
  status?: PostStatus;
  slug?: string;
}

export async function createPost(db: Db, input: NewPost): Promise<number> {
  const id = newId();
  const type = input.type ?? 'post';
  const slug = await uniqueSlug(db, type, input.slug || input.title);
  await db.query(
    `INSERT INTO posts (id, type, slug, title, body, excerpt, status, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      type,
      slug,
      input.title,
      input.body ?? '',
      input.excerpt ?? '',
      input.status ?? 'draft',
    ],
  );
  return id;
}

export interface PostEdits {
  title?: string;
  body?: string;
  excerpt?: string;
  status?: PostStatus;
  slug?: string;
}

/** Patch only the supplied fields. Re-slugs (uniquely) if `slug` is given. */
export async function updatePost(db: Db, id: number, edits: PostEdits): Promise<void> {
  const existing = await getPost(db, id);
  if (!existing) throw new Error(`no post ${id}`);

  const slug =
    edits.slug === undefined
      ? existing.slug
      : await uniqueSlug(db, existing.type, edits.slug, id);

  await db.query(
    `UPDATE posts
        SET title = ?, body = ?, excerpt = ?, status = ?, slug = ?, updated = datetime('now')
      WHERE id = ?`,
    [
      edits.title ?? existing.title,
      edits.body ?? existing.body,
      edits.excerpt ?? existing.excerpt,
      edits.status ?? existing.status,
      slug,
      id,
    ],
  );
}

export async function deletePost(db: Db, id: number): Promise<void> {
  await db.query(`DELETE FROM post_terms WHERE post_id = ?`, [id]);
  await db.query(`DELETE FROM posts WHERE id = ?`, [id]);
}

const COLUMNS = `id, type, slug, title, body, excerpt, status, created, updated`;

export async function getPost(db: Db, id: number): Promise<Post | undefined> {
  return (await db.query<Post>(`SELECT ${COLUMNS} FROM posts WHERE id = ?`, [id]))[0];
}

export async function getPostBySlug(
  db: Db,
  type: PostType,
  slug: string,
): Promise<Post | undefined> {
  return (
    await db.query<Post>(`SELECT ${COLUMNS} FROM posts WHERE type = ? AND slug = ?`, [type, slug])
  )[0];
}

/**
 * Resolve a permalink slug without knowing whether it is a post or a page — which is what a
 * request for `/about/` actually gives us. Posts win a tie; they are the common case.
 */
export async function getPublishedBySlug(db: Db, slug: string): Promise<Post | undefined> {
  return (
    await db.query<Post>(
      `SELECT ${COLUMNS} FROM posts
        WHERE slug = ? AND status = 'published'
        ORDER BY CASE type WHEN 'post' THEN 0 ELSE 1 END
        LIMIT 1`,
      [slug],
    )
  )[0];
}

export interface ListOptions {
  type?: PostType;
  status?: PostStatus;
  limit?: number;
}

export async function listPosts(db: Db, options: ListOptions = {}): Promise<Post[]> {
  const { type, status, limit = 200 } = options;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  params.push(limit);
  return db.query<Post>(
    `SELECT ${COLUMNS} FROM posts
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created DESC, id DESC
      LIMIT ?`,
    params,
  );
}

/** Published posts carrying a given term, newest first — the archive view. */
export async function listPostsByTerm(db: Db, termId: number, limit = 200): Promise<Post[]> {
  return db.query<Post>(
    `SELECT ${COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')}
       FROM posts p JOIN post_terms pt ON pt.post_id = p.id
      WHERE pt.term_id = ? AND p.status = 'published'
      ORDER BY p.created DESC, p.id DESC
      LIMIT ?`,
    [termId, limit],
  );
}

export async function countPosts(db: Db, options: ListOptions = {}): Promise<number> {
  const { type, status } = options;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  return (
    Number(
      await db.scalar(
        `SELECT count(*) FROM posts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
        params,
      ),
    ) || 0
  );
}

/** FTS5 operators, which must reach the engine verbatim rather than being quoted as terms. */
const FTS5_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * Make typing feel live: bare words become prefix terms (`sqlite` → `"sqlite"*`). Anything
 * that looks like real FTS5 syntax — quotes, parens, `*`, `-`, `:`, or a bare operator
 * keyword — is passed through untouched so the query language stays available.
 */
function toMatchExpression(query: string): string {
  const tokens = query.split(/\s+/);
  const isPlainWords = /^[\w\s]+$/.test(query) && !tokens.some((t) => FTS5_OPERATORS.has(t));
  return isPlainWords ? tokens.map((word) => `"${word}"*`).join(' ') : query;
}

/**
 * Full-text search over titles and bodies, ranked by bm25. Restricted to published rows: this
 * backs the site's own search page, not the admin list.
 */
export async function searchPosts(db: Db, query: string, limit = 20): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    return await db.query<SearchHit>(
      `SELECT p.id, p.type, p.slug, p.title, p.status, p.created,
              snippet(posts_fts, 1, '«', '»', '…', 18) AS snippet,
              bm25(posts_fts) AS rank
         FROM posts_fts JOIN posts p ON p.id = posts_fts.rowid
        WHERE posts_fts MATCH ? AND p.status = 'published'
        ORDER BY rank
        LIMIT ?`,
      [toMatchExpression(trimmed), limit],
    );
  } catch {
    return []; // malformed FTS5 expression while mid-typing
  }
}
