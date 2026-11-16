// Local-only storage. Nothing here ever leaves the device.
const DB_NAME = 'ema-local';
const VERSION = 1;
export const STORES = ['meta', 'responses', 'prompts', 'health', 'chat'];

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('meta');
        d.createObjectStore('responses', { keyPath: 'id' });
        d.createObjectStore('prompts', { keyPath: 'id' });
        d.createObjectStore('health', { keyPath: 'id' });
        d.createObjectStore('chat', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const get = (store, key) => run(store, 'readonly', s => s.get(key));
export const all = (store) => run(store, 'readonly', s => s.getAll());
export const put = (store, value, key) =>
  run(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const clear = (store) => run(store, 'readwrite', s => s.clear());

export async function putMany(store, values) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const v of values) s.put(v);
    t.oncomplete = () => resolve(values.length);
    t.onerror = () => reject(t.error);
  });
}

export async function delMany(store, keys) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const k of keys) s.delete(k);
    t.oncomplete = () => resolve(keys.length);
    t.onerror = () => reject(t.error);
  });
}

// Removes the whole database from the device.
export async function destroy() {
  if (dbPromise) {
    try { (await dbPromise).close(); } catch {}
    dbPromise = null;
  }
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
