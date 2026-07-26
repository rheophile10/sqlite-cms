// The engine seam, copied from browser-sqlite/wa-sqlite-idb-demo (the reference
// implementation) as its README instructs. One SQLite build (cr-sqlite: FTS5 + CRDT compiled
// in), opened through IDBBatchAtomicVFS so the pager's block reads/writes land in IndexedDB
// one page at a time — demand-paged, exactly like a file on disk. Nothing here loads a whole
// database into RAM, which is the entire point: a CMS whose media library is 200 MB of images
// still boots in milliseconds, because rendering one post touches only that post's pages.
import * as SQLite from '@vlcn.io/wa-sqlite';
import SQLiteFactory from '@vlcn.io/wa-sqlite/dist/crsqlite.mjs';
import { IDBBatchAtomicVFS } from '@vlcn.io/wa-sqlite/src/examples/IDBBatchAtomicVFS.js';
import { WASM_B64 } from './wasm.js';

export type SqlValue = number | string | Uint8Array | bigint | null;
export type Row = Record<string, SqlValue>;

export interface Db {
  /**
   * Rows from a single statement, keyed by column name. `T` is an unchecked assertion about
   * the shape the SQL returns — it is not constrained to Row, so plain domain interfaces
   * (which have no index signature) can be used directly.
   */
  query<T extends object = Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  /** Run one or more statements for effect. No parameters — use query() for those. */
  exec(sql: string): Promise<void>;
  /** First column of the first row, or null. */
  scalar(sql: string, params?: readonly SqlValue[]): Promise<SqlValue>;
  close(): Promise<void>;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

let apiPromise: Promise<SQLiteAPI> | undefined;

/** Instantiate the wasm once per page; the inlined binary means zero fetches. */
function sqliteApi(): Promise<SQLiteAPI> {
  apiPromise ??= (async () => {
    const module = await SQLiteFactory({ wasmBinary: decodeBase64(WASM_B64) });
    return SQLite.Factory(module);
  })();
  return apiPromise;
}

const registered = new Set<string>();

export interface OpenOptions {
  /** IndexedDB database name that holds the pages. Also the registered VFS name. */
  idbName: string;
  /** The database "filename" inside that VFS. */
  file?: string;
  /**
   * SQLite journal mode. DELETE (SQLite's own default) is fine here; MEMORY trades
   * crash-durability for noticeably less IndexedDB write traffic, since a rollback journal
   * otherwise becomes its own set of IndexedDB blocks on every transaction.
   */
  journalMode?: 'MEMORY' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'OFF';
}

export async function openDatabase({
  idbName,
  file = 'cms.db',
  journalMode = 'DELETE',
}: OpenOptions): Promise<Db> {
  const sqlite3 = await sqliteApi();

  // One VFS per IndexedDB name, registered once. Not made default: naming it explicitly at
  // open time is what lets one page hold several independent sites at once.
  if (!registered.has(idbName)) {
    sqlite3.vfs_register(new IDBBatchAtomicVFS(idbName), false);
    registered.add(idbName);
  }

  const handle = await sqlite3.open_v2(
    file,
    SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE,
    idbName,
  );

  async function runQuery<T extends object = Row>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T[]> {
    const rows: T[] = [];
    for await (const stmt of sqlite3.statements(handle, sql)) {
      if (params.length) sqlite3.bind_collection(stmt, params as SQLiteCompatibleType[]);
      const columns = sqlite3.column_names(stmt);
      while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
        const row: Row = {};
        columns.forEach((name, i) => (row[name] = sqlite3.column(stmt, i) as SqlValue));
        rows.push(row as T);
      }
    }
    return rows;
  }

  // A connection is one Asyncify state machine: it cannot execute two statements at once.
  // Overlapping them (a Promise.all, or a debounced search landing mid-refresh) interleaves
  // await points inside step(), which desynchronizes SQLite's pager — it starts taking
  // duplicate read locks, then fails a hot-journal check against a journal that is not there
  // and aborts the wasm outright. So every statement goes through one queue. Callers can be
  // as concurrent as they like; the database sees a strict sequence.
  //
  // This matters more here than in the reference demo: a rendered page fires one request per
  // <img>, and the Service Worker answers them all by querying this same connection. Without
  // the queue, a post with three images reliably aborts the wasm.
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  await serialize(() => runQuery(`PRAGMA journal_mode = ${journalMode}`));

  return {
    query: (sql, params) => serialize(() => runQuery(sql, params)),
    exec: (sql) => serialize(async () => void (await runQuery(sql))),
    scalar: (sql, params) =>
      serialize(async () => {
        const first = (await runQuery(sql, params))[0];
        return first ? Object.values(first)[0] ?? null : null;
      }),
    close: () =>
      serialize(async () => {
        // Let cr-sqlite drop its temp state; harmless on a db that was never a CRR.
        try {
          await runQuery('SELECT crsql_finalize()');
        } catch {
          /* not a crsql database */
        }
        await sqlite3.close(handle);
      }),
  };
}
