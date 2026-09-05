// Vernostka scanner - hybrid detection strategy:
// 1) Native BarcodeDetector API (Chrome/Android) is tried first when available - it's
//    hardware-accelerated and considerably more reliable at reading real-world 1D barcodes
//    than any JS decoder.
// 2) ZXing (works on every browser, including iOS Safari where BarcodeDetector doesn't
//    exist) is used as the universal fallback for live scanning, and also for decoding a
//    still photo the user took as a last resort.

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

const NATIVE_FORMAT_MAP = {
  qr_code: 'QR',
  ean_13: 'EAN13',
  ean_8: 'EAN8',
  code_128: 'CODE128',
  code_39: 'CODE39',
  upc_a: 'UPC',
  upc_e: 'UPC'
};
function mapNativeFormat(fmt) {
  return NATIVE_FORMAT_MAP[fmt] || 'CODE128';
}

const DESIRED_FORMATS_NATIVE = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf', 'codabar'];
const DESIRED_FORMATS_ZXING = ['QR_CODE', 'EAN_13', 'EAN_8', 'CODE_128', 'CODE_39', 'UPC_A', 'UPC_E', 'ITF', 'CODABAR'];

function buildZXingHints() {
  const hints = new Map();
  const formats = DESIRED_FORMATS_ZXING.map((name) => ZXing.BarcodeFormat[name]).filter((v) => v !== undefined);
  if (formats.length) hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  return hints;
}

class Scanner {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.running = false;
    this.nativeDetector = null;
    this.rafId = null;
    this.zxingReader = null;
    this.zxingControls = null;
    this.currentFacing = 'environment';
    // In continuous mode the camera keeps running after a code is read, so a multi-part QR
    // transfer can collect frame after frame without restarting (and re-focusing) the
    // camera between them. The same code seen again is only reported once per second.
    this.continuous = false;
    this._lastValue = null;
    this._lastValueAt = 0;
  }

  static get hasNative() { return 'BarcodeDetector' in window; }
  static get hasZXing() { return typeof ZXing !== 'undefined' && !!ZXing.BrowserMultiFormatReader; }
  static get available() { return Scanner.hasNative || Scanner.hasZXing; }

  _shouldReport(value) {
    const now = Date.now();
    // The same code stays in front of the camera for as long as the other phone shows it
    // (about 2 seconds), and it is detected many times per second. Report it only once -
    // otherwise the same transfer frame is handled (and the phone buzzes) repeatedly.
    if (value === this._lastValue && now - this._lastValueAt < 5000) {
      this._lastValueAt = now;
      return false;
    }
    this._lastValue = value;
    this._lastValueAt = now;
    return true;
  }

  async start(onResult, onError, facingMode = 'environment') {
    this.currentFacing = facingMode;
    const constraints = {
      video: {
        facingMode: { ideal: facingMode },
        // 1D barcodes need considerably more horizontal resolution than a QR code of similar
        // physical size to decode reliably - request a wide frame instead of the browser's
        // (video-call-tuned, usually low-res) default.
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    };

    if (Scanner.hasNative) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.video.srcObject = this.stream;
        await this.video.play();
        this.running = true;
        try {
          const supported = await BarcodeDetector.getSupportedFormats();
          const formats = DESIRED_FORMATS_NATIVE.filter((f) => supported.includes(f));
          this.nativeDetector = new BarcodeDetector({ formats: formats.length ? formats : supported });
        } catch (e) {
          this.nativeDetector = new BarcodeDetector();
        }
        this._loopNative(onResult);
        return true;
      } catch (err) {
        onError && onError(err);
        return false;
      }
    }

    if (!Scanner.hasZXing) {
      onError && onError(new Error('scanner-lib-unavailable'));
      return false;
    }
    try {
      this.running = true;
      this.zxingReader = new ZXing.BrowserMultiFormatReader(buildZXingHints());
      await this.zxingReader.decodeFromConstraints(constraints, this.video, (result, err, controls) => {
        this.zxingControls = controls;
        if (result) {
          const value = result.getText();
          const format = mapZXingFormat(result.getBarcodeFormat());
          if (this.continuous) {
            if (this._shouldReport(value)) onResult({ value, format });
          } else {
            this.stop();
            onResult({ value, format });
          }
        }
        // err fires ~every frame with a "not found yet" exception - that's expected, ignore it.
      });
      return true;
    } catch (err) {
      onError && onError(err);
      return false;
    }
  }

  async _loopNative(onResult) {
    if (!this.running) return;
    try {
      const codes = await this.nativeDetector.detect(this.video);
      if (codes && codes.length > 0) {
        const code = codes[0];
        if (this.continuous) {
          if (this._shouldReport(code.rawValue)) onResult({ value: code.rawValue, format: mapNativeFormat(code.format) });
        } else {
          this.stop();
          onResult({ value: code.rawValue, format: mapNativeFormat(code.format) });
          return;
        }
      }
    } catch (e) {
      // Transient per-frame errors (e.g. video not ready yet) are normal - keep looping.
    }
    this.rafId = requestAnimationFrame(() => this._loopNative(onResult));
  }

  async switchCamera(onResult, onError) {
    const next = this.currentFacing === 'environment' ? 'user' : 'environment';
    this.stop();
    return this.start(onResult, onError, next);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.nativeDetector = null;
    if (this.zxingControls) {
      try { this.zxingControls.stop(); } catch (e) { /* already stopped */ }
      this.zxingControls = null;
    }
    if (this.zxingReader) {
      try { this.zxingReader.reset(); } catch (e) { /* ignore */ }
      this.zxingReader = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }

  // Decodes a barcode/QR code from a still image file (e.g. a photo taken of a damaged or
  // hard-to-scan code). Tries the native detector first (usually more accurate), then ZXing.
  static async decodeFromFile(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('image-load-failed'));
      image.src = dataUrl;
    });

    if (Scanner.hasNative) {
      try {
        const detector = new BarcodeDetector();
        const codes = await detector.detect(img);
        if (codes && codes.length > 0) {
          return { value: codes[0].rawValue, format: mapNativeFormat(codes[0].format) };
        }
      } catch (e) {
        // fall through to ZXing below
      }
    }
    if (Scanner.hasZXing) {
      const reader = new ZXing.BrowserMultiFormatReader(buildZXingHints());
      const result = await reader.decodeFromImage(img);
      return { value: result.getText(), format: mapZXingFormat(result.getBarcodeFormat()) };
    }
    throw new Error('no-scanner-available');
  }
}
