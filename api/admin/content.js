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

function getMetaContent(html, name) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (getAttribute(match[0], 'name').toLowerCase() === String(name).toLowerCase()) return getAttribute(match[0], 'content');
  }
  return '';
}
function getTagTextById(html, tagName, id) {
  const pattern = new RegExp(`<${tagName}\\b(?=[^>]*\\bid=["']${id.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}["'])[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = html.match(pattern);
  return match ? plainText(match[1]) : '';
}
function getAttributeById(html, tagName, id, attribute) {
  for (const match of html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'gi'))) {
    if (getAttribute(match[0], 'id') === id) return getAttribute(match[0], attribute);
  }
  return '';
}
function getImageSourceByClass(html, className) {
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    if (classTokens(match[0]).includes(className)) return getAttribute(match[0], 'src');
  }
  return '';
}
function getFirstImageSource(block) {
  const match = block.match(/<img\b[^>]*>/i);
  return match ? getAttribute(match[0], 'src') : '';
}
function getCustomSocialIconPath(html, platform) {
  for (const className of ['hero-social', 'footer-social']) {
    const region = findElementByClass(html, 'div', className);
    if (!region) continue;
    for (const anchor of region.text.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
      for (const image of anchor[0].matchAll(/<img\b[^>]*>/gi)) {
        if (getAttribute(image[0], 'data-social-platform').toLowerCase() === platform) return getAttribute(image[0], 'src');
      }
    }
  }
  return '';
}
function getSocialUrl(html, platform) {
  const iconPattern = {
    facebook: /\bfa-facebook(?:-f)?\b/i,
    instagram: /\bfa-instagram\b/i,
    tiktok: /\bfa-tiktok\b/i,
  }[platform];
  if (!iconPattern) return '';
  for (const className of ['hero-social', 'footer-social']) {
    const region = findElementByClass(html, 'div', className);
    if (!region) continue;
    for (const anchor of region.inner.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
      const icon = (anchor[0].match(/<(?:i|img)\b[^>]*>/i) || [''])[0];
      if (iconPattern.test(getAttribute(icon, 'class')) || getAttribute(icon, 'data-social-platform').toLowerCase() === platform) {
        const url = getAttribute((anchor[0].match(/^<a\b[^>]*>/i) || [''])[0], 'href');
        if (url && url !== '#') return url;
      }
    }
  }
  return '';
}
function getAnchorSettings(regionText) {
  return [...String(regionText || '').matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map(match => {
    const opening = (match[0].match(/^<a\b[^>]*>/i) || [''])[0];
    return { href: getAttribute(opening, 'href'), text: plainText(match[0].replace(opening, '').replace(/<\/a>\s*$/i, '')) };
  });
}
function getNavLabels(html, footer = false) {
  const region = footer ? findElementByClass(html, 'div', 'footer-links') : (html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/i) ? { text: html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/i)[0] } : null);
  const links = getAnchorSettings(region ? (region.text || region.inner || '') : '');
  const result = {};
  for (const link of links) {
    const key = String(link.href || '').replace(/^#/, '');
    if (['home','products','about','gallery','testimonials','contact'].includes(key)) result[key] = link.text;
  }
  return result;
}
function getFaqData(html) {
  const section = findElementByClass(html, 'section', 'faq');
  if (!section) return { title: 'FAQ', items: [] };
  const items = extractAllDivsByClass(section.text, 'faq-item').map(item => {
    const answer = findElementByClass(item.text, 'div', 'faq-answer');
    return {
      question: plainText(tagValue(item.text, 'button')),
      answer: plainText(answer ? tagValue(answer.text, 'p') : tagValue(item.text, 'p')),
    };
  });
  return { title: plainText(tagValue(section.text, 'h2')) || 'FAQ', items };
}
function extractSiteSettings(html) {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const logoRegion = findElementByClass(html, 'div', 'logo');
  const logoTextRegion = findElementByClass(html, 'div', 'logo-text');
  const footerBrand = findElementByClass(html, 'div', 'footer-brand');
  const footerLinks = findElementByClass(html, 'div', 'footer-links');
  const footerSocial = findElementByClass(html, 'div', 'footer-social');
  const heroRatingRegion = findElementByClass(html, 'div', 'hero-rating');
  const heroStatsRegion = findElementByClass(html, 'div', 'hero-stats');
  const lowerStatsRegion = findElementByClass(html, 'section', 'stats');
  const filterRegion = findElementByClass(html, 'section', 'filter-wrapper');
  const cartHeaderRegion = findElementByClass(html, 'div', 'cart-header');
  const cartFooterRegion = findElementByClass(html, 'div', 'cart-footer');
  const paymentSelect = (html.match(/<select\b(?=[^>]*\bid=["']payment-method["'])[^>]*>[\s\S]*?<\/select>/i) || [''])[0];
  const cartTotalHeading = cartFooterRegion ? [...cartFooterRegion.text.matchAll(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi)].find(match => /\bid=["']cart-total["']/i.test(match[0])) : null;
  const cartTotalLabel = cartTotalHeading ? plainText(cartTotalHeading[0].replace(/<span\b(?=[^>]*\bid=["']cart-total["'])[^>]*>[\s\S]*?<\/span>/i, '')) : '';
  const filterLabels = {};
  if (filterRegion) {
    for (const match of filterRegion.text.matchAll(/<button\b(?=[^>]*\bdata-category=["']([^"']+)["'])[^>]*>[\s\S]*?<\/button>/gi)) {
      filterLabels[getAttribute((match[0].match(/^<button\b[^>]*>/i) || [''])[0], 'data-category')] = plainText(match[0].replace((match[0].match(/^<button\b[^>]*>/i) || [''])[0], '').replace(/<\/button>\s*$/i, ''));
    }
  }
  const paymentOptions = [...paymentSelect.matchAll(/<option\b[^>]*>[\s\S]*?<\/option>/gi)].map(match => plainText(match[0]));
  const addToCartButton = [...html.matchAll(/<button\b(?=[^>]*\bclass=["'][^"']*\bbuy-btn\b[^"']*["'])[^>]*>[\s\S]*?<\/button>/gi)][0];
  const heroSlides = [...html.matchAll(/<div\b(?=[^>]*\bclass=["'][^"']*\bhero-slide\b[^"']*["'])[^>]*>[\s\S]*?<\/div>/gi)];
  const navRegion = (html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/i) || [''])[0];
  const heroButtonsRegion = findElementByClass(html, 'div', 'hero-buttons');
  const faqData = getFaqData(html);
  const mapRegion = findElementByClass(html, 'section', 'maps');
  const galleryRegion = getRegion(html, /<section\b(?=[^>]*\bid=["']gallery["'])[\s\S]*?<\/section>/i, 'gallery website').text;
  const testimonialRegion = getRegion(html, /<section\b(?=[^>]*\bid=["']testimonials["'])[\s\S]*?<\/section>/i, 'testimonials').text;
  const contactRegion = getRegion(html, /<section\b(?=[^>]*\bid=["']contact["'])[\s\S]*?<\/section>/i, 'contact').text;
  const faviconMatch = [...html.matchAll(/<link\b[^>]*>/gi)].find(match => /(?:^|\s)icon(?:\s|$)/i.test(getAttribute(match[0], 'rel')));
  const heroStatValues = heroStatsRegion ? [...heroStatsRegion.text.matchAll(/<h3\b[^>]*class=["'][^"']*\bcounter\b[^"']*["'][^>]*>/gi)].map(match => getAttribute(match[0], 'data-target')) : [];
  const heroStatLabels = heroStatsRegion ? [...heroStatsRegion.text.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(match => plainText(match[1])) : [];
  const lowerStatCards = lowerStatsRegion ? extractAllDivsByClass(lowerStatsRegion.text, 'stat-box') : [];
  const phoneSource = getTagTextById(html, 'p', 'modalDesc');
  const siteSettings = {
    brandName: plainText(logoTextRegion ? tagValue(logoTextRegion.text, 'h2') : '') || 'EGYA DURIAN',
    brandTagline: plainText(logoTextRegion ? tagValue(logoTextRegion.text, 'span') : ''),
    facebookUrl: getSocialUrl(html, 'facebook'),
    instagramUrl: getSocialUrl(html, 'instagram'),
    tiktokUrl: getSocialUrl(html, 'tiktok'),
    facebookIconPath: getCustomSocialIconPath(html, 'facebook'),
    instagramIconPath: getCustomSocialIconPath(html, 'instagram'),
    tiktokIconPath: getCustomSocialIconPath(html, 'tiktok'),
    whatsappIconPath: getCustomSocialIconPath(html, 'whatsapp'),
    pageTitle: plainText(titleMatch ? titleMatch[1] : ''),
    metaDescription: getMetaContent(html, 'description'),
    metaKeywords: getMetaContent(html, 'keywords'),
    metaAuthor: getMetaContent(html, 'author'),
    headerLogoPath: getFirstImageSource(logoRegion ? logoRegion.text : ''),
    heroLogoPath: getImageSourceByClass(html, 'hero-logo'),
    verifiedIconPath: getImageSourceByClass(html, 'verified-icon'),
    faviconPath: faviconMatch ? getAttribute(faviconMatch[0], 'href') : '',
    heroBanners: heroSlides.slice(0, 3).map(match => getFirstImageSource(match[0])),
    heroRating: plainText(heroRatingRegion ? heroRatingRegion.text : ''),
    filterLabels,
    cartTitle: plainText(cartHeaderRegion ? tagValue(cartHeaderRegion.text, 'h2') : ''),
    cartTotalLabel,
    applyVoucherButtonLabel: getTagTextById(html, 'button', 'applyVoucher'),
    discountInfoText: getTagTextById(html, 'p', 'discountInfo'),
    paymentOptions,
    checkoutButtonLabel: getTagTextById(html, 'button', 'checkoutBtn'),
    productAddButtonLabel: addToCartButton ? plainText(addToCartButton[0]) : '',
    toastText: getTagTextById(html, 'div', 'toast'),
    heroStats: [0,1,2].map(index => ({ value: String(heroStatValues[index] || ''), label: heroStatLabels[index] || '' })),
    lowerStats: [0,1,2,3].map(index => ({
      value: lowerStatCards[index] ? plainText(tagValue(lowerStatCards[index].text, 'h2')) : '',
      label: lowerStatCards[index] ? plainText(tagValue(lowerStatCards[index].text, 'p')) : '',
    })),
    navLabels: getNavLabels(html, false),
    footerNavLabels: getNavLabels(html, true),
    heroButtons: getAnchorSettings(heroButtonsRegion ? heroButtonsRegion.text : '').slice(0, 2),
    galleryTitle: plainText(tagValue(galleryRegion, 'h2')),
    testimonialTitle: plainText(tagValue(testimonialRegion, 'h2')),
    contactTitle: plainText(tagValue(contactRegion, 'h2')),
    mapTitle: plainText(mapRegion ? tagValue(mapRegion.text, 'h2') : ''),
    mapEmbedUrl: (() => { const region = mapRegion ? mapRegion.text : ''; const iframe = (region.match(/<iframe\b[^>]*>/i) || [''])[0]; return getAttribute(iframe, 'src'); })(),
    footerMenuTitle: plainText(footerLinks ? tagValue(footerLinks.text, 'h4') : ''),
    footerSocialTitle: plainText(footerSocial ? tagValue(footerSocial.text, 'h4') : ''),
    footerCopy: plainText((findElementByClass(html, 'div', 'footer-bottom') || {}).text || ''),
    memberPlaceholder: getAttributeById(html, 'input', 'memberName', 'placeholder'),
    memberButtonLabel: getTagTextById(html, 'button', 'saveMember'),
    searchPlaceholder: getAttributeById(html, 'input', 'searchInput', 'placeholder'),
    contactFormNamePlaceholder: getAttributeById(html, 'input', 'nama', 'placeholder'),
    contactFormCityPlaceholder: getAttributeById(html, 'input', 'kota', 'placeholder'),
    contactFormMessagePlaceholder: getAttributeById(html, 'textarea', 'pesan', 'placeholder'),
    contactFormButton: (() => { const m = contactRegion.match(/<button\b[^>]*>[\s\S]*?<\/button>/i); return m ? plainText(m[0]) : ''; })(),
    faqTitle: faqData.title,
    faqs: faqData.items,
    modalDescription: phoneSource,
    cartEmptyText: (() => { const m = html.match(/<div\b(?=[^>]*\bid=["']cart-items["'])[^>]*>([\s\S]*?)<\/div>/i); return m ? plainText(tagValue(m[1], 'p')) : ''; })(),
    couponPlaceholder: getAttributeById(html, 'input', 'voucher', 'placeholder') || getAttributeById(html, 'input', 'voucherInput', 'placeholder'),
  };
  while (siteSettings.heroBanners.length < 3) siteSettings.heroBanners.push('');
  while (siteSettings.heroStats.length < 3) siteSettings.heroStats.push({ value: '', label: '' });
  while (siteSettings.lowerStats.length < 4) siteSettings.lowerStats.push({ value: '', label: '' });
  return siteSettings;
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
    siteSettings: extractSiteSettings(html),
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

function updateRegionByClass(html, tagName, className, transform, label = className) {
  const region = findElementByClass(html, tagName, className);
  if (!region) throw new Error(`Bagian ${label} tidak ditemukan.`);
  const next = transform(region.text);
  return html.slice(0, region.start) + next + html.slice(region.end);
}
function updateMetaContent(html, name, value) {
  let found = false;
  const result = html.replace(/<meta\b[^>]*>/gi, tag => {
    if (found || getAttribute(tag, 'name').toLowerCase() !== name.toLowerCase()) return tag;
    found = true;
    return setAttribute(tag, 'content', value);
  });
  if (found) return result;
  return result.replace(/<\/head>/i, `<meta name="${htmlEscape(name)}" content="${htmlEscape(value)}">\n</head>`);
}
function replaceTextById(html, tagName, id, value) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(<${tagName}\\b(?=[^>]*\\bid=["']${escapedId}["'])[^>]*>)[\\s\\S]*?(<\\/${tagName}>)`, 'i');
  if (!pattern.test(html)) return html;
  return html.replace(pattern, `$1${htmlEscape(value)}$2`);
}
function replaceAttributeById(html, tagName, id, attribute, value) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<${tagName}\\b(?=[^>]*\\bid=["']${escapedId}["'])[^>]*>`, 'i');
  const match = html.match(pattern);
  if (!match) return html;
  return html.replace(match[0], setAttribute(match[0], attribute, value));
}
function updateSocialLinksInRegion(block, platform, url) {
  const platformPattern = {
    facebook: /\bfa-facebook(?:-f)?\b/i,
    instagram: /\bfa-instagram\b/i,
    tiktok: /\bfa-tiktok\b/i,
  }[platform];
  if (!platformPattern) return block;
  return block.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, anchor => {
    const opening = (anchor.match(/^<a\b[^>]*>/i) || [''])[0];
    const icon = (anchor.match(/<(?:i|img)\b[^>]*>/i) || [''])[0];
    if (!platformPattern.test(getAttribute(icon, 'class')) && getAttribute(icon, 'data-social-platform').toLowerCase() !== platform) return anchor;
    let nextOpen = setAttribute(opening, 'href', url || '#');
    nextOpen = url ? removeAttribute(nextOpen, 'hidden') : setAttribute(nextOpen, 'hidden', 'hidden');
    return nextOpen + anchor.slice(opening.length);
  });
}
function updateNavRegion(block, labels) {
  return block.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, anchor => {
    const opening = (anchor.match(/^<a\b[^>]*>/i) || [''])[0];
    const key = getAttribute(opening, 'href').replace(/^#/, '');
    if (!Object.prototype.hasOwnProperty.call(labels, key)) return anchor;
    return `${opening}${htmlEscape(labels[key])}</a>`;
  });
}
function updateHeroButtons(block, buttons) {
  const rendered = block.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (anchor, offset) => {
    const opening = (anchor.match(/^<a\b[^>]*>/i) || [''])[0];
    const index = [...block.slice(0, offset).matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].length;
    const item = buttons[index];
    if (!item) return anchor;
    const nextOpen = setAttribute(setAttribute(opening, 'href', item.href), 'aria-label', item.text);
    return `${nextOpen}${htmlEscape(item.text)}</a>`;
  });
  return rendered;
}
function updateHeroStatData(block, stats) {
  let index = 0;
  let updated = block.replace(/<h3\b[^>]*class=["'][^"']*\bcounter\b[^"']*["'][^>]*>[\s\S]*?<\/h3>/gi, tag => {
    const opening = (tag.match(/^<h3\b[^>]*>/i) || [''])[0];
    const item = stats[index++];
    return item ? tag.replace(opening, setAttribute(opening, 'data-target', item.value)) : tag;
  });
  stats.forEach((item, spanIndex) => { updated = replaceTagByIndex(updated, 'span', spanIndex, item.label); });
  return updated;
}
function updateLowerStats(block, stats) {
  let updated = block;
  stats.forEach((item, index) => {
    updated = replaceTagByIndex(updated, 'h2', index, item.value);
    updated = replaceTagByIndex(updated, 'p', index, item.label);
  });
  return updated;
}
function updateFaqSection(html, settings) {
  const region = findElementByClass(html, 'section', 'faq');
  if (!region) throw new Error('Bagian FAQ tidak ditemukan.');
  const questions = settings.faqs.map(item => `<div class="faq-item">\n\n<button class="faq-question">\n\n${htmlEscape(item.question)}\n\n</button>\n\n<div class="faq-answer">\n\n<p>\n\n${htmlEscape(item.answer)}\n\n</p>\n\n</div>\n\n</div>`).join('\n\n');
  const next = `${region.openTag}\n\n<h2>\n\n${htmlEscape(settings.faqTitle)}\n\n</h2>\n\n${questions}\n\n${region.closeTag}`;
  return html.slice(0, region.start) + next + html.slice(region.end);
}
function updateWhatsAppLinks(html, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return html;
  let updated = html.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, anchor => {
    const opening = (anchor.match(/^<a\b[^>]*>/i) || [''])[0];
    const icon = (anchor.match(/<i\b[^>]*>/i) || [''])[0];
    const isWhatsApp = /wa\.me\//i.test(getAttribute(opening, 'href')) || /\bfa-whatsapp\b/i.test(getAttribute(icon, 'class'));
    if (!isWhatsApp) return anchor;
    const floating = classTokens(opening).includes('floating-wa');
    const url = `https://wa.me/${digits}${floating ? '?text=Halo%20EGYA%20DURIAN' : ''}`;
    return setAttribute(opening, 'href', url) + anchor.slice(opening.length);
  });
  const bodyOpen = (updated.match(/<body\b[^>]*>/i) || [''])[0];
  if (bodyOpen) updated = updated.replace(bodyOpen, setAttribute(bodyOpen, 'data-admin-whatsapp-number', digits));
  return updated;
}
function updateFilterLabels(block, labels) {
  return block.replace(/<button\b(?=[^>]*\bdata-category=["']([^"']+)["'])[^>]*>[\s\S]*?<\/button>/gi, (button, category) => {
    const opening = (button.match(/^<button\b[^>]*>/i) || [''])[0];
    if (!Object.prototype.hasOwnProperty.call(labels, category)) return button;
    return `${opening}\n\n${htmlEscape(labels[category])}\n\n</button>`;
  });
}
function updateCartTotalLabel(block, label) {
  return block.replace(/<h3\b[^>]*>[\s\S]*?<span\b(?=[^>]*\bid=["']cart-total["'])[^>]*>[\s\S]*?<\/span>[\s\S]*?<\/h3>/i, heading => {
    const opening = (heading.match(/^<h3\b[^>]*>/i) || [''])[0];
    const total = (heading.match(/<span\b(?=[^>]*\bid=["']cart-total["'])[^>]*>[\s\S]*?<\/span>/i) || [''])[0];
    if (!opening || !total) return heading;
    return `${opening}\n\n${htmlEscape(label)}\n\n${total}\n\n</h3>`;
  });
}
function updatePaymentOptions(html, labels) {
  const select = (html.match(/<select\b(?=[^>]*\bid=["']payment-method["'])[^>]*>[\s\S]*?<\/select>/i) || [''])[0];
  if (!select) return html;
  let index = 0;
  const updatedSelect = select.replace(/<option\b[^>]*>[\s\S]*?<\/option>/gi, option => {
    const item = labels[index++];
    if (item === undefined) return option;
    const opening = (option.match(/^<option\b[^>]*>/i) || [''])[0];
    return `${opening}${htmlEscape(item)}</option>`;
  });
  return html.replace(select, updatedSelect);
}
function updateProductAddButtonLabels(html, label) {
  return html.replace(/<button\b(?=[^>]*\bclass=["'][^"']*\bbuy-btn\b[^"']*["'])[^>]*>[\s\S]*?<\/button>/gi, button => {
    const opening = (button.match(/^<button\b[^>]*>/i) || [''])[0];
    return `${opening}\n\n${htmlEscape(label)}\n\n</button>`;
  });
}
function updateSiteSettings(html, settings, current) {
  let updated = html;
  const changed = (key) => JSON.stringify(settings[key]) !== JSON.stringify(current[key]);
  if (settings.pageTitle !== current.pageTitle) {
    if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(updated)) updated = updated.replace(/(<title\b[^>]*>)[\s\S]*?(<\/title>)/i, `$1${htmlEscape(settings.pageTitle)}$2`);
  }
  for (const [key, name] of [['metaDescription','description'],['metaKeywords','keywords'],['metaAuthor','author']]) {
    if (settings[key] !== current[key]) updated = updateMetaContent(updated, name, settings[key]);
  }
  if (settings.brandName !== current.brandName) {
    updated = updateRegionByClass(updated, 'div', 'logo-text', block => {
      const h2 = block.match(/<h2\b[^>]*>[\s\S]*?<\/h2>/i);
      if (!h2) return block;
      const updatedH2 = h2[0].replace(/^(<h2\b[^>]*>)[\s\S]*?(<img\b(?=[^>]*\bclass=["'][^"']*\bverified-icon\b[^"']*["'])[^>]*>)/i, `$1${htmlEscape(settings.brandName)} $2`);
      if (updatedH2 !== h2[0]) return block.replace(h2[0], updatedH2);
      return replaceTagText(block, 'h2', settings.brandName);
    }, 'logo header');
    updated = updateRegionByClass(updated, 'div', 'loader-content', block => replaceTagText(block, 'h2', settings.brandName), 'logo loader');
    updated = updateRegionByClass(updated, 'div', 'footer-brand', block => replaceTagText(block, 'h3', `🍈 ${settings.brandName}`), 'brand footer');
  }
  if (settings.brandTagline !== current.brandTagline) {
    updated = updateRegionByClass(updated, 'div', 'logo-text', block => replaceTagText(block, 'span', settings.brandTagline), 'tagline header');
    updated = updateRegionByClass(updated, 'div', 'footer-brand', block => replaceTagText(block, 'p', settings.brandTagline), 'tagline footer');
  }
  for (const platform of ['facebook','instagram','tiktok']) {
    const key = `${platform}Url`;
    // Keep header/footer links synchronized on every save, including legacy `#` links in the footer.
    for (const group of ['hero-social','footer-social']) {
      const region = findElementByClass(updated, 'div', group);
      if (!region) continue;
      const block = updateSocialLinksInRegion(region.text, platform, settings[key]);
      updated = updated.slice(0, region.start) + block + updated.slice(region.end);
    }
  }
  const headerNavRegex = /<nav\b[^>]*>[\s\S]*?<\/nav>/i;
  if (changed('navLabels') && headerNavRegex.test(updated)) updated = updated.replace(headerNavRegex, block => updateNavRegion(block, settings.navLabels));
  if (changed('footerNavLabels')) updated = updateRegionByClass(updated, 'div', 'footer-links', block => updateNavRegion(block, settings.footerNavLabels), 'menu footer');
  if (changed('heroRating')) updated = updateRegionByClass(updated, 'div', 'hero-rating', block => block.replace(/^(<div\b[^>]*>)[\s\S]*?(<\/div>)$/i, `$1${htmlEscape(settings.heroRating)}$2`), 'rating hero');
  if (changed('filterLabels')) updated = updateRegionByClass(updated, 'section', 'filter-wrapper', block => updateFilterLabels(block, settings.filterLabels), 'filter kategori produk');
  if (settings.cartTitle !== current.cartTitle) updated = updateRegionByClass(updated, 'div', 'cart-header', block => replaceTagText(block, 'h2', settings.cartTitle), 'judul keranjang');
  if (settings.cartTotalLabel !== current.cartTotalLabel) updated = updateRegionByClass(updated, 'div', 'cart-footer', block => updateCartTotalLabel(block, settings.cartTotalLabel), 'label total keranjang');
  if (settings.applyVoucherButtonLabel !== current.applyVoucherButtonLabel) updated = replaceTextById(updated, 'button', 'applyVoucher', settings.applyVoucherButtonLabel);
  if (settings.discountInfoText !== current.discountInfoText) updated = replaceTextById(updated, 'p', 'discountInfo', settings.discountInfoText);
  if (changed('paymentOptions')) updated = updatePaymentOptions(updated, settings.paymentOptions);
  if (settings.checkoutButtonLabel !== current.checkoutButtonLabel) updated = replaceTextById(updated, 'button', 'checkoutBtn', settings.checkoutButtonLabel);
  if (settings.productAddButtonLabel !== current.productAddButtonLabel) updated = updateProductAddButtonLabels(updated, settings.productAddButtonLabel);
  if (settings.toastText !== current.toastText) updated = replaceTextById(updated, 'div', 'toast', settings.toastText);
  if (changed('heroStats')) updated = updateRegionByClass(updated, 'div', 'hero-stats', block => updateHeroStatData(block, settings.heroStats), 'statistik hero');
  if (changed('lowerStats')) {
    const region = findElementByClass(updated, 'section', 'stats');
    if (region) {
      const block = updateLowerStats(region.text, settings.lowerStats);
      updated = updated.slice(0, region.start) + block + updated.slice(region.end);
    }
  }
  if (changed('heroButtons')) updated = updateRegionByClass(updated, 'div', 'hero-buttons', block => updateHeroButtons(block, settings.heroButtons), 'tombol hero');
  for (const [key, id] of [['galleryTitle','gallery'],['testimonialTitle','testimonials'],['contactTitle','contact']]) {
    if (settings[key] === current[key]) continue;
    const region = getRegion(updated, new RegExp(`<section\\b(?=[^>]*\\bid=["']${id}["'])[\\s\\S]*?<\\/section>`, 'i'), `bagian ${id}`);
    const block = replaceTagText(region.text, 'h2', settings[key]);
    updated = updated.slice(0, region.start) + block + updated.slice(region.end);
  }
  if (settings.mapTitle !== current.mapTitle) updated = updateRegionByClass(updated, 'section', 'maps', block => replaceTagText(block, 'h2', settings.mapTitle), 'judul maps');
  if (settings.mapEmbedUrl !== current.mapEmbedUrl) updated = updateRegionByClass(updated, 'section', 'maps', block => {
    const iframe = (block.match(/<iframe\b[^>]*>/i) || [''])[0];
    if (!iframe) throw new Error('Iframe Google Maps tidak ditemukan.');
    return block.replace(iframe, setAttribute(iframe, 'src', settings.mapEmbedUrl));
  }, 'Google Maps');
  if (settings.footerMenuTitle !== current.footerMenuTitle) updated = updateRegionByClass(updated, 'div', 'footer-links', block => replaceTagText(block, 'h4', settings.footerMenuTitle), 'judul menu footer');
  if (settings.footerSocialTitle !== current.footerSocialTitle) updated = updateRegionByClass(updated, 'div', 'footer-social', block => replaceTagText(block, 'h4', settings.footerSocialTitle), 'judul media sosial footer');
  if (settings.footerCopy !== current.footerCopy) updated = updateRegionByClass(updated, 'div', 'footer-bottom', block => block.replace(/^(<div\b[^>]*>)[\s\S]*?(<\/div>)$/i, `$1${htmlEscape(settings.footerCopy)}$2`), 'copyright footer');
  if (settings.memberPlaceholder !== current.memberPlaceholder) updated = replaceAttributeById(updated, 'input', 'memberName', 'placeholder', settings.memberPlaceholder);
  if (settings.memberButtonLabel !== current.memberButtonLabel) updated = replaceTextById(updated, 'button', 'saveMember', settings.memberButtonLabel);
  if (settings.searchPlaceholder !== current.searchPlaceholder) updated = replaceAttributeById(updated, 'input', 'searchInput', 'placeholder', settings.searchPlaceholder);
  if (settings.contactFormNamePlaceholder !== current.contactFormNamePlaceholder) updated = replaceAttributeById(updated, 'input', 'nama', 'placeholder', settings.contactFormNamePlaceholder);
  if (settings.contactFormCityPlaceholder !== current.contactFormCityPlaceholder) updated = replaceAttributeById(updated, 'input', 'kota', 'placeholder', settings.contactFormCityPlaceholder);
  if (settings.contactFormMessagePlaceholder !== current.contactFormMessagePlaceholder) updated = replaceAttributeById(updated, 'textarea', 'pesan', 'placeholder', settings.contactFormMessagePlaceholder);
  if (settings.contactFormButton !== current.contactFormButton) updated = updateRegionByClass(updated, 'section', 'contact', block => block.replace(/(<button\b[^>]*type=["']submit["'][^>]*>)[\s\S]*?(<\/button>)/i, `$1${htmlEscape(settings.contactFormButton)}$2`), 'tombol formulir kontak');
  if (settings.faqTitle !== current.faqTitle || changed('faqs')) updated = updateFaqSection(updated, settings);
  if (settings.modalDescription !== current.modalDescription) updated = replaceTextById(updated, 'p', 'modalDesc', settings.modalDescription);
  if (settings.cartEmptyText !== current.cartEmptyText) {
    const regionMatch = updated.match(/(<div\b[^>]*\bid=["']cart-items["'][^>]*>)[\s\S]*?(<\/div>)/i);
    if (regionMatch) updated = updated.replace(regionMatch[0], `${regionMatch[1]}\n\n<p>\n\n${htmlEscape(settings.cartEmptyText)}\n\n</p>\n\n${regionMatch[2]}`);
  }
  if (settings.couponPlaceholder !== current.couponPlaceholder && settings.couponPlaceholder) {
    const inputRegex = /<input\b[^>]*placeholder=["']Masukkan Voucher["'][^>]*>/i;
    if (inputRegex.test(updated)) updated = updated.replace(inputRegex, tag => setAttribute(tag, 'placeholder', settings.couponPlaceholder));
  }
  return updated;
}

function updateContent(html, submitted) {
  const current = getAdminData(html);
  const input = validatePayload(submitted, current.siteSettings);
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

  if (input.siteSettings && JSON.stringify(input.siteSettings) !== JSON.stringify(current.siteSettings)) {
    updated = updateSiteSettings(updated, input.siteSettings, current.siteSettings);
  }
  // Make every WhatsApp entry point, including checkout/contact form runtime defaults, use one number.
  updated = updateWhatsAppLinks(updated, input.contact.phoneWhatsapp);
  return updated;
}
function validatePayload(value, defaultSiteSettings = {}) {
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
  const rawSite = value.siteSettings && typeof value.siteSettings === 'object' ? value.siteSettings : defaultSiteSettings;
  const siteText = (input, name, max = 250) => {
    if (typeof input !== 'string') throw new Error(`Kolom ${name} tidak valid.`);
    const result = input.trim();
    if (!result || result.length > max) throw new Error(`${name} wajib diisi dan maksimal ${max} karakter.`);
    return result;
  };
  const optionalSiteText = (input, name, max = 500) => {
    if (typeof input !== 'string') throw new Error(`Kolom ${name} tidak valid.`);
    const result = input.trim();
    if (result.length > max) throw new Error(`${name} maksimal ${max} karakter.`);
    return result;
  };
  const httpsUrl = (input, name, hostPattern, allowEmpty = true) => {
    if (typeof input !== 'string') throw new Error(`URL ${name} tidak valid.`);
    const result = input.trim();
    if (!result && allowEmpty) return '';
    let url;
    try { url = new URL(result); } catch { throw new Error(`URL ${name} tidak valid.`); }
    if (url.protocol !== 'https:' || !hostPattern.test(url.hostname) || url.username || url.password) throw new Error(`URL ${name} harus HTTPS dari layanan yang sesuai.`);
    return url.toString();
  };
  const internalHref = (input, name) => {
    if (typeof input !== 'string' || !['#home','#products','#about','#gallery','#testimonials','#contact'].includes(input.trim())) throw new Error(`Tujuan ${name} harus menuju bagian website yang tersedia.`);
    return input.trim();
  };
  const assetPath = (input, name, allowEmpty = false) => {
    if (typeof input !== 'string') throw new Error(`Path ${name} tidak valid.`);
    const result = input.trim();
    if (!result && allowEmpty) return '';
    if (!/^assets\/[A-Za-z0-9._/-]+\.(?:jpe?g|png|webp|svg|ico)$/i.test(result) || result.includes('..') || result.includes('//')) throw new Error(`Path ${name} harus menunjuk file gambar di folder assets.`);
    return result;
  };
  const socialUrl = {
    facebookUrl: httpsUrl(rawSite.facebookUrl, 'Facebook', /(^|\.)facebook\.com$/i),
    instagramUrl: httpsUrl(rawSite.instagramUrl, 'Instagram', /(^|\.)instagram\.com$/i),
    tiktokUrl: httpsUrl(rawSite.tiktokUrl, 'TikTok', /(^|\.)tiktok\.com$/i),
  };
  const socialIconPaths = {
    facebookIconPath: assetPath(rawSite.facebookIconPath || '', 'ikon Facebook', true),
    instagramIconPath: assetPath(rawSite.instagramIconPath || '', 'ikon Instagram', true),
    tiktokIconPath: assetPath(rawSite.tiktokIconPath || '', 'ikon TikTok', true),
    whatsappIconPath: assetPath(rawSite.whatsappIconPath || '', 'ikon WhatsApp', true),
  };
  const navKeys = ['home','products','about','gallery','testimonials','contact'];
  const navLabels = {};
  for (const key of navKeys) navLabels[key] = siteText(rawSite.navLabels?.[key] || defaultSiteSettings.navLabels?.[key] || key, `Label menu ${key}`, 50);
  const footerNavLabels = {};
  for (const key of ['home','products','about','gallery','contact']) footerNavLabels[key] = siteText(rawSite.footerNavLabels?.[key] || defaultSiteSettings.footerNavLabels?.[key] || key, `Label footer ${key}`, 50);
  if (!Array.isArray(rawSite.heroButtons) || rawSite.heroButtons.length !== 2) throw new Error('Harus ada dua tombol hero.');
  const heroButtons = rawSite.heroButtons.map((item, index) => ({
    text: siteText(item?.text, `Teks tombol hero ${index + 1}`, 80),
    href: internalHref(item?.href, `tombol hero ${index + 1}`),
  }));
  const validateStatList = (items, count, label, numericValue = false) => {
    if (!Array.isArray(items) || items.length !== count) throw new Error(`${label} harus berisi ${count} item.`);
    return items.map((item, index) => {
      const statValue = siteText(String(item?.value ?? ''), `${label} nilai ${index + 1}`, 40);
      if (numericValue && !/^\d{1,8}$/.test(statValue)) throw new Error(`${label} nilai ${index + 1} harus berupa angka tanpa pemisah.`);
      return { value: statValue, label: siteText(item?.label, `${label} label ${index + 1}`, 80) };
    });
  };
  if (!Array.isArray(rawSite.faqs) || rawSite.faqs.length > 20) throw new Error('FAQ maksimal 20 pertanyaan.');
  const siteSettings = {
    brandName: siteText(rawSite.brandName, 'Nama brand', 80),
    brandTagline: siteText(rawSite.brandTagline, 'Tagline brand', 120),
    ...socialUrl,
    ...socialIconPaths,
    pageTitle: siteText(rawSite.pageTitle, 'Judul halaman / SEO title', 120),
    metaDescription: optionalSiteText(rawSite.metaDescription, 'Deskripsi SEO', 300),
    metaKeywords: optionalSiteText(rawSite.metaKeywords, 'Kata kunci SEO', 500),
    metaAuthor: siteText(rawSite.metaAuthor, 'Nama penulis / author', 80),
    headerLogoPath: assetPath(rawSite.headerLogoPath || defaultSiteSettings.headerLogoPath, 'logo header'),
    heroLogoPath: assetPath(rawSite.heroLogoPath || defaultSiteSettings.heroLogoPath, 'logo hero'),
    verifiedIconPath: assetPath(rawSite.verifiedIconPath || defaultSiteSettings.verifiedIconPath || 'assets/verified.png', 'ikon verifikasi'),
    faviconPath: assetPath(rawSite.faviconPath || defaultSiteSettings.faviconPath || 'assets/logo01.png', 'favicon', true),
    heroBanners: (() => { if (!Array.isArray(rawSite.heroBanners) || rawSite.heroBanners.length !== 3) throw new Error('Hero harus memiliki tiga banner.'); return rawSite.heroBanners.map((path, index) => assetPath(path, `banner ${index + 1}`)); })(),
    heroRating: siteText(rawSite.heroRating, 'Teks rating hero', 200),
    filterLabels: (() => {
      const keys = ['all','musang','blackthorn','monthong','kupas','pancake','pancakeroll','lainnya'];
      const result = {};
      for (const key of keys) result[key] = siteText(rawSite.filterLabels?.[key], `Label filter ${key}`, 60);
      return result;
    })(),
    cartTitle: siteText(rawSite.cartTitle, 'Judul keranjang', 80),
    cartTotalLabel: siteText(rawSite.cartTotalLabel, 'Label total keranjang', 80),
    applyVoucherButtonLabel: siteText(rawSite.applyVoucherButtonLabel, 'Teks tombol voucher', 80),
    discountInfoText: siteText(rawSite.discountInfoText, 'Teks informasi diskon', 120),
    paymentOptions: (() => {
      if (!Array.isArray(rawSite.paymentOptions) || rawSite.paymentOptions.length !== 3) throw new Error('Metode pembayaran harus memiliki tiga pilihan.');
      return rawSite.paymentOptions.map((item, index) => siteText(item, `Metode pembayaran ${index + 1}`, 60));
    })(),
    checkoutButtonLabel: siteText(rawSite.checkoutButtonLabel, 'Teks tombol checkout', 80),
    productAddButtonLabel: siteText(rawSite.productAddButtonLabel, 'Teks tombol tambah produk', 80),
    toastText: siteText(rawSite.toastText, 'Teks notifikasi', 120),
    heroStats: validateStatList(rawSite.heroStats, 3, 'Statistik hero', true),
    lowerStats: validateStatList(rawSite.lowerStats, 4, 'Statistik bawah'),
    navLabels,
    footerNavLabels,
    heroButtons,
    galleryTitle: siteText(rawSite.galleryTitle, 'Judul galeri', 100),
    testimonialTitle: siteText(rawSite.testimonialTitle, 'Judul testimoni', 100),
    contactTitle: siteText(rawSite.contactTitle, 'Judul kontak', 100),
    mapTitle: siteText(rawSite.mapTitle, 'Judul peta', 100),
    mapEmbedUrl: httpsUrl(rawSite.mapEmbedUrl, 'Google Maps Embed', /(^|\.)google\.com$/i, false),
    footerMenuTitle: siteText(rawSite.footerMenuTitle, 'Judul menu footer', 80),
    footerSocialTitle: siteText(rawSite.footerSocialTitle, 'Judul sosial footer', 80),
    footerCopy: siteText(rawSite.footerCopy, 'Teks copyright footer', 180),
    memberPlaceholder: siteText(rawSite.memberPlaceholder, 'Placeholder nama member', 80),
    memberButtonLabel: siteText(rawSite.memberButtonLabel, 'Teks tombol member', 80),
    searchPlaceholder: siteText(rawSite.searchPlaceholder, 'Placeholder pencarian', 100),
    contactFormNamePlaceholder: siteText(rawSite.contactFormNamePlaceholder, 'Placeholder nama kontak', 80),
    contactFormCityPlaceholder: siteText(rawSite.contactFormCityPlaceholder, 'Placeholder kota kontak', 80),
    contactFormMessagePlaceholder: siteText(rawSite.contactFormMessagePlaceholder, 'Placeholder pesan kontak', 120),
    contactFormButton: siteText(rawSite.contactFormButton, 'Teks tombol formulir kontak', 80),
    faqTitle: siteText(rawSite.faqTitle, 'Judul FAQ', 100),
    faqs: rawSite.faqs.map((item, index) => ({ question: siteText(item?.question, `Pertanyaan FAQ ${index + 1}`, 180), answer: siteText(item?.answer, `Jawaban FAQ ${index + 1}`, 500) })),
    modalDescription: siteText(rawSite.modalDescription, 'Deskripsi modal produk', 500),
    cartEmptyText: siteText(rawSite.cartEmptyText, 'Pesan keranjang kosong', 100),
    couponPlaceholder: siteText(rawSite.couponPlaceholder || defaultSiteSettings.couponPlaceholder || 'Masukkan Voucher', 'Placeholder voucher', 100),
  };
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
    siteSettings,
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
