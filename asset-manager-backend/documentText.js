// documentText.js: reads the text of a scanned archive document, so search can find words inside it.
//
// A PDF made by a scanner that already recognised the text carries it inside the file: that text
// is taken as it is (fast and exact). A PDF that is only pictures, and a JPG or PNG, go through
// text recognition (OCR) in Arabic and English, one page at a time.

const fs = require('fs');
const path = require('path');

let createWorker = null;
try {
  createWorker = require('tesseract.js').createWorker;
} catch { /* OCR not installed: picture-only scans get no text */ }

const OCR_LANGS = ['ara', 'eng'];
const OCR_SCALE = 2.5;        // PDF points to pixels: an A4 page becomes about 1500 x 2100 px
const MAX_OCR_PAGES = 60;     // a longer picture-only PDF has its first 60 pages read
const MIN_CHARS_PER_PAGE = 25; // less text than this in a PDF means the pages are pictures

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

// The 14 standard PDF fonts (Helvetica, Times…), which PDFs use without embedding them.
// pdf.js wants this as a URL-style path ending in "/".
const STANDARD_FONTS = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')
  .split(path.sep).join('/') + '/';

async function openPdf(data) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONTS,
    verbosity: 0,
  }).promise;
}

// The text a PDF carries, page by page
async function pdfOwnText(doc) {
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.map((i) => i.str).join(' '));
    page.cleanup();
  }
  return pages;
}

// One page of a PDF as a PNG image (scale 1 = 72 pixels per inch)
async function renderPage(doc, pageNumber, scale = OCR_SCALE) {
  const { createCanvas } = require('@napi-rs/canvas');
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  page.cleanup();
  return canvas.toBuffer('image/png');
}

async function newOcrWorker(cachePath) {
  if (!createWorker) throw new Error('Text recognition (tesseract.js) is not installed on the server');
  try {
    return await createWorker(OCR_LANGS, 1, { cachePath, logger: () => {} });
  } catch (e) {
    throw new Error(`Text recognition could not start (it downloads its Arabic and English data on first use): ${e.message}`);
  }
}

const tidy = (s) => String(s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

// Returns { text, pages, method }, method being 'pdf-text', 'ocr' or 'none'.
async function readDocumentText(filePath, mimeType, { cachePath } = {}) {
  const data = await fs.promises.readFile(filePath);

  if (mimeType === 'application/pdf') {
    const doc = await openPdf(data);
    try {
      const own = await pdfOwnText(doc);
      const ownChars = own.join('').replace(/\s/g, '').length;
      if (ownChars >= MIN_CHARS_PER_PAGE * doc.numPages) {
        return { text: tidy(own.join('\n\n')), pages: doc.numPages, method: 'pdf-text' };
      }
      // Pictures only: recognise the text on each page
      const worker = await newOcrWorker(cachePath);
      try {
        const texts = [];
        const last = Math.min(doc.numPages, MAX_OCR_PAGES);
        for (let p = 1; p <= last; p++) {
          const png = await renderPage(doc, p);
          const { data: result } = await worker.recognize(png);
          texts.push(result.text);
        }
        const text = tidy(texts.join('\n\n'));
        return { text, pages: doc.numPages, method: text ? 'ocr' : 'none' };
      } finally {
        await worker.terminate();
      }
    } finally {
      await doc.destroy();
    }
  }

  // JPG or PNG
  const worker = await newOcrWorker(cachePath);
  try {
    const { data: result } = await worker.recognize(data);
    const text = tidy(result.text);
    return { text, pages: 1, method: text ? 'ocr' : 'none' };
  } finally {
    await worker.terminate();
  }
}

// A PDF page as a PNG about `width` pixels wide, for showing in the browser (browsers on iPads,
// and some others, can't show a PDF inside a page). Returns { pages, png }; png is null when
// the page doesn't exist.
async function renderPdfPage(filePath, pageNumber, width) {
  const doc = await openPdf(await fs.promises.readFile(filePath));
  try {
    if (pageNumber < 1 || pageNumber > doc.numPages) return { pages: doc.numPages, png: null };
    const page = await doc.getPage(pageNumber);
    const scale = width / page.getViewport({ scale: 1 }).width;
    page.cleanup();
    return { pages: doc.numPages, png: await renderPage(doc, pageNumber, scale) };
  } finally {
    await doc.destroy();
  }
}

async function pdfPageCount(filePath) {
  const doc = await openPdf(await fs.promises.readFile(filePath));
  try {
    return doc.numPages;
  } finally {
    await doc.destroy();
  }
}

module.exports = { readDocumentText, renderPdfPage, pdfPageCount };
