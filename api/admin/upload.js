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
function classTokens(tagBlock) {
  const openEnd = tagBlock.indexOf('>');
  const openTag = openEnd >= 0 ? tagBlock.slice(0, openEnd + 1) : tagBlock;
  const match = openTag.match(/\bclass\s*=\s*["']([^"']*)["']/i);
  return match ? match[1].split(/\s+/).filter(Boolean) : [];
}
function findElementByClass(source, tagName, className, fromIndex = 0) {
  const openingPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  openingPattern.lastIndex = fromIndex;
  let opening;
  while ((opening = openingPattern.exec(source))) {
    if (!classTokens(opening[0]).includes(className)) continue;
    const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
    tagPattern.lastIndex = opening.index;
    let depth = 0, tag;
    while ((tag = tagPattern.exec(source))) {
      if (/^<\//.test(tag[0])) depth -= 1;
      else if (!/\/>$/.test(tag[0])) depth += 1;
      if (depth === 0) return {
        start: opening.index, end: tagPattern.lastIndex, openTag: opening[0], closeTag: tag[0],
        text: source.slice(opening.index, tagPattern.lastIndex),
      };
    }
    throw new Error(`Tag penutup ${tagName}.${className} tidak lengkap.`);
  }
  return null;
}
function replaceFirstImageInClass(html, tagName, className, assetPath, label) {
  const region = findElementByClass(html, tagName, className);
  if (!region) throw new Error(`Bagian ${label} tidak ditemukan.`);
  const image = region.text.match(/<img\b[^>]*>/i);
  if (!image) throw new Error(`Gambar ${label} tidak ditemukan.`);
  const updatedRegion = region.text.replace(image[0], setAttribute(image[0], 'src', assetPath));
  return html.slice(0, region.start) + updatedRegion + html.slice(region.end);
}
function replaceLogoHeaderImages(html, assetPath) {
  let updated = replaceFirstImageInClass(html, 'div', 'logo', assetPath, 'logo header');
  updated = replaceFirstImageInClass(updated, 'div', 'loader-content', assetPath, 'logo layar pemuatan');
  updated = replaceFirstImageInClass(updated, 'div', 'about-image', assetPath, 'logo bagian tentang');
  return updated;
}
function replaceHeroLogo(html, assetPath) {
  const pattern = /<img\b[^>]*>/gi;
  let found = false;
  const updated = html.replace(pattern, tag => {
    if (found || !classTokens(tag).includes('hero-logo')) return tag;
    found = true;
    return setAttribute(tag, 'src', assetPath);
  });
  if (!found) throw new Error('Logo pada bagian hero tidak ditemukan.');
  return updated;
}
function replaceVerifiedIcon(html, assetPath) {
  const pattern = /<img\b[^>]*>/gi;
  let found = false;
  const updated = html.replace(pattern, tag => {
    if (found || !classTokens(tag).includes('verified-icon')) return tag;
    found = true;
    return setAttribute(tag, 'src', assetPath);
  });
  if (!found) throw new Error('Ikon verifikasi di header tidak ditemukan.');
  return updated;
}
function socialPlatformForAnchor(anchor) {
  const opening = (anchor.match(/^<a\b[^>]*>/i) || [''])[0];
  const icon = (anchor.match(/<(?:i|img)\b[^>]*>/i) || [''])[0];
  const className = getAttribute(icon, 'class');
  const dataPlatform = getAttribute(icon, 'data-social-platform').toLowerCase();
  if (dataPlatform) return dataPlatform;
  if (/\bfa-facebook(?:-f)?\b/i.test(className)) return 'facebook';
  if (/\bfa-instagram\b/i.test(className)) return 'instagram';
  if (/\bfa-tiktok\b/i.test(className)) return 'tiktok';
  if (/\bfa-whatsapp\b/i.test(className) || /wa\.me\//i.test(getAttribute(opening, 'href'))) return 'whatsapp';
  return '';
}
function replaceSocialIcon(html, platform, assetPath) {
  const label = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', whatsapp: 'WhatsApp' }[platform];
  if (!label) throw new Error('Platform ikon sosial tidak valid.');
  let updated = html;
  let replaced = 0;
  const custom = `<img src="${htmlEscape(assetPath)}" alt="${label}" data-social-platform="${platform}" class="social-custom-icon" style="width:18px;height:18px;object-fit:contain;vertical-align:middle;margin-right:6px">`;
  for (const regionClass of ['hero-social', 'footer-social']) {
    const region = findElementByClass(updated, 'div', regionClass);
    if (!region) continue;
    const nextRegion = region.text.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, anchor => {
      if (socialPlatformForAnchor(anchor) !== platform) return anchor;
      const oldElement = anchor.match(/<i\b[^>]*>[\s\S]*?<\/i>|<img\b[^>]*>/i);
      if (!oldElement) return anchor;
      replaced++;
      return anchor.replace(oldElement[0], custom);
    });
    updated = updated.slice(0, region.start) + nextRegion + updated.slice(region.end);
  }
  // The floating WhatsApp CTA is a separate element outside the two social groups.
  // Keep its icon in sync with the custom WhatsApp logo as well.
  if (platform === 'whatsapp') {
    const floating = findElementByClass(updated, 'a', 'floating-wa');
    if (floating) {
      const oldElement = floating.text.match(/<i\b[^>]*>[\s\S]*?<\/i>|<img\b[^>]*>/i);
      if (oldElement) {
        const floatingCustom = custom
          .replace('width:18px;height:18px;object-fit:contain;vertical-align:middle;margin-right:6px', 'width:30px;height:30px;object-fit:contain;vertical-align:middle');
        const nextFloating = floating.text.replace(oldElement[0], floatingCustom);
        updated = updated.slice(0, floating.start) + nextFloating + updated.slice(floating.end);
        replaced++;
      }
    }
  }
  if (!replaced) throw new Error(`Ikon ${label} tidak ditemukan pada tautan sosial halaman depan/footer.`);
  return updated;
}
function resetSocialIcon(html, platform) {
  const className = {
    facebook: 'fa-brands fa-facebook',
    instagram: 'fa-brands fa-instagram',
    tiktok: 'fa-brands fa-tiktok',
    whatsapp: 'fa-brands fa-whatsapp',
  }[platform];
  if (!className) throw new Error('Platform ikon sosial tidak valid.');
  let updated = html;
  let count = 0;
  for (const regionClass of ['hero-social', 'footer-social']) {
    const region = findElementByClass(updated, 'div', regionClass);
    if (!region) continue;
    const nextRegion = region.text.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, anchor => {
      const image = anchor.match(/<img\b(?=[^>]*\bdata-social-platform=["'][^"']+["'])[^>]*>/i);
      if (!image || getAttribute(image[0], 'data-social-platform').toLowerCase() !== platform) return anchor;
      count++;
      return anchor.replace(image[0], `<i class="${className}"></i>`);
    });
    updated = updated.slice(0, region.start) + nextRegion + updated.slice(region.end);
  }
  if (platform === 'whatsapp') {
    const floating = findElementByClass(updated, 'a', 'floating-wa');
    if (floating) {
      const image = floating.text.match(/<img\b(?=[^>]*\bdata-social-platform=["']whatsapp["'])[^>]*>/i);
      if (image) {
        updated = updated.slice(0, floating.start) + floating.text.replace(image[0], `<i class="fab fa-whatsapp"></i>`) + updated.slice(floating.end);
        count++;
      }
    }
  }
  if (!count) throw new Error(`Ikon custom ${platform} tidak ditemukan. Muat ulang admin lalu coba lagi.`);
  return updated;
}
function replaceFavicon(html, assetPath) {
  let found = false;
  let updated = html.replace(/<link\b[^>]*>/gi, tag => {
    if (found) return tag;
    const rel = getAttribute(tag, 'rel').toLowerCase().split(/\s+/);
    if (!rel.includes('icon')) return tag;
    found = true;
    return setAttribute(tag, 'href', assetPath);
  });
  if (found) return updated;
  const link = `<link rel="icon" type="image/png" href="${htmlEscape(assetPath)}">`;
  if (/<\/head>/i.test(updated)) return updated.replace(/<\/head>/i, `${link}\n</head>`);
  if (/<body\b/i.test(updated)) return updated.replace(/<body\b/i, `${link}\n<body`);
  throw new Error('Bagian head/body tidak ditemukan untuk menambahkan favicon.');
}
function replaceHeroBannerAt(html, assetPath, imageIndex) {
  const slider = findElementByClass(html, 'div', 'hero-slider');
  if (!slider) throw new Error('Slider banner utama tidak ditemukan.');
  const slides = [];
  let cursor = 0;
  while (cursor < slider.text.length) {
    const slide = findElementByClass(slider.text, 'div', 'hero-slide', cursor);
    if (!slide) break;
    slides.push(slide);
    cursor = slide.end;
  }
  if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= slides.length || imageIndex > 2) {
    throw new Error('Pilih Banner 1, 2, atau 3 yang ingin diganti.');
  }
  const image = slides[imageIndex].text.match(/<img\b[^>]*>/i);
  if (!image) throw new Error(`Gambar Banner ${imageIndex + 1} tidak ditemukan.`);
  const nextSlide = slides[imageIndex].text.replace(image[0], setAttribute(image[0], 'src', assetPath));
  const nextSlider = slider.text.slice(0, slides[imageIndex].start) + nextSlide + slider.text.slice(slides[imageIndex].end);
  return html.slice(0, slider.start) + nextSlider + html.slice(slider.end);
}
function replaceHeroImage(html, assetPath) {
  return replaceHeroBannerAt(html, assetPath, 0);
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
    const resetSocialTargets = { resetSocialIconFacebook: 'facebook', resetSocialIconInstagram: 'instagram', resetSocialIconTikTok: 'tiktok', resetSocialIconWhatsApp: 'whatsapp' };
    const siteImageTargets = ['siteLogoHeader', 'siteLogoHero', 'siteVerifiedIcon', 'siteFavicon', 'siteSocialFacebook', 'siteSocialInstagram', 'siteSocialTikTok', 'siteSocialWhatsApp', 'heroBanner'];
    if (!['hero', 'product', 'gallery', ...siteImageTargets, ...Object.keys(resetSocialTargets)].includes(target)) return sendJson(res, 400, { ok: false, message: 'Tujuan upload tidak valid.' });
    if (resetSocialTargets[target]) {
      const file = await getFile('index.html');
      const updatedHtml = resetSocialIcon(file.content, resetSocialTargets[target]);
      await putFile('index.html', updatedHtml, `Reset ${resetSocialTargets[target]} social icon from EGYA DURIAN Admin`, file.sha);
      return sendJson(res, 200, { ok: true, message: `Ikon ${resetSocialTargets[target]} dikembalikan ke ikon standar. Vercel akan menerbitkan perubahan otomatis.` });
    }
    if (target === 'product' && (typeof productId !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(productId))) return sendJson(res, 400, { ok: false, message: 'ID produk tidak valid.' });
    if (target === 'product' && !['replace', 'add'].includes(operation)) return sendJson(res, 400, { ok: false, message: 'Aksi foto tidak valid.' });
    if (target === 'gallery' && operation !== 'stage') return sendJson(res, 400, { ok: false, message: 'Aksi foto galeri website tidak valid.' });
    if (target === 'product' && operation === 'replace' && (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= MAX_IMAGES_PER_PRODUCT)) return sendJson(res, 400, { ok: false, message: 'Nomor foto tidak valid.' });
    if (target === 'heroBanner' && (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex > 2)) return sendJson(res, 400, { ok: false, message: 'Nomor banner tidak valid. Pilih Banner 1, 2, atau 3.' });
    if (typeof dataUrl !== 'string' || dataUrl.length > 2900000) return sendJson(res, 413, { ok: false, message: 'Ukuran foto maksimal 2 MB.' });
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return sendJson(res, 400, { ok: false, message: 'Gunakan gambar JPG, PNG, atau WebP.' });
    const mime = match[1];
    const base64 = match[2];
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) return sendJson(res, 413, { ok: false, message: 'Ukuran foto maksimal 2 MB.' });
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp';
    const targetLabels = { hero: 'hero', gallery: 'gallery', siteLogoHeader: 'logo-header', siteLogoHero: 'logo-hero', siteVerifiedIcon: 'verified-icon', siteFavicon: 'favicon', siteSocialFacebook: 'social-facebook', siteSocialInstagram: 'social-instagram', siteSocialTikTok: 'social-tiktok', siteSocialWhatsApp: 'social-whatsapp', heroBanner: `hero-banner-${imageIndex + 1}` };
    const safeLabel = target === 'product' ? productId.toLowerCase() : (targetLabels[target] || 'image');
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
    else if (target === 'heroBanner') updatedHtml = replaceHeroBannerAt(file.content, assetPath, imageIndex);
    else if (target === 'siteLogoHeader') updatedHtml = replaceLogoHeaderImages(file.content, assetPath);
    else if (target === 'siteLogoHero') updatedHtml = replaceHeroLogo(file.content, assetPath);
    else if (target === 'siteVerifiedIcon') updatedHtml = replaceVerifiedIcon(file.content, assetPath);
    else if (target === 'siteFavicon') updatedHtml = replaceFavicon(file.content, assetPath);
    else if (target.startsWith('siteSocial')) {
      const platform = ({ siteSocialFacebook: 'facebook', siteSocialInstagram: 'instagram', siteSocialTikTok: 'tiktok', siteSocialWhatsApp: 'whatsapp' })[target];
      updatedHtml = replaceSocialIcon(file.content, platform, assetPath);
    }
    else {
      const result = updateProductImageList(file.content, productId, assetPath, operation, imageIndex);
      updatedHtml = result.html;
      imagesCount = result.imagesCount;
    }

    await putEncodedFile(assetPath, bytes.toString('base64'), `${operation === 'add' ? 'Add' : 'Replace'} ${safeLabel} image from EGYA DURIAN Admin`);
    await putFile('index.html', updatedHtml, `Update ${safeLabel} image from EGYA DURIAN Admin`, file.sha);
    let message;
    if (target === 'hero' || target === 'heroBanner') {
      message = `${target === 'heroBanner' ? `Banner ${imageIndex + 1}` : 'Banner utama'} berhasil diperbarui. Vercel akan menerbitkannya otomatis.`;
    } else if (target === 'siteLogoHeader') {
      message = 'Logo header, loader, dan bagian tentang berhasil diperbarui. Vercel akan menerbitkannya otomatis.';
    } else if (target === 'siteLogoHero') {
      message = 'Logo hero berhasil diperbarui. Vercel akan menerbitkannya otomatis.';
    } else if (target === 'siteVerifiedIcon') {
      message = 'Ikon verifikasi berhasil diperbarui. Vercel akan menerbitkannya otomatis.';
    } else if (target === 'siteFavicon') {
      message = 'Favicon berhasil diperbarui. Vercel akan menerbitkannya otomatis.';
    } else if (target.startsWith('siteSocial')) {
      const socialLabel = ({ siteSocialFacebook: 'Facebook', siteSocialInstagram: 'Instagram', siteSocialTikTok: 'TikTok', siteSocialWhatsApp: 'WhatsApp' })[target] || 'media sosial';
      message = `Ikon ${socialLabel} berhasil diperbarui pada bagian sosial halaman depan dan footer. Vercel akan menerbitkan perubahan otomatis.`;
    } else if (operation === 'add') {
      message = `Foto berhasil ditambahkan ke galeri produk (${imagesCount} foto). Vercel akan menerbitkan perubahan otomatis.`;
    } else {
      message = `Foto ${imageIndex + 1} berhasil diganti${imageIndex === 0 ? ' dan menjadi foto utama pada card produk' : ' pada galeri produk'}. Vercel akan menerbitkannya otomatis.`;
    }
    return sendJson(res, 200, { ok: true, path: assetPath, imagesCount, message });
  } catch (error) {
    const status = error.status === 409 || error.status === 422 ? 409 : (error.status || 500);
    return sendJson(res, status, { ok: false, message: error.message || 'Upload gagal.' });
  }
};
