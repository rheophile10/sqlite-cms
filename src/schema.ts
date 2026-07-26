// WordPress's content model, rewritten for SQLite-in-the-browser.
//
// Everything the site is made of lives in here — not just the posts. The theme templates are
// rows in `templates`, the CSS is a row in `templates`, and the images are BLOBs in `media`.
// A rendered page is therefore a pure function of this database, which is what makes
// "the HTML is served out of SQLite" literally true rather than a figure of speech.
//
// Three constraints shape the DDL, all inherited from the reference implementation:
//
//  1. cr-sqlite rejects a NOT NULL column with no DEFAULT (it would break forwards/backwards
//     schema compatibility between replicas), and requires a non-nullable primary key. So
//     every column carries a DEFAULT even where the app always supplies a value.
//  2. An FTS5 table cannot itself be a CRR, so `posts_fts` is a *derived local artifact*:
//     `posts` is what would replicate, and triggers maintain the index on top. Those triggers
//     fire for merged-in rows too, so the index stays correct without a rebuild.
//  3. No autoincrement ids — two replicas offline both picking max(id)+1 collide on merge.
//     See newId() in content.ts.
import type { Db } from './db.js';

export const SCHEMA = /* sql */ `
-- Posts and pages are one table distinguished by a type column, exactly as wp_posts does it.
CREATE TABLE IF NOT EXISTS posts (
  id       INTEGER PRIMARY KEY NOT NULL,
  type     TEXT    NOT NULL DEFAULT 'post',      -- 'post' | 'page'
  slug     TEXT    NOT NULL DEFAULT '',
  title    TEXT    NOT NULL DEFAULT '',
  body     TEXT    NOT NULL DEFAULT '',          -- HTML, may contain <script>
  excerpt  TEXT    NOT NULL DEFAULT '',
  status   TEXT    NOT NULL DEFAULT 'draft',     -- 'draft' | 'published'
  created  TEXT    NOT NULL DEFAULT '',
  updated  TEXT    NOT NULL DEFAULT ''
);

-- A slug identifies a document within its type: /hello-world/ and a page of the same name
-- are different rows. Partial-free unique index so drafts collide too (WordPress behaviour).
CREATE UNIQUE INDEX IF NOT EXISTS posts_slug ON posts(type, slug);
CREATE INDEX IF NOT EXISTS posts_listing ON posts(type, status, created DESC);
-- Resolving a permalink knows the slug but not the type, so it cannot use posts_slug above
-- (whose leading column is type). Without this index, every page view full-scans posts —
-- which on a demand-paged database means reading essentially the whole file.
CREATE INDEX IF NOT EXISTS posts_by_slug ON posts(slug, status);

-- Categories and tags are one table distinguished by a kind column, as wp_terms + taxonomy does.
CREATE TABLE IF NOT EXISTS terms (
  id   INTEGER PRIMARY KEY NOT NULL,
  kind TEXT    NOT NULL DEFAULT 'category',      -- 'category' | 'tag'
  slug TEXT    NOT NULL DEFAULT '',
  name TEXT    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS terms_slug ON terms(kind, slug);

CREATE TABLE IF NOT EXISTS post_terms (
  post_id INTEGER NOT NULL DEFAULT 0,
  term_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, term_id)
);
CREATE INDEX IF NOT EXISTS post_terms_by_term ON post_terms(term_id);

-- The media library. Bytes live in the database, so an <img> is served from SQLite the same
-- way the surrounding HTML is — same transport, different MIME type.
--
-- The bytes column is declared LAST, and that is load-bearing rather than stylistic. SQLite
-- stores a row's columns in declaration order, and a large BLOB spills into an overflow page
-- chain. To read a column positioned *after* the BLOB, the pager has to walk that whole chain
-- to get to it. With bytes in the middle, "SELECT size, created FROM media" cost 302 pages of
-- a 327-page database; with it last, the same query costs 1. See test/engine.test.mjs.
CREATE TABLE IF NOT EXISTS media (
  id      INTEGER PRIMARY KEY NOT NULL,
  slug    TEXT    NOT NULL DEFAULT '',
  mime    TEXT    NOT NULL DEFAULT 'application/octet-stream',
  size    INTEGER NOT NULL DEFAULT 0,
  created TEXT    NOT NULL DEFAULT '',
  bytes   BLOB
);
CREATE UNIQUE INDEX IF NOT EXISTS media_slug ON media(slug);

-- The theme. Templates are rows, so editing the theme is editing the database.
CREATE TABLE IF NOT EXISTS templates (
  name TEXT PRIMARY KEY NOT NULL,
  body TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL DEFAULT ''
);

-- External-content FTS5: the index stores terms, the rows stay in the posts table.
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts
  USING fts5(title, body, content='posts', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO posts_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
`;

export async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA);
}

/** Rebuild the FTS index from `posts`. Only needed if the index is ever suspected stale. */
export async function reindex(db: Db): Promise<void> {
  await db.exec(`INSERT INTO posts_fts(posts_fts) VALUES('rebuild')`);
}

/** Pages currently in the database file, and the page size — proof it is paged, not slurped. */
export async function pageStats(db: Db): Promise<{ pages: number; pageSize: number }> {
  return {
    pages: Number(await db.scalar(`PRAGMA page_count`)) || 0,
    pageSize: Number(await db.scalar(`PRAGMA page_size`)) || 0,
  };
}
