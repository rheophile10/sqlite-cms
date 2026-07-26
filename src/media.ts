// The media library. Image bytes are a BLOB column, so an <img> on a rendered page is served
// out of SQLite by exactly the same machinery that served the HTML around it — the request goes
// to the Service Worker (or a blob: URL at file://), the answer comes from a SELECT.
//
// This is where demand paging stops being a talking point. A BLOB lives in overflow pages that
// SQLite only reads when the column is actually selected, so listing the library reads the row
// headers and none of the image data. `listMedia` deliberately never selects `bytes`.
import type { Db } from './db.js';
import { newId, slugify } from './content.js';

export interface MediaRow {
  id: number;
  slug: string;
  mime: string;
  size: number;
  created: string;
}

export interface MediaBlob {
  mime: string;
  bytes: Uint8Array;
}

/** Strip the extension before slugifying, then put it back — `My Pic.PNG` → `my-pic.png`. */
function mediaSlug(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return slugify(filename);
  const stem = slugify(filename.slice(0, dot));
  const ext = filename.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext ? `${stem}.${ext}` : stem;
}

async function uniqueMediaSlug(db: Db, desired: string): Promise<string> {
  const dot = desired.lastIndexOf('.');
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
    const clash = await db.scalar(`SELECT count(*) FROM media WHERE slug = ?`, [candidate]);
    if (!Number(clash)) return candidate;
  }
}

export async function addMedia(
  db: Db,
  filename: string,
  mime: string,
  bytes: Uint8Array,
): Promise<MediaRow> {
  const id = newId();
  const slug = await uniqueMediaSlug(db, mediaSlug(filename));
  await db.query(
    `INSERT INTO media (id, slug, mime, bytes, size, created)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [id, slug, mime, bytes, bytes.byteLength],
  );
  const row = await getMediaRow(db, id);
  if (!row) throw new Error('media insert did not land');
  return row;
}

export async function addMediaFile(db: Db, file: File): Promise<MediaRow> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return addMedia(db, file.name, file.type || 'application/octet-stream', bytes);
}

export async function getMediaRow(db: Db, id: number): Promise<MediaRow | undefined> {
  return (
    await db.query<MediaRow>(`SELECT id, slug, mime, size, created FROM media WHERE id = ?`, [id])
  )[0];
}

/** Fetch the actual bytes. The only query in this file that touches the BLOB column. */
export async function getMediaBySlug(db: Db, slug: string): Promise<MediaBlob | undefined> {
  const row = (
    await db.query<{ mime: string; bytes: Uint8Array | null }>(
      `SELECT mime, bytes FROM media WHERE slug = ?`,
      [slug],
    )
  )[0];
  if (!row?.bytes) return undefined;
  return { mime: row.mime, bytes: row.bytes };
}

/** Library listing. Never selects `bytes` — see the note at the top of this file. */
export async function listMedia(db: Db, limit = 200): Promise<MediaRow[]> {
  return db.query<MediaRow>(
    `SELECT id, slug, mime, size, created FROM media ORDER BY created DESC, id DESC LIMIT ?`,
    [limit],
  );
}

export async function deleteMedia(db: Db, id: number): Promise<void> {
  await db.query(`DELETE FROM media WHERE id = ?`, [id]);
}

export async function countMedia(db: Db): Promise<{ items: number; bytes: number }> {
  const row = (
    await db.query<{ items: number; bytes: number }>(
      `SELECT count(*) AS items, coalesce(sum(size), 0) AS bytes FROM media`,
    )
  )[0];
  return { items: Number(row?.items ?? 0), bytes: Number(row?.bytes ?? 0) };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
