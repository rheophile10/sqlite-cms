// The content model, v2.
//
// v1 was WordPress: a `posts` table whose `body` was a blob of HTML. That is fine for a weblog
// and useless for anything structured. v2 replaces it with three ideas:
//
//   collections  a blog, or a book — the top-level container
//   documents    hierarchical (parent_id + ordinal), so sections and subsections are expressible
//   parts        ordered atomic blocks inside a document: a `kind` naming a widget renderer,
//                a JSON `data` payload for it, and a flattened `text` for search
//
// A document is therefore not a string of HTML but a *sequence of typed things*, which is what
// makes two otherwise unrelated corpora fit the same schema: a blog post is prose parts with the
// occasional callout or video, and a railway rule is a numbered document inside a section
// hierarchy whose parts are clauses and signal diagrams. The renderer does not care which.
//
// Search indexes parts, not documents, so a query can return *the paragraph* and deep-link to it.
// `relations` holds typed edges — including `similar`, computed by TF-IDF cosine in
// similarity.ts — between documents or parts.
//
// Constraints carried over from v1, all still load-bearing:
//
//  1. cr-sqlite rejects a NOT NULL column with no DEFAULT, and needs a non-nullable primary key,
//     so every column carries a DEFAULT. Absent parents are `0` rather than NULL for the same
//     reason, and because `WHERE parent_id = 0` beats juggling `IS NULL` in every query.
//  2. An FTS5 table cannot be a CRR, so the indexes are derived local artifacts maintained by
//     triggers. Those triggers fire for merged-in rows too.
//  3. Ids are random, never autoincrement — two offline replicas would collide on max(id)+1.
//  4. BLOB columns go LAST in their table. SQLite stores columns in declaration order and a large
//     BLOB overflows; reading a column positioned after it walks the whole overflow chain. This
//     cost 302 pages of a 327-page database before `media.bytes` was moved to the end.
import type { Db } from '../engine/db.js';

export const SCHEMA = /* sql */ `
-- A blog, or a book, or a shelf of books. Documents belong to exactly one.
CREATE TABLE IF NOT EXISTS collections (
  id       INTEGER PRIMARY KEY NOT NULL,
  slug     TEXT    NOT NULL DEFAULT '',
  kind     TEXT    NOT NULL DEFAULT 'blog',   -- blog | book | shelf
  title    TEXT    NOT NULL DEFAULT '',
  subtitle TEXT    NOT NULL DEFAULT '',
  ordinal  INTEGER NOT NULL DEFAULT 0,
  created  TEXT    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS collections_slug ON collections(slug);

-- Posts, pages, sections, chapters, rules — one table, distinguished by type, arranged in a
-- tree. parent_id = 0 means top level.
CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY NOT NULL,
  collection_id INTEGER NOT NULL DEFAULT 0,
  parent_id     INTEGER NOT NULL DEFAULT 0,
  ordinal       INTEGER NOT NULL DEFAULT 0,
  type          TEXT    NOT NULL DEFAULT 'post',   -- post | page | section | chapter | rule
  slug          TEXT    NOT NULL DEFAULT '',
  number        TEXT    NOT NULL DEFAULT '',       -- as printed: "71", "71A", "220a"
  title         TEXT    NOT NULL DEFAULT '',
  subtitle      TEXT    NOT NULL DEFAULT '',
  excerpt       TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'draft',  -- draft | published
  visibility    TEXT    NOT NULL DEFAULT 'public', -- public | protected  (see document_keys)
  source_url    TEXT    NOT NULL DEFAULT '',       -- provenance for THIS document
  created       TEXT    NOT NULL DEFAULT '',
  updated       TEXT    NOT NULL DEFAULT ''
);

-- A slug identifies a document within its type: /about/ the page and /about/ the post differ.
CREATE UNIQUE INDEX IF NOT EXISTS documents_slug ON documents(type, slug);
-- Resolving a permalink knows the slug but not the type, so it cannot use the index above
-- (whose leading column is type). Without this, every page view full-scans documents — which on
-- a demand-paged database means reading essentially the whole file. Cost 171 pages vs 21.
CREATE INDEX IF NOT EXISTS documents_by_slug ON documents(slug, status);
-- Leading column matters: the weblog and menu queries filter type+status with no collection, so
-- an index led by collection_id cannot serve them and they full-scan. That cost a page view 339
-- pages of a 415-page database. Two indexes, one per query shape.
CREATE INDEX IF NOT EXISTS documents_listing ON documents(type, status, created DESC);
CREATE INDEX IF NOT EXISTS documents_by_collection ON documents(collection_id, status, ordinal);
-- The hierarchy walk: children of a node, in order.
CREATE INDEX IF NOT EXISTS documents_tree ON documents(parent_id, ordinal);

-- The atomic unit. The kind column names a widget renderer, data is that renderer's JSON
-- payload, and text is the flattened prose the FTS index actually sees.
CREATE TABLE IF NOT EXISTS parts (
  id          INTEGER PRIMARY KEY NOT NULL,
  document_id INTEGER NOT NULL DEFAULT 0,
  parent_id   INTEGER NOT NULL DEFAULT 0,   -- nested parts, e.g. steps inside a tour
  ordinal     INTEGER NOT NULL DEFAULT 0,
  kind        TEXT    NOT NULL DEFAULT 'prose',
  anchor      TEXT    NOT NULL DEFAULT '',  -- stable fragment id, so a part has its own URL
  data        TEXT    NOT NULL DEFAULT '{}',
  text        TEXT    NOT NULL DEFAULT ''
);
-- parent_id is in here, and second, on purpose. Listing a document's top-level parts filters
-- document_id AND parent_id = 0; given only (parent_id, ordinal) the planner picks that index and
-- scans every top-level part in the database, because parent_id = 0 is almost every row. That
-- cost one page view 339 pages of a 417-page database.
CREATE INDEX IF NOT EXISTS parts_document ON parts(document_id, parent_id, ordinal);
CREATE INDEX IF NOT EXISTS parts_tree ON parts(parent_id, ordinal);
CREATE INDEX IF NOT EXISTS parts_kind ON parts(kind);
CREATE UNIQUE INDEX IF NOT EXISTS parts_anchor ON parts(document_id, anchor);

-- Categories and tags: one table distinguished by a kind column, as wp_terms + taxonomy does.
CREATE TABLE IF NOT EXISTS terms (
  id   INTEGER PRIMARY KEY NOT NULL,
  kind TEXT    NOT NULL DEFAULT 'category',   -- category | tag | topic
  slug TEXT    NOT NULL DEFAULT '',
  name TEXT    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS terms_slug ON terms(kind, slug);

CREATE TABLE IF NOT EXISTS document_terms (
  document_id INTEGER NOT NULL DEFAULT 0,
  term_id     INTEGER NOT NULL DEFAULT 0,
  weight      REAL    NOT NULL DEFAULT 1.0,   -- primary vs incidental subject
  PRIMARY KEY (document_id, term_id)
);
CREATE INDEX IF NOT EXISTS document_terms_by_term ON document_terms(term_id);

-- Typed edges. Polymorphic on purpose: the same edge types are wanted between whole documents
-- ("this post supersedes that one") and between individual parts ("this clause restates that
-- clause"). Two tables would duplicate every query and every UI. The cost is no foreign keys,
-- which SQLite would not enforce here anyway — cr-sqlite merges rows without them.
CREATE TABLE IF NOT EXISTS relations (
  id         INTEGER PRIMARY KEY NOT NULL,
  from_scope TEXT    NOT NULL DEFAULT 'document',  -- document | part
  from_id    INTEGER NOT NULL DEFAULT 0,
  to_scope   TEXT    NOT NULL DEFAULT 'document',
  to_id      INTEGER NOT NULL DEFAULT 0,
  type       TEXT    NOT NULL DEFAULT 'similar',
    -- similar | see_also | supersedes | superseded_by | derived_from | cross_reference | amends
  confidence REAL    NOT NULL DEFAULT 0,
  origin     TEXT    NOT NULL DEFAULT 'manual',    -- manual | tfidf | number_match
  note       TEXT    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS relations_edge
  ON relations(from_scope, from_id, to_scope, to_id, type);
CREATE INDEX IF NOT EXISTS relations_from ON relations(from_scope, from_id, type, confidence DESC);
CREATE INDEX IF NOT EXISTS relations_to   ON relations(to_scope, to_id, type);
CREATE INDEX IF NOT EXISTS relations_origin ON relations(origin);

-- ── Per-document encryption ──────────────────────────────────────────────────────────────
-- A protected document's parts are stored sealed (kind = 'sealed'), under a content key of
-- their own. That key is then sealed once per recipient with an X25519 sealed box, so handing
-- somebody a private key lets them read exactly the documents sealed to them and nothing else.
-- Distinct from a whole-vault passcode, which is all-or-nothing.
--
-- The tables live here so the model does not need migrating twice; the crypto that fills them
-- is a later stage. idb-vfs-crypto already supplies the primitives (X25519 sealed box, session
-- identities, exportable keystores).

-- A keyholder we can encrypt *to*. Only ever the public half.
CREATE TABLE IF NOT EXISTS recipients (
  id          INTEGER PRIMARY KEY NOT NULL,
  fingerprint TEXT    NOT NULL DEFAULT '',   -- SHA-256 of the public key, the stable identifier
  name        TEXT    NOT NULL DEFAULT '',
  public_card TEXT    NOT NULL DEFAULT '',   -- the serialized public card from idb-vfs-crypto
  created     TEXT    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS recipients_fingerprint ON recipients(fingerprint);

-- One row per (protected document, recipient): the document's content key, sealed to them.
CREATE TABLE IF NOT EXISTS document_keys (
  document_id INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT    NOT NULL DEFAULT '',
  sealed_key  TEXT    NOT NULL DEFAULT '',   -- base64 sealed box over the content key
  created     TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (document_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS document_keys_by_recipient ON document_keys(fingerprint);

-- The media library. Metadata here; see media.ts for where the bytes live.
CREATE TABLE IF NOT EXISTS media (
  id      INTEGER PRIMARY KEY NOT NULL,
  slug    TEXT    NOT NULL DEFAULT '',
  mime    TEXT    NOT NULL DEFAULT 'application/octet-stream',
  size    INTEGER NOT NULL DEFAULT 0,
  caption TEXT    NOT NULL DEFAULT '',
  created TEXT    NOT NULL DEFAULT '',
  bytes   BLOB
);
CREATE UNIQUE INDEX IF NOT EXISTS media_slug ON media(slug);

-- The theme, including widget renderers (rows named widget:<kind>) and the stylesheet.
CREATE TABLE IF NOT EXISTS templates (
  name TEXT PRIMARY KEY NOT NULL,
  body TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL DEFAULT ''
);

-- Titles are indexed separately from parts so a title match can outrank a body match.
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts
  USING fts5(title, subtitle, number, content='documents', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, subtitle, number)
    VALUES (new.id, new.title, new.subtitle, new.number);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, subtitle, number)
    VALUES ('delete', old.id, old.title, old.subtitle, old.number);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, subtitle, number)
    VALUES ('delete', old.id, old.title, old.subtitle, old.number);
  INSERT INTO documents_fts(rowid, title, subtitle, number)
    VALUES (new.id, new.title, new.subtitle, new.number);
END;

-- The index that makes "return part of an entry" possible.
--
-- A sealed part contributes the empty string, never its text. Two reasons: the application does
-- not hold plaintext for a sealed part in the first place, and an FTS index over content the
-- reader cannot decrypt would leak it — snippet() would happily quote it back. The CASE is
-- repeated identically in all three triggers because FTS5 external-content 'delete' must be
-- given the same value that was indexed, or the index silently corrupts.
CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts
  USING fts5(text, content='parts', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS parts_ai AFTER INSERT ON parts BEGIN
  INSERT INTO parts_fts(rowid, text)
    VALUES (new.id, CASE new.kind WHEN 'sealed' THEN '' ELSE new.text END);
END;
CREATE TRIGGER IF NOT EXISTS parts_ad AFTER DELETE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, text)
    VALUES ('delete', old.id, CASE old.kind WHEN 'sealed' THEN '' ELSE old.text END);
END;
CREATE TRIGGER IF NOT EXISTS parts_au AFTER UPDATE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, text)
    VALUES ('delete', old.id, CASE old.kind WHEN 'sealed' THEN '' ELSE old.text END);
  INSERT INTO parts_fts(rowid, text)
    VALUES (new.id, CASE new.kind WHEN 'sealed' THEN '' ELSE new.text END);
END;
`;

/** Does a table exist? Used by the v1 migration, which must not assume either shape. */
async function hasTable(db: Db, name: string): Promise<boolean> {
  const found = await db.scalar(
    `SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = ?`,
    [name],
  );
  return Number(found) > 0;
}

/**
 * Move a v1 database forward.
 *
 * v1 kept everything in `posts(body TEXT)`. Because the DDL above is all IF NOT EXISTS, an
 * existing v1 database would otherwise gain the new tables and quietly keep its content in a
 * table nothing reads any more — the worst possible outcome, since it looks like data loss and
 * is not. So: copy each post across as a document with a single `html` part holding its body,
 * carry its terms over, then drop the v1 objects.
 *
 * Runs before the v2 DDL needs it and is a no-op on a fresh database.
 */
export async function migrateFromV1(db: Db): Promise<number> {
  if (!(await hasTable(db, 'posts'))) return 0;

  const posts = await db.query<{
    id: number;
    type: string;
    slug: string;
    title: string;
    body: string;
    excerpt: string;
    status: string;
    created: string;
    updated: string;
  }>(`SELECT id, type, slug, title, body, excerpt, status, created, updated FROM posts`);

  for (const post of posts) {
    await db.query(
      `INSERT OR IGNORE INTO documents
         (id, collection_id, parent_id, ordinal, type, slug, title, excerpt, status, created, updated)
       VALUES (?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
      [
        post.id,
        post.type,
        post.slug,
        post.title,
        post.excerpt,
        post.status,
        post.created,
        post.updated,
      ],
    );
    // One opaque part per post: v1 bodies were hand-written HTML, and splitting them
    // heuristically here would be guessing. `html` renders verbatim, so nothing changes visually.
    await db.query(
      `INSERT OR IGNORE INTO parts (id, document_id, parent_id, ordinal, kind, anchor, data, text)
       VALUES (?, ?, 0, 0, 'html', 'body', ?, ?)`,
      [post.id, post.id, JSON.stringify({ html: post.body }), flattenHtml(post.body)],
    );
  }

  if (await hasTable(db, 'post_terms')) {
    await db.exec(
      `INSERT OR IGNORE INTO document_terms (document_id, term_id, weight)
         SELECT post_id, term_id, 1.0 FROM post_terms`,
    );
    await db.exec(`DROP TABLE post_terms`);
  }

  // Drop the v1 index and its triggers before the table they hang off.
  await db.exec(`
    DROP TRIGGER IF EXISTS posts_ai;
    DROP TRIGGER IF EXISTS posts_ad;
    DROP TRIGGER IF EXISTS posts_au;
    DROP TABLE IF EXISTS posts_fts;
    DROP TABLE IF EXISTS posts;
  `);
  return posts.length;
}

/** Strip tags and collapse whitespace — the searchable projection of a chunk of HTML. */
export function flattenHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:#39|apos);/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function migrate(db: Db): Promise<void> {
  // The v1 tables must be read before the v2 DDL runs, but the v2 tables must exist before
  // rows can be copied into them. The DDL is idempotent, so run it, migrate, run it again —
  // the second pass is what creates anything the migration dropped.
  await db.exec(SCHEMA);
  await migrateFromV1(db);
}

/** Rebuild both FTS indexes. Only needed if either is ever suspected stale. */
export async function reindex(db: Db): Promise<void> {
  await db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild')`);
  await db.exec(`INSERT INTO parts_fts(parts_fts) VALUES('rebuild')`);
}

/** Pages currently in the database file, and the page size — proof it is paged, not slurped. */
export async function pageStats(db: Db): Promise<{ pages: number; pageSize: number }> {
  return {
    pages: Number(await db.scalar(`PRAGMA page_count`)) || 0,
    pageSize: Number(await db.scalar(`PRAGMA page_size`)) || 0,
  };
}
