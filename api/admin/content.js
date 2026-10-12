'use strict';

const { sendJson, requireAdmin, isSameOrigin } = require('../../lib/admin-auth');
const { getFile, putFile } = require('../../lib/github-repo');

const STATIC_PRODUCTS = {
  'MUSANG KING': 'musang',
  'BLACK THORN': 'blackthorn',
  'MONTHONG': 'monthong',
  'DURIAN KUPAS': 'kupas',
  'PANCAKE DURIAN': 'pancake',
  'PANCAKE ROLL': 'pancakeroll',
};
const STATIC_MARKERS = Object.fromEntries(Object.entries(STATIC_PRODUCTS).map(([marker, id]) => [id, marker]));
const PRODUCT_MARKER_RE = /<!--\s*(?:(MUSANG KING|BLACK THORN|MONTHONG|DURIAN KUPAS|PANCAKE DURIAN|PANCAKE ROLL)|ADMIN PRODUCT\s+id=["']([a-z0-9_-]{1,64})["'])\s*-->/gi;
const CATEGORIES = {
  musang: 'Musang King',
  blackthorn: 'Black Thorn',
  monthong: 'Monthong',
  kupas: 'Durian Kupas',
  pancake: 'Pancake Durian',
  pancakeroll: 'Pancake Rolls',
  lainnya: 'Lainnya',
};
const BADGE_CLASSES = new Set(['premium', 'flash', 'best', 'new']);

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function htmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function plainText(value) {
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}
function amountFromText(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits ? Number(digits) : 0;
}
function rupiah(value) {
  return `Rp ${Math.round(Number(value) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}
function classTokens(tagBlock) {
  const openEnd = tagBlock.indexOf('>');
  const openTag = openEnd >= 0 ? tagBlock.slice(0, openEnd + 1) : tagBlock;
  const classMatch = openTag.match(/\bclass\s*=\s*["']([^"']*)["']/i);
  return classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
}
function getAttribute(openTag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = openTag.match(new RegExp(`\\b${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]) : '';
}
function setAttribute(openTag, name, value) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const safe = htmlEscape(value);
  if (pattern.test(openTag)) return openTag.replace(pattern, `${name}="${safe}"`);
  return openTag.replace(/>$/, ` ${name}="${safe}">`);
}
function tagValue(source, tag, className) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  for (const match of source.matchAll(pattern)) {
    if (!className || classTokens(match[0]).includes(className)) {
      const inner = match[0].match(new RegExp(`^<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>$`, 'i'));
      return inner ? inner[1] : '';
    }
  }
  return '';
}
function getRegion(html, regex, label) {
  const match = html.match(regex);
  if (!match) throw new Error(`Bagian ${label} tidak ditemukan di index.html.`);
  return { text: match[0], start: match.index, end: match.index + match[0].length };
}
function extractParagraphByEmoji(block, emoji) {
  const escaped = emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<p\\b[^>]*>\\s*${escaped}([\\s\\S]*?)<\\/p>`, 'i'));
  return match ? plainText(match[1]) : '';
}
function replaceEmojiParagraph(block, emoji, content) {
  const escaped = emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(<p\\b[^>]*>\\s*${escaped})[\\s\\S]*?(<\\/p>)`, 'i');
  if (!pattern.test(block)) throw new Error(`Bagian kontak ${emoji} tidak ditemukan.`);
  return block.replace(pattern, `$1 ${htmlEscape(content)}$2`);
}
function replaceTagText(source, tag, value, className) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  let replaced = false;
  const result = source.replace(pattern, block => {
    if (replaced || (className && !classTokens(block).includes(className))) return block;
    const match = block.match(new RegExp(`^(<${tag}\\b[^>]*>)[\\s\\S]*?(<\\/${tag}>)$`, 'i'));
    if (!match) return block;
    replaced = true;
    return `${match[1]}${htmlEscape(value)}${match[2]}`;
  });
  if (!replaced) throw new Error(`Elemen ${tag}${className ? `.${className}` : ''} tidak ditemukan.`);
  return result;
}
function replaceTagByIndex(source, tag, index, value) {
  let seen = -1;
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  let replaced = false;
  const result = source.replace(pattern, block => {
    seen += 1;
    if (seen !== index) return block;
    const match = block.match(new RegExp(`^(<${tag}\\b[^>]*>)[\\s\\S]*?(<\\/${tag}>)$`, 'i'));
    if (!match) return block;
    replaced = true;
    return `${match[1]}${htmlEscape(value)}${match[2]}`;
  });
  if (!replaced) throw new Error(`Elemen ${tag} nomor ${index + 1} tidak ditemukan.`);
  return result;
}
function findElementByClass(source, tagName, className, fromIndex = 0) {
  const openingPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  openingPattern.lastIndex = fromIndex;
  let opening;
  while ((opening = openingPattern.exec(source))) {
    if (!classTokens(opening[0]).includes(className)) continue;
    const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
    tagPattern.lastIndex = opening.index;
    let depth = 0;
    let tag;
    while ((tag = tagPattern.exec(source))) {
      if (/^<\//.test(tag[0])) depth -= 1;
      else if (!/\/>$/.test(tag[0])) depth += 1;
      if (depth === 0) {
        const end = tagPattern.lastIndex;
        return {
          start: opening.index,
          end,
          openTag: opening[0],
          closeTag: tag[0],
          text: source.slice(opening.index, end),
          inner: source.slice(openingPattern.lastIndex, tag.index),
        };
      }
    }
    throw new Error(`Tag penutup ${tagName}.${className} tidak lengkap.`);
  }
  return null;
}
function getProductBlocks(productsSection) {
  const sectionClose = productsSection.toLowerCase().lastIndexOf('</section>');
  const searchEnd = sectionClose >= 0 ? sectionClose : productsSection.length;
  const searchable = productsSection.slice(0, searchEnd);
  const markers = [...searchable.matchAll(PRODUCT_MARKER_RE)];
  return markers.map((match, index) => {
    const end = index + 1 < markers.length ? markers[index + 1].index : searchEnd;
    const legacyMarker = match[1] ? match[1].toUpperCase() : '';
    const id = legacyMarker ? STATIC_PRODUCTS[legacyMarker] : match[2].toLowerCase();
    return {
      id,
      marker: match[0],
      start: match.index,
      end,
      block: productsSection.slice(match.index, end).trim(),
    };
  });
}
function productDataFromBlock(block, id) {
  const card = findElementByClass(block, 'div', 'product-card');
  if (!card) throw new Error(`Card produk ${id} tidak ditemukan.`);
  const badgeOpen = (block.match(/<span\b[^>]*class=["'][^"']*\bproduct-badge\b[^"']*["'][^>]*>/i) || [''])[0];
  const badgeTokens = classTokens(badgeOpen).filter(token => token !== 'product-badge');
  const imageOpen = (block.match(/<img\b[^>]*class=["'][^"']*\bproduct-image\b[^"']*["'][^>]*>/i) || [''])[0];
  const primaryImage = getAttribute(imageOpen, 'src');
  let images = [];
  try {
    const parsed = JSON.parse(getAttribute(card.openTag, 'data-images') || '[]');
    if (Array.isArray(parsed)) images = parsed.filter(item => typeof item === 'string' && item.trim()).slice(0, 10);
  } catch { images = []; }
  if (!images.length && primaryImage) images = [primaryImage];
  return {
    id,
    name: plainText(tagValue(block, 'h3')),
    badge: plainText(tagValue(block, 'span', 'product-badge')),
    badgeClass: BADGE_CLASSES.has(badgeTokens[0]) ? badgeTokens[0] : 'premium',
    category: CATEGORIES[getAttribute(card.openTag, 'data-category')] ? getAttribute(card.openTag, 'data-category') : 'lainnya',
    oldPrice: amountFromText(tagValue(block, 'p', 'old-price')),
    price: amountFromText(tagValue(block, 'p', 'price')),
    image: images[0] || primaryImage,
    images,
  };
}
function extractAllDivsByClass(source, className) {
  const results = [];
  let cursor = 0;
  while (cursor < source.length) {
    const found = findElementByClass(source, 'div', className, cursor);
    if (!found) break;
    results.push(found);
    cursor = found.end;
  }
  return results;
}
function getAdminData(html) {
  const contact = getRegion(html, /<section\b(?=[^>]*\bid=["']contact["'])[\s\S]*?<\/section>/i, 'contact').text;
  const hero = getRegion(html, /<div\s+class="hero-content">[\s\S]*?<div\s+class="hero-rating">[\s\S]*?<\/div>/i, 'hero').text;
  const about = getRegion(html, /<section\b(?=[^>]*\bid=["']about["'])[\s\S]*?<\/section>/i, 'about').text;
  const promo = getRegion(html, /<section\s+class="promo-slider">[\s\S]*?<\/section>/i, 'promo slider').text;
  const testimonial = getRegion(html, /<section\b(?=[^>]*\bid=["']testimonials["'])[\s\S]*?<\/section>/i, 'testimonials').text;
  const productsSection = getRegion(html, /<section\b(?=[^>]*\bid=["']products["'])[\s\S]*?<\/section>/i, 'products').text;
  const gallerySection = getRegion(html, /<section\b(?=[^>]*\bid=["']gallery["'])[\s\S]*?<\/section>/i, 'gallery website').text;
  const gallery = extractGalleryImages(gallerySection);
  const galleryVideos = extractGalleryVideos(gallerySection);
  // Compatibility fields for older admin tabs; the current admin uses galleryVideos.
  const galleryVideo = galleryVideos.find(video => !video.hidden)?.url || '';
  const galleryVideoArchive = galleryVideos.find(video => video.hidden)?.url || '';

  const phoneParagraph = (contact.match(/<p\b[^>]*>\s*📞[\s\S]*?<\/p>/i) || [''])[0];
  const phones = (plainText(phoneParagraph).match(/\+?\d[\d ()-]{6,}\d/g) || []).map(value => value.trim());
  const heroP = Array.from(hero.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)).map(match => plainText(match[1]));
  const promos = Array.from(promo.matchAll(/<div\s+class="slide(?:\s+active)?"[^>]*>([\s\S]*?)<\/div>/gi)).map(match => plainText(match[1]));
  const testimonialCards = extractAllDivsByClass(testimonial, 'testimonial-card');
  const testimonials = testimonialCards.map(card => ({
    text: plainText(tagValue(card.text, 'p')),
    name: plainText(tagValue(card.text, 'strong')).replace(/^[-–]\s*/, ''),
  }));
  const products = getProductBlocks(productsSection).map(block => productDataFromBlock(block.block, block.id));

  const titleMatch = hero.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const headingMatch = hero.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  const aboutHead = about.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  const aboutParagraphs = Array.from(about.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)).map(match => plainText(match[1]));

  return {
    contact: {
      location: extractParagraphByEmoji(contact, '📍'),
      phonePrimary: phones[0] || '',
      phoneWhatsapp: phones[1] || '',
      email: extractParagraphByEmoji(contact, '✉️').replace(/^\s*/, ''),
      hours: extractParagraphByEmoji(contact, '🕒'),
    },
    hero: {
      title: plainText(titleMatch ? titleMatch[1] : ''),
      subtitle: plainText(headingMatch ? headingMatch[1] : ''),
      story: heroP[0] || '',
      tagline: heroP[1] || '',
    },
    about: {
      title: plainText(aboutHead ? aboutHead[1] : ''),
      paragraph1: aboutParagraphs[0] || '',
      paragraph2: aboutParagraphs[1] || '',
    },
    promos,
    products,
    testimonials,
    gallery,
    galleryVideos,
    galleryVideo,
    galleryVideoArchive,
  };
}
function extractGalleryImages(gallerySection) {
  const grid = findElementByClass(gallerySection, 'div', 'gallery-grid');
  if (!grid) throw new Error('Daftar foto pada Galeri EGYA DURIAN tidak ditemukan.');
  const images = [];
  for (const match of grid.inner.matchAll(/<img\b[^>]*>/gi)) {
    if (!classTokens(match[0]).includes('gallery-item')) continue;
    const src = getAttribute(match[0], 'src').trim();
    if (src) images.push(src);
  }
  return images;
}
function extractGalleryVideos(gallerySection) {
  const grid = findElementByClass(gallerySection, 'div', 'gallery-grid');
  if (!grid) throw new Error('Daftar media pada Galeri EGYA DURIAN tidak ditemukan.');
  const sectionOpen = (gallerySection.match(/<section\b[^>]*>/i) || [''])[0];
  const result = [];
  const add = (url, hidden) => {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl) return;
    const exists = result.find(video => video.url === cleanUrl);
    if (exists) return;
    result.push({ url: cleanUrl, hidden: Boolean(hidden) });
  };

  // v9 stores all videos and each video's visibility in section metadata.
  const rawMetadata = getAttribute(sectionOpen, 'data-admin-gallery-videos').trim();
  if (rawMetadata) {
    try {
      const parsed = JSON.parse(rawMetadata);
      if (Array.isArray(parsed)) {
        for (const video of parsed) {
          if (video && typeof video.url === 'string') add(video.url, video.hidden === true);
        }
      }
    } catch { /* Migrate old markup below. */ }
  }

  // Active videos appear in the public gallery-grid. Legacy hidden video tags are
  // read for migration but will be removed on the next save.
  for (const videoMatch of grid.inner.matchAll(/<video\b[^>]*>[\s\S]*?<\/video>/gi)) {
    const whole = videoMatch[0];
    const videoOpen = (whole.match(/^<video\b[^>]*>/i) || [''])[0];
    const sourceMatch = whole.match(/<source\b[^>]*>/i);
    const src = (sourceMatch ? getAttribute(sourceMatch[0], 'src') : getAttribute(videoOpen, 'src')).trim();
    if (!src) continue;
    const classes = classTokens(videoOpen);
    const hidden = getAttribute(videoOpen, 'data-admin-gallery-hidden') === 'true'
      || /\bhidden(?:\s|=|>)/i.test(videoOpen)
      || classes.includes('gallery-video-archived');
    add(src, hidden);
  }

  // Backwards compatibility with v5-v8 where only one archive URL was stored.
  const legacyArchive = getAttribute(sectionOpen, 'data-admin-gallery-video-archive').trim();
  if (legacyArchive) add(legacyArchive, true);

  // Metadata is authoritative for known URLs; any unlisted video tag discovered
  // above is retained so an external/manual HTML addition is not silently lost.
  return result;
}
function removeAttribute(openTag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\s+${escapedName}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, 'i');
  return openTag.replace(pattern, '');
}
function videoMimeForPath(videoPath) {
  let pathname = String(videoPath || '').split('?')[0].split('#')[0];
  try { pathname = new URL(pathname).pathname; } catch { /* assets/relative path */ }
  return /\.webm$/i.test(pathname) ? 'video/webm' : (/\.(?:ogv|ogg)$/i.test(pathname) ? 'video/ogg' : 'video/mp4');
}
function updateVideoMarkup(template, videoPath) {
  const mime = videoMimeForPath(videoPath);
  let markup = template || `<video class="gallery-item" controls playsinline preload="metadata" muted><source src="${htmlEscape(videoPath)}" type="${mime}">Browser Anda tidak mendukung video.</video>`;
  const videoOpen = (markup.match(/^<video\b[^>]*>/i) || [''])[0];
  if (!videoOpen) throw new Error('Elemen video Galeri EGYA DURIAN tidak valid.');
  let nextOpen = setAttribute(videoOpen, 'class', 'gallery-item');
  nextOpen = removeAttribute(removeAttribute(nextOpen, 'hidden'), 'data-admin-gallery-hidden');
  if (!/\bcontrols(?:\s|=|>)/i.test(nextOpen)) nextOpen = nextOpen.replace(/>$/, ' controls>');
  markup = markup.replace(videoOpen, nextOpen);
  const sourcePattern = /<source\b[^>]*>/i;
  if (sourcePattern.test(markup)) {
    markup = markup.replace(sourcePattern, sourceTag => setAttribute(setAttribute(sourceTag, 'src', videoPath), 'type', mime));
  } else {
    markup = markup.replace(/<\/video>/i, `<source src="${htmlEscape(videoPath)}" type="${mime}"></video>`);
  }
  return markup;
}
function videoUrlFromMarkup(markup) {
  const videoOpen = (markup.match(/^<video\b[^>]*>/i) || [''])[0];
  const sourceMatch = markup.match(/<source\b[^>]*>/i);
  return (sourceMatch ? getAttribute(sourceMatch[0], 'src') : getAttribute(videoOpen, 'src')).trim();
}
function sameGalleryVideoLists(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((video, index) => video.url === right[index]?.url && video.hidden === right[index]?.hidden);
}
function galleryVideoMarkupNeedsNormalization(section, galleryVideos) {
  const grid = findElementByClass(section, 'div', 'gallery-grid');
  if (!grid) throw new Error('Daftar media pada Galeri EGYA DURIAN tidak ditemukan.');
  const videoMarkup = [...grid.inner.matchAll(/<video\b[^>]*>[\s\S]*?<\/video>/gi)].map(match => match[0]);
  const actualActive = videoMarkup.filter(markup => {
    const open = (markup.match(/^<video\b[^>]*>/i) || [''])[0];
    const hidden = getAttribute(open, 'data-admin-gallery-hidden') === 'true'
      || /\bhidden(?:\s|=|>)/i.test(open)
      || classTokens(open).includes('gallery-video-archived');
    return !hidden && classTokens(open).includes('gallery-item');
  }).map(videoUrlFromMarkup).filter(Boolean);
  const expectedActive = galleryVideos.filter(video => !video.hidden).map(video => video.url);
  const sectionOpen = (section.match(/<section\b[^>]*>/i) || [''])[0];
  const rawMetadata = getAttribute(sectionOpen, 'data-admin-gallery-videos').trim();
  const legacyArchive = getAttribute(sectionOpen, 'data-admin-gallery-video-archive').trim();
  let stored = null;
  try {
    const parsed = JSON.parse(rawMetadata);
    if (Array.isArray(parsed)) stored = parsed.filter(video => video && typeof video.url === 'string').map(video => ({ url: video.url, hidden: video.hidden === true }));
  } catch { /* Old data needs one-time normalization. */ }
  const hasHiddenVideoTag = videoMarkup.some(markup => {
    const open = (markup.match(/^<video\b[^>]*>/i) || [''])[0];
    return getAttribute(open, 'data-admin-gallery-hidden') === 'true'
      || /\bhidden(?:\s|=|>)/i.test(open)
      || classTokens(open).includes('gallery-video-archived');
  });
  return Boolean(legacyArchive)
    || hasHiddenVideoTag
    || !stored
    || !sameGalleryVideoLists(stored, galleryVideos)
    || actualActive.length !== expectedActive.length
    || actualActive.some((url, index) => url !== expectedActive[index]);
}
function updateGalleryVideoSection(section, galleryVideos) {
  const grid = findElementByClass(section, 'div', 'gallery-grid');
  if (!grid) throw new Error('Daftar media pada Galeri EGYA DURIAN tidak ditemukan.');
  const videoPattern = /<video\b[^>]*>[\s\S]*?<\/video>/gi;
  const existingVideos = [...grid.inner.matchAll(videoPattern)].map(match => match[0]);
  const templateMarkup = existingVideos.find(markup => {
    const open = (markup.match(/^<video\b[^>]*>/i) || [''])[0];
    return !getAttribute(open, 'data-admin-gallery-hidden')
      && !/\bhidden(?:\s|=|>)/i.test(open)
      && !classTokens(open).includes('gallery-video-archived');
  }) || existingVideos[0] || '';
  const activeMarkup = galleryVideos.filter(video => !video.hidden)
    .map(video => updateVideoMarkup(templateMarkup, video.url));

  // Only visible video elements are put into the public gallery. Hidden videos
  // live only in the metadata, so they do not leave empty player tiles behind.
  let nextInner = grid.inner.replace(videoPattern, '').trimEnd();
  if (activeMarkup.length) nextInner = `${nextInner}${nextInner ? '\n\n' : ''}${activeMarkup.join('\n\n')}`;
  const innerStart = grid.start + grid.openTag.length;
  const innerEnd = grid.end - grid.closeTag.length;
  let updated = section.slice(0, innerStart) + nextInner + section.slice(innerEnd);
  const sectionOpen = (updated.match(/<section\b[^>]*>/i) || [''])[0];
  if (!sectionOpen) throw new Error('Pembuka bagian Galeri EGYA DURIAN tidak ditemukan.');
  let nextSectionOpen = removeAttribute(sectionOpen, 'data-admin-gallery-video-archive');
  nextSectionOpen = setAttribute(nextSectionOpen, 'data-admin-gallery-videos', JSON.stringify(galleryVideos));
  updated = updated.replace(sectionOpen, nextSectionOpen);
  return updated;
}

function updateGallerySection(section, submittedGallery) {
  const grid = findElementByClass(section, 'div', 'gallery-grid');
  if (!grid) throw new Error('Daftar foto pada Galeri EGYA DURIAN tidak ditemukan.');
  const validPaths = submittedGallery.map(path => String(path));
  let imageIndex = 0;
  const oldGalleryImages = [...grid.inner.matchAll(/<img\b[^>]*>/gi)].filter(match => classTokens(match[0]).includes('gallery-item'));
  let inner = grid.inner.replace(/<img\b[^>]*>/gi, tag => {
    if (!classTokens(tag).includes('gallery-item')) return tag;
    const path = validPaths[imageIndex++];
    return path ? `<img src="${htmlEscape(path)}" class="gallery-item" alt="Galeri EGYA DURIAN">` : '';
  });
  if (validPaths.length > oldGalleryImages.length) {
    const additions = validPaths.slice(oldGalleryImages.length).map(path => `<img src="${htmlEscape(path)}" class="gallery-item" alt="Galeri EGYA DURIAN">`).join('\n\n');
    const videoMatch = inner.match(/<video\b/i);
    if (videoMatch) inner = `${inner.slice(0, videoMatch.index)}${additions}\n\n${inner.slice(videoMatch.index)}`;
    else inner = `${inner.trimEnd()}\n\n${additions}`;
  }
  const innerStart = grid.start + grid.openTag.length;
  const innerEnd = grid.end - grid.closeTag.length;
  return section.slice(0, innerStart) + inner + section.slice(innerEnd);
}
function setProductCardAttributes(block, product, extraAttributes = {}) {
  const match = block.match(/<div\b(?=[^>]*\bclass=["'][^"']*\bproduct-card\b[^"']*["'])[^>]*>/i);
  if (!match) throw new Error(`Tag pembuka produk ${product.id} tidak ditemukan.`);
  let opening = match[0];
  opening = setAttribute(opening, 'data-category', product.category);
  opening = setAttribute(opening, 'data-price', String(Number(product.price) || 0));
  opening = setAttribute(opening, 'data-admin-product-id', product.id);
  for (const [name, value] of Object.entries(extraAttributes)) opening = setAttribute(opening, name, value);
  return block.replace(match[0], opening);
}
function replaceProductBadge(block, product) {
  const pattern = /<span\b(?=[^>]*\bclass=["'][^"']*\bproduct-badge\b[^"']*["'])[^>]*>[\s\S]*?<\/span>/i;
  if (!pattern.test(block)) throw new Error(`Badge produk ${product.id} tidak ditemukan.`);
  return block.replace(pattern, whole => {
    const opening = whole.match(/^<span\b[^>]*>/i)[0];
    const newOpening = setAttribute(opening, 'class', `product-badge ${product.badgeClass}`);
    return `${newOpening}${htmlEscape(product.badge)}</span>`;
  });
}
function productFieldsEqual(a, b) {
  return a.id === b.id && a.name === b.name && a.badge === b.badge && a.badgeClass === b.badgeClass && a.category === b.category && Number(a.oldPrice) === Number(b.oldPrice) && Number(a.price) === Number(b.price);
}
function productsEqual(a, b) {
  return a.length === b.length && a.every((product, index) => productFieldsEqual(product, b[index]));
}
function markerForProduct(id) {
  return STATIC_MARKERS[id] ? `<!-- ${STATIC_MARKERS[id]} -->` : `<!-- ADMIN PRODUCT id="${id}" -->`;
}
function stripLeadingProductMarker(block) {
  return block.replace(/^\s*<!--\s*(?:(?:MUSANG KING|BLACK THORN|MONTHONG|DURIAN KUPAS|PANCAKE DURIAN|PANCAKE ROLL)|ADMIN PRODUCT\s+id=["'][a-z0-9_-]{1,64}["'])\s*-->\s*/i, '').trim();
}
function updateExistingProductBlock(block, product) {
  let updated = stripLeadingProductMarker(block);
  const oldName = plainText(tagValue(updated, 'h3'));
  const oldOldPrice = amountFromText(tagValue(updated, 'p', 'old-price'));
  const oldPrice = amountFromText(tagValue(updated, 'p', 'price'));
  const oldBadge = plainText(tagValue(updated, 'span', 'product-badge'));
  const oldBadgeClass = (() => {
    const open = (updated.match(/<span\b[^>]*class=["'][^"']*\bproduct-badge\b[^"']*["'][^>]*>/i) || [''])[0];
    return classTokens(open).filter(token => token !== 'product-badge')[0] || 'premium';
  })();
  if (product.name !== oldName) updated = replaceTagText(updated, 'h3', product.name);
  if (Number(product.oldPrice) !== oldOldPrice) updated = replaceTagText(updated, 'p', rupiah(product.oldPrice), 'old-price');
  if (Number(product.price) !== oldPrice) updated = replaceTagText(updated, 'p', rupiah(product.price), 'price');
  if (product.badge !== oldBadge || product.badgeClass !== oldBadgeClass) updated = replaceProductBadge(updated, product);
  updated = setProductCardAttributes(updated, product);
  return `${markerForProduct(product.id)}\n\n${updated.trim()}`;
}
function createProductBlock(templateBlock, product) {
  let created = stripLeadingProductMarker(templateBlock);
  const imageOpen = (created.match(/<img\b[^>]*class=["'][^"']*\bproduct-image\b[^"']*["'][^>]*>/i) || [''])[0];
  const imagePath = getAttribute(imageOpen, 'src') || 'assets/musangking.png';
  created = replaceTagText(created, 'h3', product.name);
  created = replaceTagText(created, 'p', rupiah(product.oldPrice), 'old-price');
  created = replaceTagText(created, 'p', rupiah(product.price), 'price');
  created = replaceProductBadge(created, product);
  created = setProductCardAttributes(created, product, { 'data-images': JSON.stringify([imagePath]) });
  return `${markerForProduct(product.id)}\n\n${created.trim()}`;
}
function updateProductsSection(section, submittedProducts, currentProducts) {
  const blocks = getProductBlocks(section);
  if (!blocks.length) throw new Error('Card produk tidak ditemukan di index.html.');
  const byId = new Map(blocks.map(block => [block.id, block]));
  const currentById = new Map(currentProducts.map(product => [product.id, product]));
  const templateBlock = blocks[0].block;
  const rendered = submittedProducts.map(product => {
    if (byId.has(product.id) && currentById.has(product.id)) {
      return updateExistingProductBlock(byId.get(product.id).block, product);
    }
    return createProductBlock(templateBlock, product);
  });
  const first = blocks[0].start;
  const close = section.toLowerCase().lastIndexOf('</section>');
  if (close < 0) throw new Error('Penutup bagian produk tidak ditemukan.');
  const prefix = section.slice(0, first);
  const suffix = section.slice(close);
  return `${prefix}${rendered.join('\n\n')}\n\n${suffix}`;
}
function ensureCategoryFilters(html, products) {
  const region = getRegion(html, /<section\b(?=[^>]*\bclass=["'][^"']*\bfilter-wrapper\b[^"']*["'])[^>]*>[\s\S]*?<\/section>/i, 'filter produk');
  let wrapper = region.text;
  const existing = new Set([...wrapper.matchAll(/<button\b[^>]*\bdata-category=["']([^"']+)["'][^>]*>/gi)].map(match => match[1]));
  const needed = [...new Set(products.map(product => product.category))].filter(category => CATEGORIES[category] && !existing.has(category));
  if (!needed.length) return html;
  const additions = needed.map(category => `<button class="filter-btn" data-category="${category}">\n\n${htmlEscape(CATEGORIES[category])}\n\n</button>`).join('\n\n');
  wrapper = wrapper.replace(/<\/section>\s*$/i, `${additions}\n\n</section>`);
  return html.slice(0, region.start) + wrapper + html.slice(region.end);
}
function updatePromoSection(section, promos) {
  const opening = (section.match(/^\s*(<section\b[^>]*>)/i) || [null, '<section class="promo-slider">'])[1];
  const slides = promos.map((promo, index) => `<div class="slide${index === 0 ? ' active' : ''}">\n\n${htmlEscape(promo)}\n\n</div>`).join('\n\n');
  return `${opening}\n\n${slides}\n\n</section>`;
}
function updateTestimonialsSection(section, testimonials) {
  const grid = findElementByClass(section, 'div', 'testimonial-grid');
  if (!grid) throw new Error('Daftar testimoni tidak ditemukan di index.html.');
  const cards = testimonials.map(item => `<div class="testimonial-card">\n\n⭐️⭐️⭐️⭐️⭐️\n\n<p>\n\n${htmlEscape(item.text)}\n\n</p>\n\n<strong>\n\n- ${htmlEscape(item.name)}\n\n</strong>\n\n</div>`).join('\n\n');
  const newGrid = `${grid.openTag}\n\n${cards}\n\n${grid.closeTag}`;
  return section.slice(0, grid.start) + newGrid + section.slice(grid.end);
}
function updateContent(html, submitted) {
  const current = getAdminData(html);
  const input = validatePayload(submitted);
  let updated = html;

  if (input.contact.location !== current.contact.location || input.contact.phonePrimary !== current.contact.phonePrimary || input.contact.phoneWhatsapp !== current.contact.phoneWhatsapp || input.contact.email !== current.contact.email || input.contact.hours !== current.contact.hours) {
    const region = getRegion(updated, /<section\b(?=[^>]*\bid=["']contact["'])[\s\S]*?<\/section>/i, 'contact');
    let block = region.text;
    if (input.contact.location !== current.contact.location) block = replaceEmojiParagraph(block, '📍', input.contact.location);
    if (input.contact.phonePrimary !== current.contact.phonePrimary || input.contact.phoneWhatsapp !== current.contact.phoneWhatsapp) {
      const phonePattern = /(<p\b[^>]*>\s*📞)[\s\S]*?(<\/p>)/i;
      if (!phonePattern.test(block)) throw new Error('Nomor telepon tidak ditemukan.');
      block = block.replace(phonePattern, `$1 ${htmlEscape(input.contact.phonePrimary)} / <i class="fa-brands fa-whatsapp" style="color: #25D366;"></i> ${htmlEscape(input.contact.phoneWhatsapp)}$2`);
    }
    if (input.contact.email !== current.contact.email) block = replaceEmojiParagraph(block, '✉️', input.contact.email);
    if (input.contact.hours !== current.contact.hours) block = replaceEmojiParagraph(block, '🕒', input.contact.hours);
    updated = updated.slice(0, region.start) + block + updated.slice(region.end);
  }

  if (Object.keys(input.hero).some(key => input.hero[key] !== current.hero[key])) {
    const region = getRegion(updated, /<div\s+class="hero-content">[\s\S]*?<div\s+class="hero-rating">[\s\S]*?<\/div>/i, 'hero');
    let block = region.text;
    if (input.hero.title !== current.hero.title) block = replaceTagText(block, 'h1', input.hero.title);
    if (input.hero.subtitle !== current.hero.subtitle) block = replaceTagText(block, 'h2', input.hero.subtitle);
    if (input.hero.story !== current.hero.story) block = replaceTagByIndex(block, 'p', 0, input.hero.story);
    if (input.hero.tagline !== current.hero.tagline) block = replaceTagByIndex(block, 'p', 1, input.hero.tagline);
    updated = updated.slice(0, region.start) + block + updated.slice(region.end);
  }

  if (Object.keys(input.about).some(key => input.about[key] !== current.about[key])) {
    const region = getRegion(updated, /<section\b(?=[^>]*\bid=["']about["'])[\s\S]*?<\/section>/i, 'about');
    let block = region.text;
    if (input.about.title !== current.about.title) block = replaceTagText(block, 'h2', input.about.title);
    if (input.about.paragraph1 !== current.about.paragraph1) block = replaceTagByIndex(block, 'p', 0, input.about.paragraph1);
    if (input.about.paragraph2 !== current.about.paragraph2) block = replaceTagByIndex(block, 'p', 1, input.about.paragraph2);
    updated = updated.slice(0, region.start) + block + updated.slice(region.end);
  }

  if (input.promos.length !== current.promos.length || input.promos.some((value, index) => value !== current.promos[index])) {
    const region = getRegion(updated, /<section\s+class="promo-slider">[\s\S]*?<\/section>/i, 'promo slider');
    const block = updatePromoSection(region.text, input.promos);
    updated = updated.slice(0, region.start) + block + updated.slice(region.end);
  }

  if (!productsEqual(input.products, current.products)) {
    const region = getRegion(updated, /<section\b(?=[^>]*\bid=["']products["'])[\s\S]*?<\/section>/i, 'products');
    const block = updateProductsSection(region.text, input.products, current.products);
    updated = updated.slice(0, region.start) + block + updated.slice(region.end);
    updated = ensureCategoryFilters(updated, input.products);
  }

  if (input.testimonials.length !== current.testimonials.length || input.testimonials.some((item, index) => item.text !== current.testimonials[index]?.text || item.name !== current.testimonials[index]?.name)) {
    const region = getRegion(updated, /<section\b(?=[^>]*\bid=["']testimonials["'])[\s\S]*?<\/section>/i, 'testimonials');
    const block = updateTestimonialsSection(region.text, input.testimonials);
    updated = updated.slice(0, region.start) + block + updated.slice(region.end);
  }

  if (input.gallery !== null && (input.gallery.length !== current.gallery.length || input.gallery.some((path, index) => path !== current.gallery[index]))) {
    const region = getRegion(updated, /<section\b(?=[^>]*\bid=["']gallery["'])[\s\S]*?<\/section>/i, 'gallery website');
    const block = updateGallerySection(region.text, input.gallery);
    updated = updated.slice(0, region.start) + block + updated.slice(region.end);
  }
  if (input.galleryVideos !== null) {
    const region = getRegion(updated, /<section\b(?=[^>]*\bid=["']gallery["'])[\s\S]*?<\/section>/i, 'gallery website');
    const videoValuesChanged = !sameGalleryVideoLists(input.galleryVideos, current.galleryVideos);
    // Migrate old v5-v8 single-video metadata and normalize old hidden players once.
    if (videoValuesChanged || galleryVideoMarkupNeedsNormalization(region.text, input.galleryVideos)) {
      const block = updateGalleryVideoSection(region.text, input.galleryVideos);
      updated = updated.slice(0, region.start) + block + updated.slice(region.end);
    }
  }

  return updated;
}
function validatePayload(value) {
  if (!value || typeof value !== 'object') throw new Error('Data formulir tidak valid.');
  const text = (input, name, max = 500) => {
    if (typeof input !== 'string') throw new Error(`Kolom ${name} tidak valid.`);
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > max) throw new Error(`Kolom ${name} harus diisi dan maksimal ${max} karakter.`);
    return trimmed;
  };
  const phone = (input, name) => {
    const result = text(input, name, 30);
    if (!/^[+0-9 ()-]{7,30}$/.test(result)) throw new Error(`${name} hanya boleh berisi angka, spasi, +, tanda kurung, atau tanda hubung.`);
    return result;
  };
  const price = (input, name) => {
    const result = Number(input);
    if (!Number.isInteger(result) || result < 0 || result > 1000000000) throw new Error(`${name} harus berupa angka Rupiah yang valid.`);
    return result;
  };
  if (!Array.isArray(value.promos) || value.promos.length < 1 || value.promos.length > 20) throw new Error('Jumlah promo harus antara 1 sampai 20.');
  if (!Array.isArray(value.products) || value.products.length < 1 || value.products.length > 50) throw new Error('Jumlah produk harus antara 1 sampai 50.');
  if (!Array.isArray(value.testimonials) || value.testimonials.length > 30) throw new Error('Jumlah testimoni maksimal 30.');
  let gallery = null;
  if (value.gallery !== undefined) {
    if (!Array.isArray(value.gallery) || value.gallery.length > 30) throw new Error('Galeri website boleh berisi maksimal 30 foto.');
    gallery = value.gallery.map((path, index) => {
      if (typeof path !== 'string' || path.length > 180 || !/^assets\/[A-Za-z0-9._/-]+\.(?:jpe?g|png|webp|gif)$/i.test(path) || path.includes('..') || path.includes('//')) {
        throw new Error(`Path foto Galeri website nomor ${index + 1} tidak valid.`);
      }
      return path;
    });
  }
  const validateVideoPath = (input, label) => {
    if (input === undefined) return null;
    if (input === '') return '';
    if (typeof input !== 'string' || input.length > 2048) throw new Error(`Path ${label} tidak valid.`);
    const isAssetPath = /^assets\/[A-Za-z0-9._/-]+\.(?:mp4|webm|ogv|ogg|m4v)$/i.test(input) && !input.includes('..') && !input.includes('//');
    let isPublicBlobUrl = false;
    if (/^https:\/\//i.test(input)) {
      try {
        const url = new URL(input);
        const safeHost = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i.test(url.hostname);
        const safePath = /^\/egyadurian-gallery-videos\/[A-Za-z0-9._/-]+\.(?:mp4|webm|ogv|ogg)$/i.test(url.pathname)
          && !url.pathname.includes('..') && !url.pathname.includes('//');
        isPublicBlobUrl = url.protocol === 'https:' && safeHost && safePath && !url.username && !url.password && !url.port && !url.search && !url.hash;
      } catch { isPublicBlobUrl = false; }
    }
    if (!isAssetPath && !isPublicBlobUrl) throw new Error(`Path ${label} tidak valid. Gunakan file assets yang ada atau video dari Vercel Blob. `);
    return input;
  };
  let galleryVideos = null;
  if (Array.isArray(value.galleryVideos)) {
    if (value.galleryVideos.length > 30) throw new Error('Galeri website dapat menampilkan maksimal 30 video.');
    const seenVideoUrls = new Set();
    galleryVideos = value.galleryVideos.map((video, index) => {
      if (!video || typeof video !== 'object') throw new Error(`Data video galeri nomor ${index + 1} tidak valid.`);
      const url = validateVideoPath(video.url, `video Galeri website nomor ${index + 1}`);
      if (!url) throw new Error(`Alamat video galeri nomor ${index + 1} wajib diisi.`);
      if (seenVideoUrls.has(url)) throw new Error('Ada video duplikat di galeri. Muat ulang data lalu coba lagi.');
      seenVideoUrls.add(url);
      if (typeof video.hidden !== 'boolean') throw new Error(`Status video nomor ${index + 1} tidak valid.`);
      return { url, hidden: video.hidden };
    });
  }
  // These compatibility fields are still returned to old admin tabs, but v9
  // only updates videos when galleryVideos[] is included in the request.
  const galleryVideo = validateVideoPath(value.galleryVideo, 'video Galeri website');
  const galleryVideoArchive = validateVideoPath(value.galleryVideoArchive, 'video arsip Galeri website');
  const seenIds = new Set();
  const products = value.products.map((product, index) => {
    if (!product || typeof product.id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(product.id)) throw new Error(`ID produk ${index + 1} tidak valid.`);
    const id = product.id.toLowerCase();
    if (seenIds.has(id)) throw new Error('Ada ID produk yang duplikat. Muat ulang halaman admin lalu coba lagi.');
    seenIds.add(id);
    const category = String(product.category || '').toLowerCase();
    if (!CATEGORIES[category]) throw new Error(`Kategori produk ${index + 1} tidak valid.`);
    const badgeClass = String(product.badgeClass || '').toLowerCase();
    if (!BADGE_CLASSES.has(badgeClass)) throw new Error(`Gaya label produk ${index + 1} tidak valid.`);
    return {
      id,
      name: text(product.name, `Nama produk ${index + 1}`, 100),
      badge: text(product.badge, `Badge produk ${index + 1}`, 80),
      badgeClass,
      category,
      oldPrice: price(product.oldPrice, `Harga lama produk ${index + 1}`),
      price: price(product.price, `Harga produk ${index + 1}`),
    };
  });
  return {
    contact: {
      location: text(value.contact?.location, 'Lokasi toko', 120),
      phonePrimary: phone(value.contact?.phonePrimary, 'Nomor telepon'),
      phoneWhatsapp: phone(value.contact?.phoneWhatsapp, 'Nomor WhatsApp'),
      email: text(value.contact?.email, 'Email / kontak', 120),
      hours: text(value.contact?.hours, 'Jam operasional', 120),
    },
    hero: {
      title: text(value.hero?.title, 'Judul utama', 100),
      subtitle: text(value.hero?.subtitle, 'Subjudul utama', 180),
      story: text(value.hero?.story, 'Teks hero', 250),
      tagline: text(value.hero?.tagline, 'Tagline hero', 250),
    },
    about: {
      title: text(value.about?.title, 'Judul tentang toko', 120),
      paragraph1: text(value.about?.paragraph1, 'Deskripsi toko 1', 500),
      paragraph2: text(value.about?.paragraph2, 'Deskripsi toko 2', 500),
    },
    promos: value.promos.map((item, index) => text(item, `Promo ${index + 1}`, 180)),
    products,
    testimonials: value.testimonials.map((item, index) => ({
      text: text(item?.text, `Isi testimoni ${index + 1}`, 300),
      name: text(item?.name, `Nama testimoni ${index + 1}`, 80),
    })),
    gallery,
    galleryVideos,
    galleryVideo,
    galleryVideoArchive,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!['GET', 'POST'].includes(req.method)) return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });
  if (!requireAdmin(req, res)) return;
  if (req.method === 'POST' && !isSameOrigin(req)) return sendJson(res, 403, { ok: false, message: 'Permintaan ditolak.' });

  try {
    const file = await getFile('index.html');
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, data: getAdminData(file.content) });
    const updated = updateContent(file.content, req.body);
    if (updated === file.content) return sendJson(res, 200, { ok: true, unchanged: true, message: 'Tidak ada perubahan.' });
    await putFile('index.html', updated, 'Update website content from EGYA DURIAN Admin', file.sha);
    return sendJson(res, 200, { ok: true, message: 'Perubahan tersimpan ke GitHub. Vercel akan menerbitkannya otomatis.' });
  } catch (error) {
    const status = error.status === 409 || error.status === 422 ? 409 : (error.status || 500);
    const message = status === 409
      ? 'File website berubah atau GitHub menolak commit. Muat ulang data lalu coba simpan lagi.'
      : (error.message || 'Gagal memproses perubahan.');
    return sendJson(res, status, { ok: false, message });
  }
};

// Shared by the admin-only permanent video deletion endpoint.
module.exports.getAdminData = getAdminData;
module.exports.updateContent = updateContent;
