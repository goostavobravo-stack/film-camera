// Сховище кадрів «котушки» в IndexedDB: кадри переживають перезавантаження сторінки.
// Якщо IndexedDB недоступний (приватний режим, обмеження браузера), усі виклики тихо нічого не роблять,
// а застосунок працює тільки з кадрами в пам'яті.

const STORE = 'shots';

/** Окреме сховище кадрів у власній базі IndexedDB (звичайна плівка й плівка темної кімнати не змішуються). */
export function createStore(dbName) {
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open(dbName, 1);
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

  return {
    /** Усі кадри від найстарішого до найновішого. */
    async loadShots() {
      const all = (await run('readonly', (st) => st.getAll())) || [];
      return all.sort((x, y) => x.time - y.time);
    },
    /** shot: { id, n, name, blob, thumb, caption, time } (у темній кімнаті: positive, thumbPos, thumbNeg, bw, converted) */
    saveShot: (shot) => run('readwrite', (st) => st.put(shot)),
    deleteShot: (id) => run('readwrite', (st) => st.delete(id)),
    clearShots: () => run('readwrite', (st) => st.clear()),
  };
}

const roll = createStore('film-camera-roll');
export const { loadShots, saveShot, deleteShot, clearShots } = roll;
/** Плівка режиму «Темна кімната». */
export const darkStore = createStore('film-darkroom-roll');
