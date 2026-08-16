// Vernostka codegen - render barcodes/QR codes, guess code type from manual input
const CODE_TYPES = ['QR', 'EAN13', 'EAN8', 'CODE128', 'CODE39', 'UPC'];

function guessCodeType(value) {
  const v = (value || '').trim();
  if (!v) return 'CODE128';
  const digitsOnly = /^\d+$/.test(v);
  if (digitsOnly) {
    if (v.length === 13) return 'EAN13';
    if (v.length === 8) return 'EAN8';
    if (v.length === 12) return 'UPC';
    if (v.length === 6 || v.length === 39) return 'CODE39';
  }
  if (v.length > 20 || /[^A-Za-z0-9\-. $/+%]/.test(v)) return 'QR';
  return 'CODE128';
}

// Renders a code into the given container element, clearing it first.
// type: one of CODE_TYPES. value: the raw code string.
function renderCode(container, value, type, options = {}) {
  container.innerHTML = '';
  if (!value) return;
  const t = type || guessCodeType(value);
  try {
    if (t === 'QR') {
      const div = document.createElement('div');
      container.appendChild(div);
      // eslint-disable-next-line no-undef
      new QRCode(div, {
        text: value,
        width: options.width || 260,
        height: options.height || 260,
        correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      container.appendChild(svg);
      let format = 'CODE128';
      if (t === 'EAN13') format = 'EAN13';
      else if (t === 'EAN8') format = 'EAN8';
      else if (t === 'UPC') format = 'UPC';
      else if (t === 'CODE39') format = 'CODE39';
      // eslint-disable-next-line no-undef
      JsBarcode(svg, value, {
        format,
        width: options.barWidth || 2.5,
        height: options.height || 120,
        displayValue: options.displayValue !== false,
        margin: 8,
        background: 'transparent'
      });
    }
  } catch (err) {
    // Fallback: if format-specific rendering fails (e.g. invalid EAN checksum), use CODE128
    console.warn('renderCode fallback to CODE128', err);
    try {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      container.innerHTML = '';
      container.appendChild(svg);
      // eslint-disable-next-line no-undef
      JsBarcode(svg, value, { format: 'CODE128', height: options.height || 120, margin: 8, background: 'transparent' });
    } catch (err2) {
      container.innerHTML = `<div class="code-render-error">${value}</div>`;
    }
  }
}
