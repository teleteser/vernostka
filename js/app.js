// Vernostka main app controller
const App = {
  cards: [],
  categories: [],
  currentCategoryFilter: 'all',
  currentSort: 'frequency',
  userPos: null,
  scanner: null,
  wakeLockSentinel: null,
  editingCard: null, // draft object while add/edit modal open
  editingIsNew: true,
  pendingLocationEdit: null, // {index, isNew}
  fsZoom: 100,
  fsRotated: false,

  async init() {
    await this.loadSettings();
    this.applyTheme();
    this.applyLangToDom();
    await this.ensureDefaultCategories();
    this.categories = await DB.getAllCategories();
    this.cards = await DB.getAllCards();

    this.bindNav();
    this.bindCardsView();
    this.bindSettingsView();
    this.bindEditModal();
    this.bindMapModal();
    this.bindDetailModal();
    this.bindFullscreenCode();
    this.bindConfirmModal();

    // Keep a pristine copy of the confirm sheet's button row so threeWayDialog() can
    // rebuild it after temporarily replacing it with a custom set of buttons.
    this._confirmBtnRowTemplate = document.querySelector('#modal-confirm .btn-row').innerHTML;

    this.renderCategoryChips();
    this.renderCategorySelect();
    this.renderSettingsCategories();
    this.renderCardsList();
    this.updateBackupStatusUI();

    this.userPos = await Geo.getCurrentPosition().catch(() => null);
    if (this.currentSort === 'distance') this.renderCardsList();

    this.registerServiceWorker();
    await this.tryRestoreFolderAndCheckBackup();
    this.maybeShowInstallPrompt();
  },

  async loadSettings() {
    this.lang = await DB.getSetting('lang', detectDefaultLang());
    i18n.setLang(this.lang);
    this.theme = await DB.getSetting('theme', 'system');
    this.currentSort = await DB.getSetting('sortMode', 'frequency');
  },

  applyTheme() {
    let effective = this.theme;
    if (effective === 'system') {
      effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', effective);
    document.querySelectorAll('#theme-segmented button').forEach((b) => b.classList.toggle('active', b.dataset.value === this.theme));
  },

  applyLangToDom() {
    document.documentElement.lang = this.lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = i18n.t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = i18n.t(el.dataset.i18nPlaceholder); });
    document.title = i18n.t('appName');
    document.querySelectorAll('#lang-segmented button').forEach((b) => b.classList.toggle('active', b.dataset.value === this.lang));
    this.renderCategoryChips();
    this.renderCategorySelect();
    this.renderSettingsCategories();
    this.renderCardsList();
  },

  async ensureDefaultCategories() {
    const existing = await DB.getAllCategories();
    if (existing.length === 0) {
      for (const key of DEFAULT_CATEGORIES) {
        await DB.putCategory({ id: DB.uid(), builtin: key, name: null });
      }
    }
  },

  categoryLabel(cat) {
    // A custom name (set via rename, even on a built-in category) always wins; otherwise
    // built-in categories fall back to the live-translated label so they still relabel
    // themselves automatically when the app language is switched.
    if (cat.name && cat.name.trim()) return cat.name.trim();
    return cat.builtin ? i18n.t(cat.builtin) : '';
  },

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
    }
  },

  // ---------------- Navigation ----------------
  bindNav() {
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.target).classList.add('active');
      });
    });
  },

  // ---------------- Cards view ----------------
  bindCardsView() {
    document.getElementById('search-input').addEventListener('input', () => this.renderCardsList());
    document.getElementById('fab-add').addEventListener('click', () => this.openAddCard());
    document.getElementById('empty-add-btn').addEventListener('click', () => this.openAddCard());
    document.getElementById('sort-btn').addEventListener('click', () => this.cycleSort());
  },

  cycleSort() {
    const order = ['frequency', 'alpha', 'distance'];
    const idx = order.indexOf(this.currentSort);
    this.currentSort = order[(idx + 1) % order.length];
    DB.setSetting('sortMode', this.currentSort);
    this.toast(i18n.t('sort_' + (this.currentSort === 'alpha' ? 'alpha' : this.currentSort === 'distance' ? 'distance' : 'frequency')));
    this.renderCardsList();
  },

  renderCategoryChips() {
    const el = document.getElementById('category-chips');
    el.innerHTML = '';
    const allChip = document.createElement('button');
    allChip.className = 'chip' + (this.currentCategoryFilter === 'all' ? ' active' : '');
    allChip.textContent = i18n.t('filter_all');
    allChip.addEventListener('click', () => { this.currentCategoryFilter = 'all'; this.renderCategoryChips(); this.renderCardsList(); });
    el.appendChild(allChip);
    this.categories.forEach((cat) => {
      const chip = document.createElement('button');
      chip.className = 'chip' + (this.currentCategoryFilter === cat.id ? ' active' : '');
      chip.textContent = this.categoryLabel(cat);
      chip.addEventListener('click', () => { this.currentCategoryFilter = cat.id; this.renderCategoryChips(); this.renderCardsList(); });
      el.appendChild(chip);
    });
  },

  async renderCardsList() {
    this.cards = await DB.getAllCards();
    const listEl = document.getElementById('cards-list');
    const emptyEl = document.getElementById('empty-state');
    const search = document.getElementById('search-input').value.trim().toLowerCase();

    let filtered = this.cards.filter((c) => {
      if (this.currentCategoryFilter !== 'all' && c.categoryId !== this.currentCategoryFilter) return false;
      if (search && !c.storeName.toLowerCase().includes(search)) return false;
      return true;
    });

    filtered = this.sortCards(filtered);

    if (this.cards.length === 0) {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    listEl.innerHTML = '';
    filtered.forEach((card) => listEl.appendChild(this.renderCardRow(card)));
  },

  sortCards(list) {
    const withAddedIdx = list.map((c, i) => ({ c, i }));
    withAddedIdx.sort((a, b) => {
      const c1 = a.c, c2 = b.c;
      let cmp = 0;
      if (this.currentSort === 'alpha') {
        cmp = c1.storeName.localeCompare(c2.storeName, undefined, { sensitivity: 'base' });
      } else if (this.currentSort === 'distance') {
        const d1 = this.userPos ? Geo.nearestLocation(this.userPos, c1.locations || []) : Infinity;
        const d2 = this.userPos ? Geo.nearestLocation(this.userPos, c2.locations || []) : Infinity;
        cmp = d1 - d2;
      } else { // frequency
        cmp = (c2.useCount || 0) - (c1.useCount || 0);
      }
      if (cmp === 0) cmp = (c2.createdAt || 0) - (c1.createdAt || 0);
      return cmp;
    });
    return withAddedIdx.map((x) => x.c);
  },

  renderCardRow(card) {
    const row = document.createElement('div');
    row.className = 'card-row';
    row.innerHTML = `
      <div class="card-logo">${card.logo ? `<img src="${card.logo}" alt="">` : this.initialLetter(card.storeName)}</div>
      <div class="card-row-info">
        <div class="card-row-name">${this.escapeHtml(card.storeName)}</div>
        <div class="card-row-meta">${card.useCount || 0} ${i18n.t('uses_label')} · ${this.formatLastUsed(card.lastUsedAt)}</div>
      </div>
      <div class="card-row-chevron"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    `;
    row.addEventListener('click', () => this.openCardDetail(card));
    return row;
  },

  initialLetter(name) { return (name || '?').trim().charAt(0).toUpperCase(); },
  formatLastUsed(ts) {
    if (!ts) return i18n.t('never_used');
    const d = new Date(ts);
    return d.toLocaleDateString(this.lang === 'sk' ? 'sk-SK' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString(this.lang === 'sk' ? 'sk-SK' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  },
  escapeHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; },

  // ---------------- Add / edit card modal ----------------
  bindEditModal() {
    document.getElementById('edit-close-btn').addEventListener('click', () => this.closeEditModal());
    document.getElementById('edit-save-btn').addEventListener('click', () => this.saveEditingCard());

    document.querySelectorAll('#capture-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => this.switchCapturePane(btn.dataset.value));
    });

    document.getElementById('field-code').addEventListener('input', (e) => {
      this.editingCard.code = e.target.value;
      this.updateCodeTypeSelectAuto();
      this.renderManualCodePreview();
    });
    document.getElementById('field-code-type').addEventListener('change', (e) => {
      this.editingCard.codeType = e.target.value;
      this.renderManualCodePreview();
    });
    document.getElementById('field-store-name').addEventListener('input', (e) => {
      this.editingCard.storeName = e.target.value;
    });
    document.getElementById('field-store-name').addEventListener('blur', () => this.tryFetchLogo());
    document.getElementById('field-category').addEventListener('change', (e) => { this.editingCard.categoryId = e.target.value; });
    document.getElementById('field-note').addEventListener('input', (e) => { this.editingCard.note = e.target.value; });

    document.getElementById('add-location-btn').addEventListener('click', () => this.openLocationPicker(null));
    document.getElementById('camera-denied-manual-btn').addEventListener('click', () => this.switchCapturePane('manual'));
    document.getElementById('scan-slow-manual-btn').addEventListener('click', () => this.switchCapturePane('manual'));
    document.getElementById('switch-camera-btn').addEventListener('click', () => {
      if (this.scanner) this.scanner.switchCamera((r) => this.handleScanResult(r), (e) => this.handleCameraError(e));
    });

    document.getElementById('edit-delete-card-btn').addEventListener('click', async () => {
      const ok = await this.confirmDialog(
        i18n.t('delete_card_title'),
        i18n.t('delete_card_desc', { name: this.editingCard.storeName }),
        i18n.t('delete'), i18n.t('cancel')
      );
      if (!ok) return;
      await DB.deleteCard(this.editingCard.id);
      this.stopScanning();
      this.hideModal('modal-edit');
      this.hideModal('modal-detail');
      this.editingCard = null;
      await this.renderCardsList();
      this.onDataChanged();
    });
    document.getElementById('edit-clear-history-btn').addEventListener('click', async () => {
      const ok = await this.confirmDialog(i18n.t('delete_history_title'), i18n.t('delete_history_desc'), i18n.t('confirm'), i18n.t('cancel'));
      if (!ok) return;
      await DB.clearHistoryForCard(this.editingCard.id);
      this.editingCard.useCount = 0;
      this.editingCard.detailOpenCount = 0;
      this.editingCard.lastUsedAt = null;
      await DB.putCard(this.editingCard);
      if (this._detailCard && this._detailCard.id === this.editingCard.id) {
        Object.assign(this._detailCard, { useCount: 0, detailOpenCount: 0, lastUsedAt: null });
      }
      this.toast(i18n.t('delete_history_title'));
      this.onDataChanged();
    });
  },

  populateCodeTypeSelect() {
    const sel = document.getElementById('field-code-type');
    sel.innerHTML = '';
    CODE_TYPES.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = t;
      sel.appendChild(opt);
    });
  },

  updateCodeTypeSelectAuto() {
    if (!this.editingCard.codeTypeManuallySet) {
      const guessed = guessCodeType(this.editingCard.code);
      this.editingCard.codeType = guessed;
      document.getElementById('field-code-type').value = guessed;
    }
  },

  renderManualCodePreview() {
    const el = document.getElementById('manual-code-preview');
    if (this.editingCard.code) {
      renderCode(el, this.editingCard.code, this.editingCard.codeType, { height: 90, width: 220 });
    } else {
      el.innerHTML = `<span class="hint">${i18n.t('card_code_placeholder')}</span>`;
    }
  },

  renderCategorySelect() {
    const sel = document.getElementById('field-category');
    sel.innerHTML = '';
    this.categories.forEach((cat) => {
      const opt = document.createElement('option');
      opt.value = cat.id; opt.textContent = this.categoryLabel(cat);
      sel.appendChild(opt);
    });
  },

  openAddCard() {
    this.editingIsNew = true;
    this.editingCard = {
      id: DB.uid(),
      storeName: '',
      code: '',
      codeType: 'CODE128',
      codeTypeManuallySet: false,
      categoryId: this.categories[0] ? this.categories[0].id : null,
      note: '',
      logo: null,
      locations: [],
      useCount: 0,
      detailOpenCount: 0,
      lastUsedAt: null,
      createdAt: Date.now()
    };
    document.getElementById('edit-title').textContent = i18n.t('add_card');
    this.fillEditForm();
    this.populateCodeTypeSelect();
    document.getElementById('field-code-type').value = this.editingCard.codeType;
    this.showModal('modal-edit');
    this.switchCapturePane('scan');
  },

  openEditCard(card) {
    this.editingIsNew = false;
    this.editingCard = JSON.parse(JSON.stringify(card));
    this.editingCard.codeTypeManuallySet = true;
    document.getElementById('edit-title').textContent = i18n.t('edit');
    this.fillEditForm();
    this.populateCodeTypeSelect();
    document.getElementById('field-code-type').value = this.editingCard.codeType;
    this.showModal('modal-edit');
    this.switchCapturePane('manual');
  },

  fillEditForm() {
    document.getElementById('field-code').value = this.editingCard.code || '';
    document.getElementById('field-store-name').value = this.editingCard.storeName || '';
    document.getElementById('field-note').value = this.editingCard.note || '';
    this.renderCategorySelect();
    document.getElementById('field-category').value = this.editingCard.categoryId || '';
    this.renderLogoPreview();
    this.renderManualCodePreview();
    this.renderLocationList();
    document.getElementById('camera-denied').hidden = true;
    document.getElementById('edit-danger-actions').hidden = this.editingIsNew;
  },

  renderLogoPreview() {
    const el = document.getElementById('store-logo-preview');
    el.innerHTML = this.editingCard.logo ? `<img src="${this.editingCard.logo}" alt="">` : this.initialLetter(this.editingCard.storeName);
  },

  async tryFetchLogo() {
    if (this.editingCard.logo || !this.editingCard.storeName) return;
    const dataUrl = await LogoLookup.fetchLogoAsDataUrl(this.editingCard.storeName);
    if (dataUrl) {
      this.editingCard.logo = dataUrl;
      this.renderLogoPreview();
    }
  },

  renderLocationList() {
    const el = document.getElementById('location-list');
    el.innerHTML = '';
    (this.editingCard.locations || []).forEach((loc, idx) => {
      const row = document.createElement('div');
      row.className = 'location-row';
      row.innerHTML = `<span class="location-row-name">${this.escapeHtml(loc.name)}</span><button class="location-row-remove" data-i18n="remove_location">${i18n.t('remove_location')}</button>`;
      row.querySelector('.location-row-remove').addEventListener('click', () => {
        this.editingCard.locations.splice(idx, 1);
        this.renderLocationList();
      });
      row.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') this.openLocationPicker(idx); });
      el.appendChild(row);
    });
  },

  switchCapturePane(which) {
    document.querySelectorAll('#capture-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.value === which));
    document.getElementById('scan-pane').hidden = which !== 'scan';
    document.getElementById('manual-pane').hidden = which !== 'manual';
    if (which === 'scan') {
      this.startScanning();
    } else {
      this.stopScanning();
    }
  },

  async startScanning() {
    this.stopScanning();
    const video = document.getElementById('scan-video');
    document.getElementById('camera-denied').hidden = true;
    document.getElementById('scan-slow-hint').hidden = true;
    this.scanner = new Scanner(video);
    const ok = await this.scanner.start((result) => this.handleScanResult(result), (err) => this.handleCameraError(err));
    if (!ok) { this.handleCameraError(); return; }
    // If nothing gets detected for a while, nudge the user toward manual entry instead of
    // leaving them staring at a camera feed indefinitely (helps with damaged/unusual codes).
    clearTimeout(this._scanSlowTimer);
    this._scanSlowTimer = setTimeout(() => {
      const hint = document.getElementById('scan-slow-hint');
      if (hint && !document.getElementById('scan-pane').hidden) hint.hidden = false;
    }, 9000);
  },

  stopScanning() {
    clearTimeout(this._scanSlowTimer);
    if (this.scanner) { this.scanner.stop(); }
  },

  handleCameraError() {
    document.getElementById('camera-denied').hidden = false;
  },

  async handleScanResult(result) {
    this.editingCard.code = result.value;
    this.editingCard.codeType = result.format;
    this.editingCard.codeTypeManuallySet = true;
    document.getElementById('field-code').value = result.value;
    this.populateCodeTypeSelect();
    document.getElementById('field-code-type').value = result.format;
    this.renderManualCodePreview();

    const dup = await DB.findByCode(result.value);
    if (dup && dup.id !== this.editingCard.id) {
      const proceed = await this.confirmDialog(
        i18n.t('duplicate_title'),
        i18n.t('duplicate_desc', { name: dup.storeName }),
        i18n.t('duplicate_continue'),
        i18n.t('cancel')
      );
      if (!proceed) { this.startScanning(); return; }
    }
    if (navigator.vibrate) navigator.vibrate(60);
    this.switchCapturePane('manual');
  },

  closeEditModal() {
    this.stopScanning();
    this.hideModal('modal-edit');
    this.editingCard = null;
  },

  async saveEditingCard() {
    const c = this.editingCard;
    if (!c.storeName || !c.storeName.trim() || !c.code || !c.code.trim()) {
      this.toast(i18n.t('required_fields'));
      return;
    }
    if (this.editingIsNew) {
      const dup = await DB.findByCode(c.code);
      if (dup) {
        const proceed = await this.confirmDialog(
          i18n.t('duplicate_title'),
          i18n.t('duplicate_desc', { name: dup.storeName }),
          i18n.t('duplicate_continue'),
          i18n.t('cancel')
        );
        if (!proceed) return;
      }
    }
    delete c.codeTypeManuallySet;
    await DB.putCard(c);
    this.stopScanning();
    this.hideModal('modal-edit');
    this.editingCard = null;
    await this.renderCardsList();
    this.onDataChanged();
  },

  // ---------------- Location / map picker ----------------
  bindMapModal() {
    document.getElementById('map-close-btn').addEventListener('click', () => { Geo.destroyPicker(); this.hideModal('modal-map'); });
    document.getElementById('map-save-btn').addEventListener('click', () => this.saveLocationFromPicker());
    document.getElementById('map-use-current-btn').addEventListener('click', async () => {
      const pos = await Geo.getCurrentPosition();
      if (pos) Geo.centerOn(pos.lat, pos.lng);
      this._pickedLatLng = pos;
    });
  },

  async openLocationPicker(idx) {
    this.pendingLocationEdit = idx;
    const existing = idx !== null ? this.editingCard.locations[idx] : null;
    document.getElementById('location-name-input').value = existing ? existing.name : (this.editingCard.storeName || '');
    this._pickedLatLng = existing ? { lat: existing.lat, lng: existing.lng } : null;
    this.showModal('modal-map');
    await Geo.initPicker(document.getElementById('map-container'), existing, (lat, lng) => { this._pickedLatLng = { lat, lng }; });
  },

  saveLocationFromPicker() {
    const name = document.getElementById('location-name-input').value.trim() || this.editingCard.storeName;
    if (!this._pickedLatLng) { this.toast(i18n.t('map_pick_hint')); return; }
    const loc = { name, lat: this._pickedLatLng.lat, lng: this._pickedLatLng.lng };
    if (this.pendingLocationEdit !== null) {
      this.editingCard.locations[this.pendingLocationEdit] = loc;
    } else {
      this.editingCard.locations = this.editingCard.locations || [];
      this.editingCard.locations.push(loc);
    }
    Geo.destroyPicker();
    this.hideModal('modal-map');
    this.renderLocationList();
  },

  // ---------------- Card detail ----------------
  bindDetailModal() {
    document.getElementById('detail-close-btn').addEventListener('click', () => this.hideModal('modal-detail'));
    document.getElementById('detail-edit-btn').addEventListener('click', () => {
      this.hideModal('modal-detail');
      this.openEditCard(this._detailCard);
    });
    document.getElementById('show-code-btn').addEventListener('click', () => this.openFullscreenCode(this._detailCard));
    document.getElementById('toggle-history-btn').addEventListener('click', () => {
      const el = document.getElementById('detail-history-section');
      el.hidden = !el.hidden;
    });
  },

  async openCardDetail(card) {
    this._detailCard = card;
    // record "detail open" interaction
    card.detailOpenCount = (card.detailOpenCount || 0) + 1;
    await DB.putCard(card);
    await DB.addHistory({ id: DB.uid(), cardId: card.id, type: 'detail', timestamp: Date.now() });
    this.renderDetail(card);
    this.showModal('modal-detail');
    this.onDataChanged();
  },

  async renderDetail(card) {
    document.getElementById('detail-title').textContent = card.storeName;
    renderCode(document.getElementById('detail-code-mini'), card.code, card.codeType, { height: 150, width: 400, responsive: true });
    document.getElementById('detail-history-section').hidden = true;
    document.getElementById('detail-uses').textContent = card.useCount || 0;
    document.getElementById('detail-last-used').textContent = this.formatLastUsed(card.lastUsedAt);
    const noteTitle = document.getElementById('detail-note-title');
    const noteEl = document.getElementById('detail-note');
    if (card.note) { noteTitle.hidden = false; noteEl.textContent = card.note; }
    else { noteTitle.hidden = true; noteEl.textContent = ''; }

    const history = await DB.getHistoryForCard(card.id);
    const listEl = document.getElementById('detail-history-list');
    listEl.innerHTML = '';
    if (history.length === 0) {
      listEl.innerHTML = `<p class="hint">${i18n.t('history_empty')}</p>`;
    } else {
      history.slice(0, 30).forEach((h) => {
        const row = document.createElement('div');
        row.className = 'history-row';
        const label = h.type === 'code' ? i18n.t('history_code_shown') : i18n.t('history_detail_open');
        row.innerHTML = `<span>${this.formatLastUsed(h.timestamp)}</span><span class="type">${label}${h.durationMs ? ' · ' + Math.round(h.durationMs / 1000) + 's' : ''}</span>`;
        listEl.appendChild(row);
      });
    }
  },

  // ---------------- Fullscreen code (payment view) ----------------
  bindFullscreenCode() {
    document.getElementById('fs-close-btn').addEventListener('click', () => this.closeFullscreenCode());
    document.getElementById('fs-rotate-btn').addEventListener('click', () => {
      this.fsRotated = !this.fsRotated;
      this.applyFsTransform();
    });
    document.getElementById('fs-zoom').addEventListener('input', (e) => {
      this.fsZoom = Number(e.target.value);
      this.applyFsTransform();
    });
  },

  applyFsTransform() {
    const el = document.getElementById('fs-code-container');
    el.style.transform = `rotate(${this.fsRotated ? 90 : 0}deg) scale(${this.fsZoom / 100})`;
  },

  async openFullscreenCode(card) {
    this._fsStartedAt = Date.now();
    document.getElementById('fs-store-name').textContent = card.storeName;
    this.fsZoom = 100; this.fsRotated = false;
    document.getElementById('fs-zoom').value = 100;
    renderCode(document.getElementById('fs-code-container'), card.code, card.codeType, { height: 180, width: 500, responsive: true });
    this.applyFsTransform();
    document.getElementById('modal-fullscreen-code').hidden = false;

    card.useCount = (card.useCount || 0) + 1;
    card.lastUsedAt = Date.now();
    await DB.putCard(card);
    this._fsHistoryEntry = { id: DB.uid(), cardId: card.id, type: 'code', timestamp: Date.now() };

    if ('wakeLock' in navigator) {
      try { this.wakeLockSentinel = await navigator.wakeLock.request('screen'); } catch (e) { this.wakeLockSentinel = null; }
    }
    this.renderDetail(card);
    this.renderCardsList();
  },

  async closeFullscreenCode() {
    document.getElementById('modal-fullscreen-code').hidden = true;
    if (this.wakeLockSentinel) { try { await this.wakeLockSentinel.release(); } catch (e) {} this.wakeLockSentinel = null; }
    if (this._fsHistoryEntry) {
      this._fsHistoryEntry.durationMs = Date.now() - this._fsStartedAt;
      await DB.addHistory(this._fsHistoryEntry);
      this._fsHistoryEntry = null;
      if (this._detailCard) this.renderDetail(this._detailCard);
    }
    this.onDataChanged();
  },

  // ---------------- Settings ----------------
  bindSettingsView() {
    document.querySelectorAll('#lang-segmented button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        this.lang = btn.dataset.value;
        i18n.setLang(this.lang);
        await DB.setSetting('lang', this.lang);
        this.applyLangToDom();
      });
    });
    document.querySelectorAll('#theme-segmented button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        this.theme = btn.dataset.value;
        await DB.setSetting('theme', this.theme);
        this.applyTheme();
      });
    });
    document.getElementById('settings-add-category').addEventListener('click', async () => {
      const name = prompt(i18n.t('category_new_placeholder'));
      if (!name || !name.trim()) return;
      await DB.putCategory({ id: DB.uid(), builtin: null, name: name.trim() });
      this.categories = await DB.getAllCategories();
      this.renderSettingsCategories();
      this.renderCategoryChips();
      this.renderCategorySelect();
      this.onDataChanged();
    });

    document.getElementById('choose-folder-btn').addEventListener('click', async () => {
      const ok = await Backup.chooseFolder();
      if (ok) {
        this.updateBackupStatusUI();
        await Backup.writeBackupToFolder();
        this.updateBackupStatusUI();
        this.toast(i18n.t('backup_now'));
      }
    });
    document.getElementById('backup-now-btn').addEventListener('click', async () => {
      if (Backup.hasActiveFolderPermission()) {
        await Backup.writeBackupToFolder();
      } else {
        await Backup.exportToFile();
      }
      this.updateBackupStatusUI();
      this.toast(i18n.t('backup_now'));
    });
    document.getElementById('export-backup-btn').addEventListener('click', async () => {
      await Backup.exportToFile();
      this.updateBackupStatusUI();
    });
    document.getElementById('import-backup-btn').addEventListener('click', () => {
      document.getElementById('import-file-input').click();
    });
    document.getElementById('import-file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const payload = await Backup.importFromFile(file);
        await this.handleImportPayload(payload);
      } catch (err) {
        this.toast(i18n.t('error_generic'));
      }
      e.target.value = '';
    });

    document.getElementById('reset-data-btn').addEventListener('click', async () => {
      const ok = await this.confirmDialog(i18n.t('settings_reset_confirm_title'), i18n.t('settings_reset_confirm_desc'), i18n.t('delete'), i18n.t('cancel'));
      if (!ok) return;
      await DB.replaceAllCards([]);
      await DB.replaceAllHistory([]);
      await this.renderCardsList();
      this.toast(i18n.t('settings_reset'));
    });
  },

  renderSettingsCategories() {
    const el = document.getElementById('settings-category-list');
    el.innerHTML = '';
    this.categories.forEach((cat) => {
      const row = document.createElement('div');
      row.className = 'settings-category-row';
      const canDelete = !cat.builtin;
      const label = this.escapeHtml(this.categoryLabel(cat));
      row.innerHTML = `<span>${label}</span><div class="cat-row-actions"><button class="cat-rename-btn" aria-label="${i18n.t('rename')}">&#9998;</button>${canDelete ? `<button class="cat-delete-btn">${i18n.t('delete')}</button>` : ''}</div>`;

      row.querySelector('.cat-rename-btn').addEventListener('click', async () => {
        const current = this.categoryLabel(cat);
        const name = prompt(i18n.t('category_rename_prompt'), current);
        if (!name || !name.trim() || name.trim() === current) return;
        cat.name = name.trim();
        await DB.putCategory(cat);
        this.categories = await DB.getAllCategories();
        this.renderSettingsCategories();
        this.renderCategoryChips();
        this.renderCategorySelect();
        await this.renderCardsList();
        this.onDataChanged();
      });

      if (canDelete) {
        row.querySelector('.cat-delete-btn').addEventListener('click', async () => {
          const label2 = this.categoryLabel(cat);
          const otherCat = this.categories.find((c) => c.builtin === 'category_other' && c.id !== cat.id);
          const choice = await this.threeWayDialog(
            i18n.t('category_delete_choice_title'),
            i18n.t('category_delete_choice_desc', { name: label2 }),
            [
              { label: i18n.t('cancel'), value: 'cancel', className: 'btn-ghost' },
              { label: i18n.t('category_delete_move'), value: 'move', className: 'btn-secondary' },
              { label: i18n.t('category_delete_remove_cards'), value: 'delete', className: 'btn-danger' }
            ]
          );
          if (!choice || choice === 'cancel') return;
          const allCards = await DB.getAllCards();
          const affected = allCards.filter((c) => c.categoryId === cat.id);
          if (choice === 'move') {
            for (const c of affected) {
              c.categoryId = otherCat ? otherCat.id : c.categoryId;
              await DB.putCard(c);
            }
          } else if (choice === 'delete') {
            for (const c of affected) await DB.deleteCard(c.id);
          }
          await DB.deleteCategory(cat.id);
          this.categories = await DB.getAllCategories();
          this.renderSettingsCategories();
          this.renderCategoryChips();
          this.renderCategorySelect();
          await this.renderCardsList();
          this.onDataChanged();
        });
      }
      el.appendChild(row);
    });
  },

  async handleImportPayload(payload) {
    const isEmpty = await DB.isEmpty();
    let mode = 'merge';
    if (!isEmpty) {
      mode = await this.choiceDialog(i18n.t('import_merge_title'), i18n.t('import_merge_desc'), i18n.t('import_merge'), i18n.t('import_replace'));
    }
    await Backup.applyImport(payload, mode);
    this.categories = await DB.getAllCategories();
    if (this.categories.length === 0) await this.ensureDefaultCategories();
    this.categories = await DB.getAllCategories();
    this.renderCategoryChips();
    this.renderCategorySelect();
    this.renderSettingsCategories();
    await this.renderCardsList();
    this.toast(i18n.t('restore_action'));
  },

  updateBackupStatusUI() {
    const folderStatus = document.getElementById('folder-status');
    if (Backup.hasActiveFolderPermission()) {
      folderStatus.hidden = false;
      folderStatus.textContent = i18n.t('backup_folder_active', { folder: Backup.dirHandle.name });
    } else {
      folderStatus.hidden = true;
    }
    if (!Backup.supportsFS) {
      document.getElementById('choose-folder-btn').hidden = true;
    }
    DB.getSetting('lastBackupAt', null).then((ts) => {
      const el = document.getElementById('last-backup-status');
      el.textContent = ts ? i18n.t('backup_last', { date: this.formatLastUsed(ts) }) : i18n.t('backup_none_yet');
    });
  },

  async tryRestoreFolderAndCheckBackup() {
    const restored = await Backup.restorePersistedFolder();
    this.updateBackupStatusUI();
    const isEmpty = await DB.isEmpty();
    if (isEmpty && restored) {
      const latest = await Backup.findLatestBackupInFolder();
      if (latest) {
        const ok = await this.confirmDialog(
          i18n.t('restore_found_title'),
          i18n.t('restore_found_desc', { date: latest.data.createdAt ? this.formatLastUsed(new Date(latest.data.createdAt).getTime()) : latest.name }),
          i18n.t('restore_action'), i18n.t('restore_dismiss')
        );
        if (ok) await this.handleImportPayload(latest.data);
      }
    } else if (isEmpty && !Backup.supportsFS) {
      // iOS/unsupported: offer manual restore banner
      this.showBanner(i18n.t('restore_found_title'), i18n.t('backup_import'), [
        { label: i18n.t('restore_action'), action: () => document.getElementById('import-file-input').click() },
        { label: i18n.t('restore_dismiss'), action: () => {} }
      ]);
    }
  },

  // Called after any data mutation: schedules silent Android backup, or flags
  // "unsaved changes" reminder for iOS/unsupported browsers.
  onDataChanged() {
    if (Backup.hasActiveFolderPermission()) {
      Backup.scheduleDebouncedBackup();
      setTimeout(() => this.updateBackupStatusUI(), 8000);
    } else if (!Backup.supportsFS) {
      Backup.markDirty();
      this.maybeShowUnsavedReminder();
    }
  },

  _lastReminderAt: 0,
  maybeShowUnsavedReminder() {
    const now = Date.now();
    if (now - this._lastReminderAt < 5 * 60 * 1000) return; // don't spam
    this._lastReminderAt = now;
    this.showBanner(i18n.t('backup_reminder_title'), i18n.t('backup_reminder_desc'), [
      { label: i18n.t('backup_now'), action: async () => { await Backup.exportToFile(); this.updateBackupStatusUI(); } }
    ]);
  },

  // ---------------- Install prompt (iOS 7-day storage eviction warning) ----------------
  async maybeShowInstallPrompt() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isStandalone) return;
    const dismissed = await DB.getSetting('installPromptDismissed', false);
    if (dismissed) return;
    setTimeout(() => {
      this.showBanner(i18n.t('install_prompt_title'), i18n.t('install_prompt_desc') + ' ' + i18n.t('ios_install_steps'), [
        { label: i18n.t('install_dismiss'), action: () => DB.setSetting('installPromptDismissed', true) }
      ]);
    }, 1200);
  },

  // ---------------- Generic UI helpers ----------------
  showModal(id) { document.getElementById(id).hidden = false; },
  hideModal(id) { document.getElementById(id).hidden = true; },

  bindConfirmModal() {
    // handled dynamically via confirmDialog()
  },

  confirmDialog(title, desc, okLabel, cancelLabel) {
    return new Promise((resolve) => {
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-desc').textContent = desc;
      const okBtn = document.getElementById('confirm-ok-btn');
      const cancelBtn = document.getElementById('confirm-cancel-btn');
      okBtn.textContent = okLabel;
      cancelBtn.textContent = cancelLabel;
      const cleanup = () => {
        this.hideModal('modal-confirm');
        okBtn.replaceWith(okBtn.cloneNode(true));
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));
      };
      document.getElementById('confirm-ok-btn').addEventListener('click', () => { cleanup(); resolve(true); }, { once: true });
      document.getElementById('confirm-cancel-btn').addEventListener('click', () => { cleanup(); resolve(false); }, { once: true });
      this.showModal('modal-confirm');
    });
  },

  choiceDialog(title, desc, choiceALabel, choiceBLabel) {
    return new Promise((resolve) => {
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-desc').textContent = desc;
      const okBtn = document.getElementById('confirm-ok-btn');
      const cancelBtn = document.getElementById('confirm-cancel-btn');
      okBtn.textContent = choiceALabel;
      cancelBtn.textContent = choiceBLabel;
      const cleanup = () => {
        this.hideModal('modal-confirm');
        okBtn.replaceWith(okBtn.cloneNode(true));
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));
      };
      document.getElementById('confirm-ok-btn').addEventListener('click', () => { cleanup(); resolve('merge'); }, { once: true });
      document.getElementById('confirm-cancel-btn').addEventListener('click', () => { cleanup(); resolve('replace'); }, { once: true });
      this.showModal('modal-confirm');
    });
  },

  // Generic 2-or-3-button sheet. buttons: [{label, value, className}]. Resolves with the
  // clicked button's value. Rebuilds the confirm sheet's default two buttons afterwards so
  // confirmDialog()/choiceDialog() keep working normally on subsequent calls.
  threeWayDialog(title, desc, buttons) {
    return new Promise((resolve) => {
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-desc').textContent = desc;
      const btnRow = document.querySelector('#modal-confirm .btn-row');
      btnRow.innerHTML = '';
      buttons.forEach((b) => {
        const btn = document.createElement('button');
        btn.className = 'btn ' + (b.className || 'btn-ghost');
        btn.textContent = b.label;
        btn.addEventListener('click', () => {
          this.hideModal('modal-confirm');
          btnRow.innerHTML = this._confirmBtnRowTemplate;
          resolve(b.value);
        });
        btnRow.appendChild(btn);
      });
      this.showModal('modal-confirm');
    });
  },

  toast(msg) {
    const area = document.getElementById('banner-area');
    const el = document.createElement('div');
    el.className = 'banner toast';
    el.innerHTML = `<span>${this.escapeHtml(msg)}</span>`;
    area.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  },

  showBanner(title, desc, actions) {
    const area = document.getElementById('banner-area');
    const el = document.createElement('div');
    el.className = 'banner';
    el.innerHTML = `<strong>${this.escapeHtml(title)}</strong><p>${this.escapeHtml(desc)}</p>`;
    const actionsRow = document.createElement('div');
    actionsRow.className = 'banner-actions';
    actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.textContent = a.label;
      btn.addEventListener('click', async () => { await a.action(); el.remove(); });
      actionsRow.appendChild(btn);
    });
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => el.remove());
    actionsRow.appendChild(closeBtn);
    el.appendChild(actionsRow);
    area.appendChild(el);
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (App.theme === 'system') App.applyTheme(); });
