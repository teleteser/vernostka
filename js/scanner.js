// Vernostka scanner - camera-based code scanning
// Strategy:
// 1) If native BarcodeDetector API is available (Chrome/Android), use it - detects
//    QR + most 1D barcode formats natively and efficiently.
// 2) Otherwise (e.g. iOS Safari), fall back to jsQR for QR-code-only scanning from
//    a video frame. 1D barcodes on unsupported browsers fall back to manual entry,
//    which the UI offers prominently.

class Scanner {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.running = false;
    this.detector = null;
    this.rafId = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.currentFacing = 'environment';
  }

  static get supportsNativeDetector() {
    return 'BarcodeDetector' in window;
  }

  async start(onResult, onError, facingMode = 'environment') {
    this.currentFacing = facingMode;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode } },
        audio: false
      });
    } catch (err) {
      onError && onError(err);
      return false;
    }
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;

    if (Scanner.supportsNativeDetector) {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        this.detector = new BarcodeDetector({ formats });
      } catch (e) {
        this.detector = new BarcodeDetector();
      }
      this._loopNative(onResult, onError);
    } else {
      this._loopJsQR(onResult);
    }
    return true;
  }

  async _loopNative(onResult, onError) {
    if (!this.running) return;
    try {
      const codes = await this.detector.detect(this.video);
      if (codes && codes.length > 0) {
        const code = codes[0];
        this.stop();
        onResult({ value: code.rawValue, format: mapDetectorFormat(code.format) });
        return;
      }
    } catch (err) {
      // Non-fatal per-frame errors are common (e.g. video not ready yet); keep looping.
    }
    this.rafId = requestAnimationFrame(() => this._loopNative(onResult, onError));
  }

  _loopJsQR(onResult) {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState === v.HAVE_ENOUGH_DATA) {
      this.canvas.width = v.videoWidth;
      this.canvas.height = v.videoHeight;
      this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
      const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      // eslint-disable-next-line no-undef
      const result = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
      if (result && result.data) {
        this.stop();
        onResult({ value: result.data, format: 'QR' });
        return;
      }
    }
    this.rafId = requestAnimationFrame(() => this._loopJsQR(onResult));
  }

  async switchCamera(onResult, onError) {
    const next = this.currentFacing === 'environment' ? 'user' : 'environment';
    this.stop();
    return this.start(onResult, onError, next);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }
}

function mapDetectorFormat(fmt) {
  const map = {
    qr_code: 'QR',
    ean_13: 'EAN13',
    ean_8: 'EAN8',
    code_128: 'CODE128',
    code_39: 'CODE39',
    upc_a: 'UPC',
    upc_e: 'UPC'
  };
  return map[fmt] || 'CODE128';
}
