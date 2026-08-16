// Vernostka backup - automatic silent backup (Android/Chrome) + manual fallback (iOS Safari)
const Backup = {
  dirHandle: null,
  debounceTimer: null,
  MAX_BACKUPS: 5,
  supportsFS: 'showDirectoryPicker' in window,

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

  filenameForNow() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `vernostka-zaloha-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}.json`;
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

  // ---- Manual export (fallback for iOS Safari, or on-demand anywhere) ----
  async exportToFile() {
    const payload = await this.buildBackupPayload();
    const filename = this.filenameForNow();
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });

    if (navigator.share && navigator.canShare) {
      try {
        const file = new File([blob], filename, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Vernostka zaloha' });
          await DB.setSetting('lastBackupAt', Date.now());
          return filename;
        }
      } catch (e) { /* fall through to download */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    await DB.setSetting('lastBackupAt', Date.now());
    return filename;
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
