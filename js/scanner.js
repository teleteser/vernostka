// Vernostka scanner - camera-based code scanning using ZXing (robust multi-format decoder,
// works consistently across Chrome/Safari/Firefox, unlike the native BarcodeDetector API
// which is Chrome/Android-only and misses many real-world barcode variants).

const ZXING_FORMAT_MAP = {
  QR_CODE: 'QR',
  EAN_13: 'EAN13',
  EAN_8: 'EAN8',
  CODE_128: 'CODE128',
  CODE_39: 'CODE39',
  UPC_A: 'UPC',
  UPC_E: 'UPC'
  // Any other decoded format (CODABAR, ITF, DATA_MATRIX, PDF_417, AZTEC, RSS...) falls back
  // to CODE128 for re-rendering, since CODE128 can encode arbitrary ASCII text/numbers and
  // therefore still reproduces the scanned value faithfully even if the original symbology
  // isn't one we can draw ourselves.
};

function mapZXingFormat(formatEnumValue) {
  try {
    const name = ZXing.BarcodeFormat[formatEnumValue]; // reverse lookup enum name
    return ZXING_FORMAT_MAP[name] || 'CODE128';
  } catch (e) {
    return 'CODE128';
  }
}

class Scanner {
  constructor(videoEl) {
    this.video = videoEl;
    this.reader = null;
    this.controls = null;
    this.currentFacing = 'environment';
  }

  static get available() {
    return typeof ZXing !== 'undefined' && !!ZXing.BrowserMultiFormatReader;
  }

  async start(onResult, onError, facingMode = 'environment') {
    this.currentFacing = facingMode;
    if (!Scanner.available) {
      onError && onError(new Error('scanner-lib-unavailable'));
      return false;
    }
    try {
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      this.reader = new ZXing.BrowserMultiFormatReader(hints);
      const constraints = { video: { facingMode: { ideal: facingMode } }, audio: false };
      await this.reader.decodeFromConstraints(constraints, this.video, (result, err, controls) => {
        this.controls = controls;
        if (result) {
          const value = result.getText();
          const format = mapZXingFormat(result.getBarcodeFormat());
          this.stop();
          onResult({ value, format });
        }
        // err fires ~every frame with a "not found yet" exception - that's expected, ignore it.
      });
      return true;
    } catch (err) {
      onError && onError(err);
      return false;
    }
  }

  async switchCamera(onResult, onError) {
    const next = this.currentFacing === 'environment' ? 'user' : 'environment';
    this.stop();
    return this.start(onResult, onError, next);
  }

  stop() {
    if (this.controls) {
      try { this.controls.stop(); } catch (e) { /* already stopped */ }
      this.controls = null;
    }
    if (this.reader) {
      try { this.reader.reset(); } catch (e) { /* ignore */ }
    }
    if (this.video) this.video.srcObject = null;
  }
}
