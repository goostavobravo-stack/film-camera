// Сховище кадрів «котушки» в IndexedDB: кадри переживають перезавантаження сторінки.
// Якщо IndexedDB недоступний (приватний режим, обмеження браузера), усі виклики тихо нічого не роблять,
// а застосунок працює тільки з кадрами в пам'яті.

const DB_NAME = 'film-camera-roll';
const STORE = 'shots';

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

/** Виконує операцію над сховищем; повертає результат запиту або undefined, якщо сховище недоступне. */
async function run(mode, op) {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = op(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Усі кадри від найстарішого до найновішого. */
export async function loadShots() {
  const all = (await run('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => a.time - b.time);
}

/** shot: { id, n, name, blob, thumb, caption, digital, time } */
export const saveShot = (shot) => run('readwrite', (s) => s.put(shot));
export const deleteShot = (id) => run('readwrite', (s) => s.delete(id));
export const clearShots = () => run('readwrite', (s) => s.clear());
