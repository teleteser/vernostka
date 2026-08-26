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

// Makes a rendered barcode <svg> scale fluidly to its container's width while preserving
// aspect ratio, by converting its fixed pixel size into a viewBox.
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
  svg.style.width = '100%';
  svg.style.height = 'auto';
  svg.style.display = 'block';
}

// Renders a code into the given container element, clearing it first.
// type: one of CODE_TYPES. value: the raw code string.
// options.responsive: if true, the code fluidly fills the container's width (and, for QR,
// the container becomes a perfect square via CSS aspect-ratio - see .code-square in style.css).
function renderCode(container, value, type, options = {}) {
  container.innerHTML = '';
  container.classList.remove('code-square');
  if (!value) return;
  const t = type || guessCodeType(value);
  try {
    if (t === 'QR') {
      const holder = document.createElement('div');
      holder.className = 'qr-holder';
      container.appendChild(holder);
      // eslint-disable-next-line no-undef
      new QRCode(holder, {
        text: value,
        width: options.width || 300,
        height: options.height || 300,
        correctLevel: QRCode.CorrectLevel.M
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
      if (options.responsive) makeSvgResponsive(svg);
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
      if (options.responsive) makeSvgResponsive(svg);
    } catch (err2) {
      container.innerHTML = `<div class="code-render-error">${value}</div>`;
    }
  }
}
