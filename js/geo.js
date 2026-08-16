// Vernostka geo - Leaflet-based location picking + distance helpers
const Geo = {
  _map: null,
  _marker: null,

  async getCurrentPosition(timeout = 8000) {
    if (!navigator.geolocation) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout);
      navigator.geolocation.getCurrentPosition(
        (pos) => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
        () => { clearTimeout(timer); resolve(null); },
        { enableHighAccuracy: false, timeout }
      );
    });
  },

  distanceKm(a, b) {
    if (!a || !b) return Infinity;
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  },

  nearestLocation(userPos, locations) {
    if (!userPos || !locations || locations.length === 0) return Infinity;
    let min = Infinity;
    locations.forEach((loc) => {
      const d = this.distanceKm(userPos, loc);
      if (d < min) min = d;
    });
    return min;
  },

  // Initializes (or re-initializes) a Leaflet map in the given container for picking a point.
  // Calls onPick(lat, lng) whenever the user taps the map.
  async initPicker(containerEl, initialPos, onPick) {
    this.destroyPicker();
    const start = initialPos || (await this.getCurrentPosition()) || { lat: 48.6, lng: 19.5 }; // Slovakia-ish default
    // eslint-disable-next-line no-undef
    this._map = L.map(containerEl).setView([start.lat, start.lng], initialPos ? 16 : 7);
    // eslint-disable-next-line no-undef
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(this._map);

    if (initialPos) this._setMarker(initialPos.lat, initialPos.lng);

    this._map.on('click', (e) => {
      this._setMarker(e.latlng.lat, e.latlng.lng);
      onPick(e.latlng.lat, e.latlng.lng);
    });
    // Leaflet needs a resize kick when its container becomes visible after being display:none
    setTimeout(() => this._map && this._map.invalidateSize(), 150);
    return this._map;
  },

  _setMarker(lat, lng) {
    // eslint-disable-next-line no-undef
    if (this._marker) this._marker.setLatLng([lat, lng]);
    // eslint-disable-next-line no-undef
    else this._marker = L.marker([lat, lng]).addTo(this._map);
  },

  centerOn(lat, lng) {
    if (this._map) {
      this._map.setView([lat, lng], 16);
      this._setMarker(lat, lng);
    }
  },

  destroyPicker() {
    if (this._map) {
      this._map.remove();
      this._map = null;
      this._marker = null;
    }
  }
};

// ---- Logo lookup ----
// Guesses a domain from a store name and fetches its favicon, returning a data: URL
// (base64) so it can be persisted in IndexedDB and used fully offline afterwards.
const LogoLookup = {
  guessDomain(storeName) {
    const slug = storeName
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .replace(/[^a-z0-9]/g, '');
    if (!slug) return null;
    return `${slug}.com`;
  },

  async fetchLogoAsDataUrl(storeName) {
    const domain = this.guessDomain(storeName);
    if (!domain || !navigator.onLine) return null;
    const faviconUrl = `https://www.google.com/s2/favicons?sz=128&domain=${domain}`;
    try {
      const res = await fetch(faviconUrl);
      if (!res.ok) return null;
      const blob = await res.blob();
      if (blob.size < 200) return null; // likely a generic/blank placeholder icon
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      return null;
    }
  }
};
