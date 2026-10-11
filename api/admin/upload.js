'use strict';

const { sendJson, requireAdmin, isSameOrigin } = require('../../lib/admin-auth');
const { getFile, putFile, putEncodedFile } = require('../../lib/github-repo');

const PRODUCT_MARKERS = {
  musang: ['MUSANG KING', 'BLACK THORN'],
  blackthorn: ['BLACK THORN', 'MONTHONG'],
  monthong: ['MONTHONG', 'DURIAN KUPAS'],
  kupas: ['DURIAN KUPAS', 'PANCAKE DURIAN'],
  pancake: ['PANCAKE DURIAN', 'PANCAKE ROLL'],
  pancakeroll: ['PANCAKE ROLL', null],
};

function replaceProductImage(html, productId, assetPath) {
  const markers = PRODUCT_MARKERS[productId];
  if (!markers) throw new Error('Produk tidak dikenal.');
  const startMarker = `<!-- ${markers[0]} -->`;
  const start = html.indexOf(startMarker);
  if (start < 0) throw new Error('Bagian produk tidak ditemukan.');
  const end = markers[1] ? html.indexOf(`<!-- ${markers[1]} -->`, start + startMarker.length) : html.indexOf('</section>', start + startMarker.length);
  if (end < 0) throw new Error('Bagian produk tidak lengkap.');
  let chunk = html.slice(start, end);
  let imageChanged = false;
  chunk = chunk.replace(/<img\b[^>]*>/gi, tag => {
    if (imageChanged || !/class=["']product-image["']/i.test(tag)) return tag;
    imageChanged = true;
    if (/src=["'][^"']*["']/i.test(tag)) return tag.replace(/(src=["'])[^"']*(["'])/i, `$1${assetPath}$2`);
    return tag;
  });
  if (!imageChanged) throw new Error('Foto produk tidak ditemukan.');
  chunk = chunk.replace(/(data-images='\s*\[\s*)["'][^"']+["']/i, `$1"${assetPath}"`);
  return html.slice(0, start) + chunk + html.slice(end);
}

function replaceHeroImage(html, assetPath) {
  const pattern = /(<div\s+class="hero-slider">[\s\S]*?<div\s+class="hero-slide active">[\s\S]*?<img\s+src=")[^"]+("[\s\S]*?<\/div>)/i;
  if (!pattern.test(html)) throw new Error('Foto banner utama tidak ditemukan.');
  return html.replace(pattern, `$1${assetPath}$2`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });
  if (!requireAdmin(req, res)) return;
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, message: 'Permintaan ditolak.' });

  try {
    const { target, productId, dataUrl } = req.body || {};
    if (target !== 'hero' && target !== 'product') return sendJson(res, 400, { ok: false, message: 'Tujuan upload tidak valid.' });
    if (target === 'product' && !PRODUCT_MARKERS[productId]) return sendJson(res, 400, { ok: false, message: 'Produk tidak dikenal.' });
    if (typeof dataUrl !== 'string' || dataUrl.length > 2900000) return sendJson(res, 413, { ok: false, message: 'Ukuran foto maksimal 2 MB.' });
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return sendJson(res, 400, { ok: false, message: 'Gunakan gambar JPG, PNG, atau WebP.' });
    const mime = match[1];
    const base64 = match[2];
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) return sendJson(res, 413, { ok: false, message: 'Ukuran foto maksimal 2 MB.' });
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp';
    const label = target === 'hero' ? 'hero' : productId;
    const path = `assets/admin-${label}-${Date.now()}.${ext}`;
    await putEncodedFile(path, bytes.toString('base64'), `Upload ${label} image from EGYA DURIAN Admin`);

    const file = await getFile('index.html');
    const html = target === 'hero' ? replaceHeroImage(file.content, path) : replaceProductImage(file.content, productId, path);
    await putFile('index.html', html, `Update ${label} image from EGYA DURIAN Admin`, file.sha);
    return sendJson(res, 200, { ok: true, path, message: 'Foto diunggah dan website diperbarui. Vercel akan menerbitkannya otomatis.' });
  } catch (error) {
    const status = error.status === 409 || error.status === 422 ? 409 : (error.status || 500);
    return sendJson(res, status, { ok: false, message: error.message || 'Upload gagal.' });
  }
};
