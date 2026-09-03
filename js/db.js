// Vernostka DB layer - IndexedDB wrapper
const DB_NAME = 'vernostka-db';
const DB_VERSION = 2;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('cards')) {
        const store = db.createObjectStore('cards', { keyPath: 'id' });
        store.createIndex('code', 'code', { unique: false });
        store.createIndex('storeName', 'storeName', { unique: false });
      }
      if (!db.objectStoreNames.contains('history')) {
        const store = db.createObjectStore('history', { keyPath: 'id' });
        store.createIndex('cardId', 'cardId', { unique: false });
      }
      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('transfers')) {
        db.createObjectStore('transfers', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return _dbPromise;
}

function tx(storeNames, mode = 'readonly') {
  return openDB().then((db) => db.transaction(storeNames, mode));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const DB = {
  uid() {
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  },

  // ---- Cards ----
  async getAllCards() {
    const t = await tx(['cards']);
    return reqToPromise(t.objectStore('cards').getAll());
  },
  async getCard(id) {
    const t = await tx(['cards']);
    return reqToPromise(t.objectStore('cards').get(id));
  },
  async findByCode(code) {
    const all = await this.getAllCards();
    return all.find((c) => c.code === code);
  },
  async putCard(card) {
    const t = await tx(['cards'], 'readwrite');
    t.objectStore('cards').put(card);
    return new Promise((res, rej) => { t.oncomplete = () => res(card); t.onerror = () => rej(t.error); });
  },
  async deleteCard(id) {
    const t = await tx(['cards', 'history'], 'readwrite');
    t.objectStore('cards').delete(id);
    const hIndex = t.objectStore('history').index('cardId');
    const cursorReq = hIndex.openCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  },
  async replaceAllCards(cards) {
    const t = await tx(['cards'], 'readwrite');
    const store = t.objectStore('cards');
    store.clear();
    cards.forEach((c) => store.put(c));
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  },

  // ---- History ----
  async addHistory(entry) {
    const t = await tx(['history'], 'readwrite');
    t.objectStore('history').put(entry);
    return new Promise((res, rej) => { t.oncomplete = () => res(entry); t.onerror = () => rej(t.error); });
  },
  async getHistoryForCard(cardId) {
    const t = await tx(['history']);
    const idx = t.objectStore('history').index('cardId');
    const all = await reqToPromise(idx.getAll(IDBKeyRange.only(cardId)));
    return all.sort((a, b) => b.timestamp - a.timestamp);
  },
  async clearHistoryForCard(cardId) {
    const t = await tx(['history'], 'readwrite');
    const idx = t.objectStore('history').index('cardId');
    const cursorReq = idx.openCursor(IDBKeyRange.only(cardId));
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  },
  async getAllHistory() {
    const t = await tx(['history']);
    return reqToPromise(t.objectStore('history').getAll());
  },
  async replaceAllHistory(entries) {
    const t = await tx(['history'], 'readwrite');
    const store = t.objectStore('history');
    store.clear();
    entries.forEach((e) => store.put(e));
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  },

  // ---- Categories ----
  async getAllCategories() {
    const t = await tx(['categories']);
    return reqToPromise(t.objectStore('categories').getAll());
  },
  async putCategory(cat) {
    const t = await tx(['categories'], 'readwrite');
    t.objectStore('categories').put(cat);
    return new Promise((res, rej) => { t.oncomplete = () => res(cat); t.onerror = () => rej(t.error); });
  },
  async deleteCategory(id) {
    const t = await tx(['categories'], 'readwrite');
    t.objectStore('categories').delete(id);
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  },
  async replaceAllCategories(cats) {
    const t = await tx(['categories'], 'readwrite');
    const store = t.objectStore('categories');
    store.clear();
    cats.forEach((c) => store.put(c));
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  },

  // ---- Settings ----
  async getSetting(key, fallback = null) {
    const t = await tx(['settings']);
    const rec = await reqToPromise(t.objectStore('settings').get(key));
    return rec ? rec.value : fallback;
  },
  async setSetting(key, value) {
    const t = await tx(['settings'], 'readwrite');
    t.objectStore('settings').put({ key, value });
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  },
  async getAllSettings() {
    const t = await tx(['settings']);
    return reqToPromise(t.objectStore('settings').getAll());
  },
  async replaceAllSettings(settings) {
    const t = await tx(['settings'], 'readwrite');
    const store = t.objectStore('settings');
    store.clear();
    settings.forEach((s) => store.put(s));
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  },

  // ---- Transfer log (record of QR "Send cards" sessions) ----
  async addTransferLog(entry) {
    const t = await tx(['transfers'], 'readwrite');
    t.objectStore('transfers').put(entry);
    return new Promise((res, rej) => { t.oncomplete = () => res(entry); t.onerror = () => rej(t.error); });
  },
  async getAllTransferLogs() {
    const t = await tx(['transfers']);
    return reqToPromise(t.objectStore('transfers').getAll());
  },

  async isEmpty() {
    const cards = await this.getAllCards();
    return cards.length === 0;
  }
};
