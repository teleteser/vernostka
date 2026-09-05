// Vernostka backup - automatic silent backup (Android/Chrome) + manual fallback (iOS Safari)
const Backup = {
  dirHandle: null,
  debounceTimer: null,
  MAX_BACKUPS: 5,
  supportsFS: 'showDirectoryPicker' in window,

  // ---- Single-card QR transfer ----
  // A QR code can only reliably hold a small amount of data, so a card shared this way is
  // reduced to its essential fields (no logo image, no locations/history/stats) and prefixed
  // so the scanner can tell it apart from a normal loyalty-card code.
  QR_CARD_PREFIX: 'VRNK1:',

  encodeCardForQr(card, categoryLabel) {
    const compact = {
      n: card.storeName || '',
      c: card.code || '',
      t: card.codeType || 'CODE128',
      cat: categoryLabel || '',
      note: card.note || '',
      ab: card.abbreviation || '',
      lc: card.logoColor || '',
      tc: card.logoTextColor || ''
    };
    return this.QR_CARD_PREFIX + JSON.stringify(compact);
  },

  decodeCardFromQr(text) {
    if (!text || typeof text !== 'string' || !text.startsWith(this.QR_CARD_PREFIX)) return null;
    try {
      return JSON.parse(text.slice(this.QR_CARD_PREFIX.length));
    } catch (e) {
      return null;
    }
  },

  // ---- Multi-card QR transfer ----
  // Many cards at once usually won't fit in a single scannable QR code, so this splits the
  // JSON into a sequence of frames the sender cycles through on-screen; the receiver keeps
  // scanning (without stopping after the first hit) until it has collected every part, then
  // reassembles and imports them all at once. If everything DOES fit in one frame, only a
  // single QR is used - no cycling needed.
  BULK_SINGLE_PREFIX: 'VRNKB1:',
  BULK_MULTI_PREFIX: 'VRNKM1:',
  // Fewer characters per frame means a lower-density QR code (bigger squares), which phone
  // cameras read far more easily - at the cost of more frames in the sequence.
  BULK_CHUNK_SIZE: 220,

  async buildBulkCardList(cardIds) {
    const [allCards, allCategories] = await Promise.all([DB.getAllCards(), DB.getAllCategories()]);
    const idSet = new Set(cardIds);
    const categoryLabelById = (id) => {
      const cat = allCategories.find((c) => c.id === id);
      if (!cat) return '';
      return (cat.name && cat.name.trim()) ? cat.name.trim() : (cat.builtin ? i18n.t(cat.builtin) : '');
    };
    // A card can be in several categories: they travel as "cats" (list of labels), while
    // "cat" keeps the first one so an older version on the other phone still understands it.
    const cardCategoryIds = (c) => (Array.isArray(c.categoryIds) ? c.categoryIds.filter(Boolean) : (c.categoryId ? [c.categoryId] : []));
    return allCards
      .filter((c) => idSet.has(c.id))
      .map((c) => ({
        n: c.storeName || '',
        c: c.code || '',
        t: c.codeType || 'CODE128',
        cats: cardCategoryIds(c).map(categoryLabelById).filter(Boolean),
        cat: categoryLabelById(cardCategoryIds(c)[0]),
        note: c.note || '',
        ab: c.abbreviation || '',
        lc: c.logoColor || '',
        tc: c.logoTextColor || ''
      }));
  },

  // Returns an array of QR-ready strings (frames) to display, one at a time, in sequence.
  // Every frame is built to exactly the same length (frame numbers padded with zeros, the
  // last chunk padded with spaces, which JSON ignores). Same length means every QR code has
  // the same size and module count, so the picture no longer appears to grow/shrink between
  // frames - that jumping is what made the receiving camera lose codes.
  buildBulkQrFrames(cardList) {
    const payloadStr = JSON.stringify(cardList);
    if (payloadStr.length <= this.BULK_CHUNK_SIZE) {
      return [this.BULK_SINGLE_PREFIX + payloadStr];
    }
    const total = Math.ceil(payloadStr.length / this.BULK_CHUNK_SIZE);
    const width = String(total).length;
    const frames = [];
    for (let i = 0; i < total; i++) {
      let chunk = payloadStr.slice(i * this.BULK_CHUNK_SIZE, (i + 1) * this.BULK_CHUNK_SIZE);
      if (chunk.length < this.BULK_CHUNK_SIZE) chunk = chunk + ' '.repeat(this.BULK_CHUNK_SIZE - chunk.length);
      const index = String(i + 1).padStart(width, '0');
      frames.push(`${this.BULK_MULTI_PREFIX}${index}/${total}:${chunk}`);
    }
    return frames;
  },

  // A single-frame bulk transfer (small card list) - decodes straight to the card array.
  decodeBulkFromQr(text) {
    if (!text || typeof text !== 'string' || !text.startsWith(this.BULK_SINGLE_PREFIX)) return null;
    try {
      const arr = JSON.parse(text.slice(this.BULK_SINGLE_PREFIX.length));
      return Array.isArray(arr) ? arr : null;
    } catch (e) {
      return null;
    }
  },

  // One part of a multi-frame bulk transfer. Returns {index, total, chunk} or null if the
  // text isn't one of our multi-part frames.
  parseBulkQrFrame(text) {
    if (!text || typeof text !== 'string' || !text.startsWith(this.BULK_MULTI_PREFIX)) return null;
    const rest = text.slice(this.BULK_MULTI_PREFIX.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) return null;
    const header = rest.slice(0, colonIdx);
    const chunk = rest.slice(colonIdx + 1);
    const parts = header.split('/');
    const index = parseInt(parts[0], 10);
    const total = parseInt(parts[1], 10);
    if (!index || !total || index < 1 || index > total) return null;
    return { index, total, chunk };
  },

  async buildBackupPayload() {
    const [cards, history, categories, settings] = await Promise.all([
      DB.getAllCards(), DB.getAllHistory(), DB.getAllCategories(), DB.getAllSettings()
    ]);
    return {
      appId: 'vernostka',
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      cards, history, categories, settings
    };
  },

  // A "transfer" payload is a subset backup - just the chosen cards plus whichever
  // categories they reference (no history/settings) - meant for sharing between phones
  // rather than a full local backup. It's still shaped like a normal backup file, so the
  // existing "Restore from backup" import flow can open it with no extra code.
  async buildTransferPayload(cardIds) {
    const [allCards, allCategories] = await Promise.all([DB.getAllCards(), DB.getAllCategories()]);
    const idSet = new Set(cardIds);
    const cards = allCards.filter((c) => idSet.has(c.id));
    const usedCategoryIds = new Set();
    cards.forEach((c) => {
      const ids = Array.isArray(c.categoryIds) ? c.categoryIds : (c.categoryId ? [c.categoryId] : []);
      ids.filter(Boolean).forEach((id) => usedCategoryIds.add(id));
    });
    const categories = allCategories.filter((c) => usedCategoryIds.has(c.id));
    return {
      appId: 'vernostka',
      formatVersion: 1,
      transfer: true,
      createdAt: new Date().toISOString(),
      cards, categories
    };
  },

  filenameForNow() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `vernostka-zaloha-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}.json`;
  },

  transferFilenameForNow() {
    return this.filenameForNow().replace('vernostka-zaloha-', 'vernostka-karty-');
  },

  // .txt + text/plain (rather than .json / application/json) for anything that goes through
  // the Share sheet: many share targets - Apple Mail and lots of Android messaging/mail apps
  // included - only declare support for a handful of common types, and "application/json"
  // is often missing from that list even though "text/plain" is essentially always accepted.
  // This is what lets a shared card/backup file actually show up as a normal, attachable
  // file when the person picks Mail, Messages, WhatsApp, etc. - on either iPhone or Android.
  shareFilenameForNow() {
    return this.filenameForNow().replace(/\.json$/, '.txt');
  },

  shareTransferFilenameForNow() {
    return this.transferFilenameForNow().replace(/\.json$/, '.txt');
  },

  // ---- Android / Chrome: File System Access API ----
  async chooseFolder() {
    if (!this.supportsFS) return false;
    try {
      this.dirHandle = await window.showDirectoryPicker({ id: 'vernostka-backup', mode: 'readwrite' });
      await DB.setSetting('backupFolderName', this.dirHandle.name);
      // Persist handle across sessions via IndexedDB (structured clone supports FS handles in modern Chrome)
      await DB.setSetting('backupDirHandle', this.dirHandle);
      return true;
    } catch (e) {
      return false;
    }
  },

  async restorePersistedFolder() {
    if (!this.supportsFS) return false;
    const handle = await DB.getSetting('backupDirHandle', null);
    if (!handle) return false;
    try {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        this.dirHandle = handle;
        return true;
      }
      if (perm === 'prompt') {
        const req = await handle.requestPermission({ mode: 'readwrite' });
        if (req === 'granted') { this.dirHandle = handle; return true; }
      }
    } catch (e) { /* handle likely stale */ }
    return false;
  },

  hasActiveFolderPermission() {
    return !!this.dirHandle;
  },

  scheduleDebouncedBackup(delayMs = 7000) {
    if (!this.dirHandle) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.writeBackupToFolder().catch((e) => console.warn('backup failed', e)), delayMs);
  },

  async writeBackupToFolder() {
    if (!this.dirHandle) return null;
    const payload = await this.buildBackupPayload();
    const filename = this.filenameForNow();
    const fileHandle = await this.dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(payload));
    await writable.close();
    await DB.setSetting('lastBackupAt', Date.now());
    await this._pruneOldBackups();
    return filename;
  },

  async _pruneOldBackups() {
    if (!this.dirHandle) return;
    const entries = [];
    for await (const [name, handle] of this.dirHandle.entries()) {
      if (handle.kind === 'file' && /^vernostka-zaloha-.*\.json$/.test(name)) {
        entries.push(name);
      }
    }
    entries.sort().reverse(); // newest (lexicographically largest date-time) first
    const toDelete = entries.slice(this.MAX_BACKUPS);
    for (const name of toDelete) {
      try { await this.dirHandle.removeEntry(name); } catch (e) { /* ignore */ }
    }
  },

  async findLatestBackupInFolder() {
    if (!this.dirHandle) return null;
    const entries = [];
    for await (const [name, handle] of this.dirHandle.entries()) {
      if (handle.kind === 'file' && /^vernostka-zaloha-.*\.json$/.test(name)) {
        entries.push(name);
      }
    }
    if (entries.length === 0) return null;
    entries.sort().reverse();
    const fileHandle = await this.dirHandle.getFileHandle(entries[0]);
    const file = await fileHandle.getFile();
    const text = await file.text();
    try {
      return { name: entries[0], data: JSON.parse(text) };
    } catch (e) {
      return null;
    }
  },

  // Saves the backup straight to a file (no share sheet in between) - on Android that means
  // the browser's download folder. Returns the filename that was written.
  async downloadBackupFile() {
    const payload = await this.buildBackupPayload();
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const downloadFilename = this.filenameForNow();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    await DB.setSetting('lastBackupAt', Date.now());
    return downloadFilename;
  },

  // ---- Manual export (fallback for iOS Safari, or on-demand anywhere) ----
  async exportToFile() {
    const payload = await this.buildBackupPayload();
    const shareFilename = this.shareFilenameForNow();
    const blob = new Blob([JSON.stringify(payload)], { type: 'text/plain' });

    if (navigator.share && navigator.canShare) {
      try {
        const file = new File([blob], shareFilename, { type: 'text/plain' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Vernostka zaloha' });
          await DB.setSetting('lastBackupAt', Date.now());
          return shareFilename;
        }
      } catch (e) { /* fall through to download */ }
    }
    const downloadFilename = this.filenameForNow();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    await DB.setSetting('lastBackupAt', Date.now());
    return downloadFilename;
  },

  // Shares just the chosen cards (not the full local backup) as a file. Uses the same
  // native Web Share sheet as a normal backup export - on Android this is exactly where
  // Bluetooth / Nearby Share / any messaging app shows up, so we get "send via Bluetooth"
  // for free without needing the raw (much less broadly supported) Web Bluetooth API.
  async shareTransferFile(cardIds) {
    const payload = await this.buildTransferPayload(cardIds);
    const shareFilename = this.shareTransferFilenameForNow();
    const blob = new Blob([JSON.stringify(payload)], { type: 'text/plain' });

    if (navigator.share && navigator.canShare) {
      try {
        const file = new File([blob], shareFilename, { type: 'text/plain' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Vernostka karty' });
          return true;
        }
      } catch (e) { /* fall through to download */ }
    }
    const downloadFilename = this.transferFilenameForNow();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
  },

  async importFromFile(file) {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload || !Array.isArray(payload.cards)) throw new Error('invalid backup file');
    return payload;
  },

  async applyImport(payload, mode /* 'merge' | 'replace' */) {
    if (mode === 'replace') {
      await DB.replaceAllCards(payload.cards || []);
      await DB.replaceAllHistory(payload.history || []);
      await DB.replaceAllCategories(payload.categories || []);
    } else {
      for (const c of payload.cards || []) await DB.putCard(c);
      for (const h of payload.history || []) await DB.addHistory(h);
      for (const cat of payload.categories || []) await DB.putCategory(cat);
    }
  },

  markDirty() {
    // Used by iOS/unsupported-FS path to show a "you have unsaved changes" reminder badge.
    DB.setSetting('hasUnsavedChanges', true);
  }
};
