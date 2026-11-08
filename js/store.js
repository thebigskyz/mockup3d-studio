// Tiny IndexedDB key/value store for imported model files (too big for localStorage).

const DB_NAME = 'mockup-studio';
const STORE = 'models';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function run(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const idbGet = (key) => run('readonly', (s) => s.get(key));
export const idbPut = (key, value) => run('readwrite', (s) => s.put(value, key));
export const idbDelete = (key) => run('readwrite', (s) => s.delete(key));
