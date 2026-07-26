/// <reference types="@vlcn.io/wa-sqlite" />

// @vlcn.io/wa-sqlite ships ambient declarations for the package root, the wasm factories
// and several example VFSs — but not for IDBBatchAtomicVFS, the one we actually use.
declare module '@vlcn.io/wa-sqlite/src/examples/IDBBatchAtomicVFS.js' {
  export interface IDBBatchAtomicVFSOptions {
    /** IndexedDB transaction durability. 'relaxed' is fastest and the wa-sqlite default. */
    durability?: 'default' | 'strict' | 'relaxed';
    /** When to drop superseded page versions. */
    purge?: 'deferred' | 'manual';
    purgeAtLeast?: number;
  }

  /**
   * Typed as a constructor yielding SQLiteVFS rather than `class ... extends VFS.Base`,
   * because vlcn's own declarations are internally inconsistent: `VFS.Base.xRead` takes a
   * `{size, value}` wrapper while `SQLiteVFS.xRead` takes a bare Uint8Array, so a class
   * extending Base is not assignable to the interface its own vfs_register() demands.
   * Describing the constructor directly keeps the call site honest and cast-free.
   */
  export const IDBBatchAtomicVFS: new (
    idbDatabaseName?: string,
    options?: IDBBatchAtomicVFSOptions,
  ) => SQLiteVFS & { name: string; close(): Promise<void> };
}
