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
const MAX_IMAGES_PER_PRODUCT = 10;
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
    if (id !== productId.toLowerCase()) continue;
    const end = index + 1 < markers.length ? markers[index + 1].index : (closeIndex < 0 ? section.length : closeIndex);
    return { start: marker.index, end, text: section.slice(marker.index, end) };
  }
  throw new Error('Produk tidak ditemukan. Simpan produk terlebih dahulu, lalu muat ulang panel admin.');
}
function parseImageList(cardOpenTag, imageOpenTag) {
  let images = [];
  try {
    const parsed = JSON.parse(getAttribute(cardOpenTag, 'data-images') || '[]');
    if (Array.isArray(parsed)) images = parsed.filter(item => typeof item === 'string' && item.trim()).slice(0, MAX_IMAGES_PER_PRODUCT);
  } catch { images = []; }
  const primary = getAttribute(imageOpenTag, 'src');
  if (!images.length && primary) images = [primary];
  return images;
}
function updateProductImageList(html, productId, assetPath, operation, imageIndex) {
  const region = getProductSection(html);
  const block = locateProductBlock(region.text, productId);
  const imagePattern = /<img\b(?=[^>]*\bclass=["'][^"']*\bproduct-image\b[^"']*["'])[^>]*>/i;
  const imageMatch = block.text.match(imagePattern);
  if (!imageMatch) throw new Error('Foto utama produk tidak ditemukan.');
  const cardPattern = /<div\b(?=[^>]*\bclass=["'][^"']*\bproduct-card\b[^"']*["'])[^>]*>/i;
  const cardMatch = block.text.match(cardPattern);
  if (!cardMatch) throw new Error('Card produk tidak ditemukan.');

  let images = parseImageList(cardMatch[0], imageMatch[0]);
  if (operation === 'add') {
    if (images.length >= MAX_IMAGES_PER_PRODUCT) throw new Error(`Maksimal ${MAX_IMAGES_PER_PRODUCT} foto per produk.`);
    images.push(assetPath);
  } else {
    if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= images.length) {
      throw new Error('Nomor foto yang ingin diganti tidak valid. Muat ulang panel admin dan coba lagi.');
    }
    images[imageIndex] = assetPath;
  }

  let updatedBlock = block.text;
  if (operation === 'replace' && imageIndex === 0) {
    updatedBlock = updatedBlock.replace(imageMatch[0], setAttribute(imageMatch[0], 'src', assetPath));
  }
  const updatedCardMatch = updatedBlock.match(cardPattern);
  if (!updatedCardMatch) throw new Error('Card produk tidak ditemukan setelah pembaruan foto.');
  updatedBlock = updatedBlock.replace(updatedCardMatch[0], setAttribute(updatedCardMatch[0], 'data-images', JSON.stringify(images)));
  const updatedSection = region.text.slice(0, block.start) + updatedBlock + region.text.slice(block.end);
  return { html: html.slice(0, region.start) + updatedSection + html.slice(region.end), imagesCount: images.length };
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
    const operation = target === 'product' ? (req.body.operation || 'replace') : (target === 'gallery' ? (req.body.operation || 'stage') : 'replace');
    const imageIndex = req.body.imageIndex === undefined ? 0 : Number(req.body.imageIndex);
    if (!['hero', 'product', 'gallery'].includes(target)) return sendJson(res, 400, { ok: false, message: 'Tujuan upload tidak valid.' });
    if (target === 'product' && (typeof productId !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(productId))) return sendJson(res, 400, { ok: false, message: 'ID produk tidak valid.' });
    if (target === 'product' && !['replace', 'add'].includes(operation)) return sendJson(res, 400, { ok: false, message: 'Aksi foto tidak valid.' });
    if (target === 'gallery' && operation !== 'stage') return sendJson(res, 400, { ok: false, message: 'Aksi foto galeri website tidak valid.' });
    if (target === 'product' && operation === 'replace' && (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= MAX_IMAGES_PER_PRODUCT)) return sendJson(res, 400, { ok: false, message: 'Nomor foto tidak valid.' });
    if (typeof dataUrl !== 'string' || dataUrl.length > 2900000) return sendJson(res, 413, { ok: false, message: 'Ukuran foto maksimal 2 MB.' });
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return sendJson(res, 400, { ok: false, message: 'Gunakan gambar JPG, PNG, atau WebP.' });
    const mime = match[1];
    const base64 = match[2];
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) return sendJson(res, 413, { ok: false, message: 'Ukuran foto maksimal 2 MB.' });
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp';
    const safeLabel = target === 'hero' ? 'hero' : (target === 'gallery' ? 'gallery' : productId.toLowerCase());
    const assetPath = `assets/admin-${safeLabel}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    // Gallery uploads are staged first; the main Save button adds their paths to the dedicated website gallery.
    if (target === 'gallery') {
      await putEncodedFile(assetPath, bytes.toString('base64'), 'Upload staged EGYA DURIAN website gallery image');
      return sendJson(res, 200, { ok: true, path: assetPath, message: 'Foto berhasil diunggah ke GitHub sebagai draf. Tekan Simpan Perubahan untuk menampilkannya di Galeri EGYA DURIAN.' });
    }

    // Validate the target HTML and the exact gallery slot before uploading the asset.
    const file = await getFile('index.html');
    let updatedHtml;
    let imagesCount = null;
    if (target === 'hero') updatedHtml = replaceHeroImage(file.content, assetPath);
    else {
      const result = updateProductImageList(file.content, productId, assetPath, operation, imageIndex);
      updatedHtml = result.html;
      imagesCount = result.imagesCount;
    }

    await putEncodedFile(assetPath, bytes.toString('base64'), `${operation === 'add' ? 'Add' : 'Replace'} ${safeLabel} image from EGYA DURIAN Admin`);
    await putFile('index.html', updatedHtml, `Update ${safeLabel} image from EGYA DURIAN Admin`, file.sha);
    const message = target === 'hero'
      ? 'Banner berhasil diperbarui. Vercel akan menerbitkannya otomatis.'
      : (operation === 'add'
        ? `Foto berhasil ditambahkan ke galeri produk (${imagesCount} foto). Vercel akan menerbitkannya otomatis.`
        : `Foto ${imageIndex + 1} berhasil diganti${imageIndex === 0 ? ' dan menjadi foto utama pada card produk' : ' pada galeri produk'}. Vercel akan menerbitkannya otomatis.`);
    return sendJson(res, 200, { ok: true, path: assetPath, imagesCount, message });
  } catch (error) {
    const status = error.status === 409 || error.status === 422 ? 409 : (error.status || 500);
    return sendJson(res, status, { ok: false, message: error.message || 'Upload gagal.' });
  }
};
