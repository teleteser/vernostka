// Vernostka codegen - render barcodes/QR codes, guess code type from manual input
const CODE_TYPES = ['QR', 'EAN13', 'EAN8', 'CODE128', 'CODE39', 'UPC'];

// The bundled QRCode.js (davidshimjs/qrcode.js) has a long-standing bug: it doesn't correctly
// handle multi-byte Unicode characters (accented letters like a Slovak "ť", "š", "č"...),
// which can throw during generation or produce a broken code. The standard workaround is to
// pre-convert the string into a "UTF-8 byte string" (each output character represents one
// raw UTF-8 byte) before handing it to the library - this is what actually makes its
// byte-mode QR encoding work correctly for any language, not just plain ASCII.
function utf8ByteString(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c <= 0x7f) {
      out += str.charAt(i);
    } else if (c <= 0x7ff) {
      out += String.fromCharCode(0xc0 | (c >> 6));
      out += String.fromCharCode(0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // surrogate pair (emoji etc.) - combine into a single code point first
      i++;
      const c2 = str.charCodeAt(i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out += String.fromCharCode(0xf0 | (cp >> 18));
      out += String.fromCharCode(0x80 | ((cp >> 12) & 0x3f));
      out += String.fromCharCode(0x80 | ((cp >> 6) & 0x3f));
      out += String.fromCharCode(0x80 | (cp & 0x3f));
    } else {
      out += String.fromCharCode(0xe0 | (c >> 12));
      out += String.fromCharCode(0x80 | ((c >> 6) & 0x3f));
      out += String.fromCharCode(0x80 | (c & 0x3f));
    }
  }
  return out;
}

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

// Makes a rendered barcode <svg> scale fluidly to fill its container both horizontally and
// vertically (rather than preserving its natural thin aspect ratio), by converting its fixed
// pixel size into a viewBox and letting CSS stretch it. Barcodes are safe to stretch this way
// since a scanner reads the pattern of bar widths along a horizontal line - taller bars don't
// change what's encoded, they just make the code easier to scan on-screen.
function makeSvgResponsive(svg) {
  let w = null;
  let h = null;
  // getBBox() measures the actual rendered geometry and is more reliable across browsers/
  // timing than reading the width/height presentation attributes JsBarcode set.
  try {
    const bbox = svg.getBBox();
    if (bbox && bbox.width && bbox.height) { w = bbox.width; h = bbox.height; }
  } catch (e) { /* element may not be rendered yet - fall back below */ }
  if (!w || !h) {
    w = svg.width && svg.width.baseVal ? svg.width.baseVal.value : null;
    h = svg.height && svg.height.baseVal ? svg.height.baseVal.value : null;
  }
  if (w && h) {
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
  }
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.display = 'block';
}

// Renders a code into the given container element, clearing it first.
// type: one of CODE_TYPES. value: the raw code string.
// options.responsive: if true, the code fluidly fills the container (and, for QR, the
// container becomes a perfect square via CSS aspect-ratio - see .code-square in style.css;
// for barcodes, the container gets a tall minimum height - see .code-tall in style.css).
// options.correctLevel: QR error-correction level ('L'|'M'|'Q'|'H'), defaults to 'M'.
function renderCode(container, value, type, options = {}) {
  container.innerHTML = '';
  container.classList.remove('code-square', 'code-tall');
  if (!value) return;
  const t = type || guessCodeType(value);
  try {
    if (t === 'QR') {
      const holder = document.createElement('div');
      holder.className = 'qr-holder';
      container.appendChild(holder);
      const level = (options.correctLevel || 'M').toUpperCase();
      // eslint-disable-next-line no-undef
      new QRCode(holder, {
        text: utf8ByteString(value),
        width: options.width || 300,
        height: options.height || 300,
        correctLevel: QRCode.CorrectLevel[level] || QRCode.CorrectLevel.M
      });
      if (options.responsive) container.classList.add('code-square');
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
      if (options.responsive) {
        container.classList.add('code-tall');
        makeSvgResponsive(svg);
      }
    }
  } catch (err) {
    // Fallback: if format-specific rendering fails (e.g. invalid EAN checksum), use CODE128,
    // which accepts arbitrary ASCII and therefore always succeeds for scanned/typed values.
    console.warn('renderCode fallback to CODE128', err);
    try {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      container.innerHTML = '';
      container.appendChild(svg);
      // eslint-disable-next-line no-undef
      JsBarcode(svg, value, { format: 'CODE128', height: options.height || 120, margin: 8, background: 'transparent' });
      if (options.responsive) {
        container.classList.add('code-tall');
        makeSvgResponsive(svg);
      }
    } catch (err2) {
      container.innerHTML = `<div class="code-render-error">${value}</div>`;
    }
  }
}
