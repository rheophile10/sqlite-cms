// Minimal browser surface so the real VFS can run under Node: IndexedDB, Web Locks, and a
// counter for actual IndexedDB page reads (which is how we prove demand paging).
//
// Caveat: the Web Locks shim grants immediately. Fine here — one connection per database —
// but it does not exercise wa-sqlite's cross-tab locking.
const locks = {
  async request(name, optionsOrCb, maybeCb) {
    const cb = maybeCb ?? optionsOrCb;
    return cb({ name });
  },
  async query() {
    return { held: [], pending: [] };
  },
};
Object.defineProperty(globalThis, 'navigator', {
  value: { locks },
  configurable: true,
  writable: true,
});

await import('fake-indexeddb/auto');

const dbProto = await new Promise((resolve, reject) => {
  const req = indexedDB.open('__shim_probe');
  req.onsuccess = () => {
    const proto = Object.getPrototypeOf(req.result);
    req.result.close();
    resolve(proto);
  };
  req.onerror = () => reject(req.error);
});

// wa-sqlite's IDBContext calls db.transaction(db.objectStoreNames, mode, {durability}).
// fake-indexeddb neither coerces a DOMStringList nor accepts the options argument.
const originalTransaction = dbProto.transaction;
dbProto.transaction = function (names, mode) {
  const normalized =
    names != null && typeof names !== 'string' && !Array.isArray(names) ? Array.from(names) : names;
  return originalTransaction.call(this, normalized, mode);
};

/** Counts IDBObjectStore#get calls — one per SQLite page the pager faults in. */
export const pageReads = { count: 0, reset() { this.count = 0; } };

const storeProto = Object.getPrototypeOf(
  (await new Promise((resolve, reject) => {
    const req = indexedDB.open('__shim_probe2', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('s');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }))
    .transaction('s', 'readonly')
    .objectStore('s'),
);
const originalGet = storeProto.get;
storeProto.get = function (...args) {
  if (this.name === 'blocks') pageReads.count++;
  return originalGet.apply(this, args);
};
