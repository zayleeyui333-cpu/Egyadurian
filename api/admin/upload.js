'use strict';

const { sendJson, requireAdmin, isSameOrigin } = require('../../lib/admin-auth');
const { getFile, putFile, putEncodedFile } = require('../../lib/github-repo');

const STATIC_PRODUCTS = {
  'MUSANG KING': 'musang',
  'BLACK THORN': 'blackthorn',
  'MONTHONG': 'monthong',
  'DURIAN KUPAS': 'kupas',
  'PANCAKE DURIAN': 'pancake',
  'PANCAKE ROLL': 'pancakeroll',
};
const PRODUCT_MARKER_RE = /<!--\s*(?:(MUSANG KING|BLACK THORN|MONTHONG|DURIAN KUPAS|PANCAKE DURIAN|PANCAKE ROLL)|ADMIN PRODUCT\s+id=["']([a-z0-9_-]{1,64})["'])\s*-->/gi;
function decodeHtml(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function htmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function getAttribute(openTag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = openTag.match(new RegExp(`\\b${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]) : '';
}
function setAttribute(openTag, name, value) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const replacement = `${name}="${htmlEscape(value)}"`;
  if (pattern.test(openTag)) return openTag.replace(pattern, replacement);
  return openTag.replace(/>$/, ` ${replacement}>`);
}
function getProductSection(html) {
  const match = html.match(/<section\b(?=[^>]*\bid=["']products["'])[\s\S]*?<\/section>/i);
  if (!match) throw new Error('Bagian produk tidak ditemukan.');
  return { text: match[0], start: match.index, end: match.index + match[0].length };
}
function locateProductBlock(section, productId) {
  const closeIndex = section.toLowerCase().lastIndexOf('</section>');
  const searchable = section.slice(0, closeIndex < 0 ? section.length : closeIndex);
  const markers = [...searchable.matchAll(PRODUCT_MARKER_RE)];
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index];
    const id = marker[1] ? STATIC_PRODUCTS[marker[1].toUpperCase()] : marker[2].toLowerCase();
    if (id !== productId) continue;
    const end = index + 1 < markers.length ? markers[index + 1].index : (closeIndex < 0 ? section.length : closeIndex);
    return { start: marker.index, end, text: section.slice(marker.index, end) };
  }
  throw new Error('Produk tidak ditemukan. Simpan produk baru terlebih dahulu, lalu muat ulang panel admin.');
}
function replaceProductImage(html, productId, assetPath) {
  const region = getProductSection(html);
  const block = locateProductBlock(region.text, productId);
  const imagePattern = /<img\b(?=[^>]*\bclass=["'][^"']*\bproduct-image\b[^"']*["'])[^>]*>/i;
  const imageMatch = block.text.match(imagePattern);
  if (!imageMatch) throw new Error('Foto produk tidak ditemukan.');
  const updatedImageTag = setAttribute(imageMatch[0], 'src', assetPath);
  let updatedBlock = block.text.replace(imageMatch[0], updatedImageTag);

  const cardPattern = /<div\b(?=[^>]*\bclass=["'][^"']*\bproduct-card\b[^"']*["'])[^>]*>/i;
  const cardMatch = updatedBlock.match(cardPattern);
  if (!cardMatch) throw new Error('Card produk tidak ditemukan.');
  let images = [];
  try { images = JSON.parse(getAttribute(cardMatch[0], 'data-images') || '[]'); } catch { images = []; }
  if (!Array.isArray(images)) images = [];
  if (STATIC_PRODUCTS[Object.keys(STATIC_PRODUCTS).find(marker => STATIC_PRODUCTS[marker] === productId)]) {
    if (!images.length) images = [assetPath];
    else images[0] = assetPath;
  } else {
    images = [assetPath];
  }
  const updatedCardTag = setAttribute(cardMatch[0], 'data-images', JSON.stringify(images));
  updatedBlock = updatedBlock.replace(cardMatch[0], updatedCardTag);

  const updatedSection = region.text.slice(0, block.start) + updatedBlock + region.text.slice(block.end);
  return html.slice(0, region.start) + updatedSection + html.slice(region.end);
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
    if (target === 'product' && (typeof productId !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(productId))) return sendJson(res, 400, { ok: false, message: 'ID produk tidak valid.' });
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
