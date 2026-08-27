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

// ZXing detects far more reliably when told exactly which formats to look for, instead of
// its "try everything" default - and 1D barcodes especially need a higher-resolution camera
// stream than the browser's default (which is tuned for video calls, not fine bar patterns).
const SCAN_FORMATS = [
  'QR_CODE', 'EAN_13', 'EAN_8', 'CODE_128', 'CODE_39', 'UPC_A', 'UPC_E', 'ITF', 'CODABAR'
];

function buildScanHints() {
  const hints = new Map();
  const formats = SCAN_FORMATS.map((name) => ZXing.BarcodeFormat[name]).filter((v) => v !== undefined);
  if (formats.length) hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  return hints;
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
      this.reader = new ZXing.BrowserMultiFormatReader(buildScanHints());
      const constraints = {
        video: {
          facingMode: { ideal: facingMode },
          // A wider frame gives 1D barcodes (which need many more horizontal pixels than a
          // QR code of similar physical size) enough resolution to decode reliably.
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      };
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

  // Decodes a barcode/QR code from a still image file (e.g. a photo taken of a damaged or
  // hard-to-scan code) instead of the live camera feed - often succeeds where continuous
  // video scanning struggles, since the user can frame/focus the shot themselves.
  static async decodeFromFile(file) {
    if (!Scanner.available) throw new Error('scanner-lib-unavailable');
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
    const reader = new ZXing.BrowserMultiFormatReader(buildScanHints());
    const result = await reader.decodeFromImageUrl(dataUrl);
    return { value: result.getText(), format: mapZXingFormat(result.getBarcodeFormat()) };
  }
}
