'use strict';

const { sendJson, requireAdmin, isSameOrigin } = require('../../lib/admin-auth');
const { getFile, putFile } = require('../../lib/github-repo');

const PRODUCTS = [
  { id: 'musang', marker: 'MUSANG KING', next: 'BLACK THORN' },
  { id: 'blackthorn', marker: 'BLACK THORN', next: 'MONTHONG' },
  { id: 'monthong', marker: 'MONTHONG', next: 'DURIAN KUPAS' },
  { id: 'kupas', marker: 'DURIAN KUPAS', next: 'PANCAKE DURIAN' },
  { id: 'pancake', marker: 'PANCAKE DURIAN', next: 'PANCAKE ROLL' },
  { id: 'pancakeroll', marker: 'PANCAKE ROLL', next: null },
];

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
function extractProductChunk(html, definition) {
  const startMarker = `<!-- ${definition.marker} -->`;
  const start = html.indexOf(startMarker);
  if (start < 0) throw new Error(`Penanda produk ${definition.marker} tidak ditemukan di index.html.`);
  let end;
  if (definition.next) {
    end = html.indexOf(`<!-- ${definition.next} -->`, start + startMarker.length);
  } else {
    const sectionEnd = html.indexOf('</section>', start + startMarker.length);
    end = sectionEnd < 0 ? -1 : sectionEnd;
  }
  if (end < 0) throw new Error(`Bagian produk ${definition.marker} tidak lengkap.`);
  return html.slice(start, end);
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
function getRegion(html, regex, label) {
  const match = html.match(regex);
  if (!match) throw new Error(`Bagian ${label} tidak ditemukan di index.html.`);
  return { text: match[0], start: match.index, end: match.index + match[0].length };
}
function getAdminData(html) {
  const contact = getRegion(html, /<section\b(?=[^>]*\bid="contact")[\s\S]*?<\/section>/i, 'contact').text;
  const hero = getRegion(html, /<div\s+class="hero-content">[\s\S]*?<div\s+class="hero-rating">[\s\S]*?<\/div>/i, 'hero').text;
  const about = getRegion(html, /<section\b(?=[^>]*\bid="about")[\s\S]*?<\/section>/i, 'about').text;
  const promo = getRegion(html, /<section\s+class="promo-slider">[\s\S]*?<\/section>/i, 'promo slider').text;
  const testimonial = getRegion(html, /<section\b(?=[^>]*\bid="testimonials")[\s\S]*?<\/section>/i, 'testimonials').text;

  const phoneParagraph = (contact.match(/<p\b[^>]*>\s*📞[\s\S]*?<\/p>/i) || [''])[0];
  const phones = (plainText(phoneParagraph).match(/\+?\d[\d ()-]{6,}\d/g) || []).map(value => value.trim());
  const heroP = Array.from(hero.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)).map(match => plainText(match[1]));
  const promos = Array.from(promo.matchAll(/<div\s+class="slide(?:\s+active)?"[^>]*>([\s\S]*?)<\/div>/gi)).map(match => plainText(match[1]));
  const testimonialCards = Array.from(testimonial.matchAll(/<div\s+class="testimonial-card"[^>]*>[\s\S]*?<\/div>/gi)).map(match => match[0]);
  const testimonials = testimonialCards.slice(0, 3).map(card => ({
    text: plainText(tagValue(card, 'p')),
    name: plainText(tagValue(card, 'strong')).replace(/^[-–]\s*/, ''),
  }));
  const products = PRODUCTS.map(definition => {
    const chunk = extractProductChunk(html, definition);
    const priceText = tagValue(chunk, 'p', 'price');
    const oldPriceText = tagValue(chunk, 'p', 'old-price');
    const badgeMatch = chunk.match(/<span\s+class="product-badge[^\"]*"[^>]*>([\s\S]*?)<\/span>/i);
    return {
      id: definition.id,
      name: plainText(tagValue(chunk, 'h3')),
      badge: plainText(badgeMatch ? badgeMatch[1] : ''),
      oldPrice: amountFromText(oldPriceText),
      price: amountFromText(priceText),
    };
  });

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
    promos: Array.from({ length: 4 }, (_, index) => promos[index] || ''),
    products,
    testimonials: Array.from({ length: 3 }, (_, index) => testimonials[index] || { text: '', name: '' }),
  };
}
function replaceTagText(source, tag, value, className) {
  if (className) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    let replaced = false;
    const result = source.replace(pattern, block => {
      if (replaced || !classTokens(block).includes(className)) return block;
      const match = block.match(new RegExp(`^(<${tag}\\b[^>]*>)[\\s\\S]*?(<\\/${tag}>)$`, 'i'));
      if (!match) return block;
      replaced = true;
      return `${match[1]}${htmlEscape(value)}${match[2]}`;
    });
    if (!replaced) throw new Error(`Elemen ${tag}.${className} tidak ditemukan.`);
    return result;
  }
  const pattern = new RegExp(`(<${tag}\\b[^>]*>)[\\s\\S]*?(<\\/${tag}>)`, 'i');
  if (!pattern.test(source)) throw new Error(`Elemen ${tag} tidak ditemukan.`);
  return source.replace(pattern, (_, open, close) => `${open}${htmlEscape(value)}${close}`);
}
function replaceTagByIndex(source, tag, index, value) {
  let seen = -1;
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  return source.replace(pattern, block => {
    seen += 1;
    if (seen !== index) return block;
    const match = block.match(new RegExp(`^(<${tag}\\b[^>]*>)[\\s\\S]*?(<\\/${tag}>)$`, 'i'));
    if (!match) return block;
    return `${match[1]}${htmlEscape(value)}${match[2]}`;
  });
}
function extractDataPrice(chunk) {
  const match = chunk.match(/data-price="(\d+)"/i);
  return match ? Number(match[1]) : null;
}
function updateProduct(html, definition, updatedProduct, previousProduct) {
  if (updatedProduct.name === previousProduct.name &&
      updatedProduct.badge === previousProduct.badge &&
      Number(updatedProduct.oldPrice) === Number(previousProduct.oldPrice) &&
      Number(updatedProduct.price) === Number(previousProduct.price)) return html;
  const chunk = extractProductChunk(html, definition);
  let changed = chunk;
  if (updatedProduct.name !== previousProduct.name) changed = replaceTagText(changed, 'h3', updatedProduct.name);
  if (Number(updatedProduct.oldPrice) !== Number(previousProduct.oldPrice)) changed = replaceTagText(changed, 'p', rupiah(updatedProduct.oldPrice), 'old-price');
  if (Number(updatedProduct.price) !== Number(previousProduct.price)) {
    changed = replaceTagText(changed, 'p', rupiah(updatedProduct.price), 'price');
    changed = changed.replace(/data-price="\d+"/i, `data-price="${Number(updatedProduct.price)}"`);
  }
  if (updatedProduct.badge !== previousProduct.badge) changed = replaceTagText(changed, 'span', updatedProduct.badge, 'product-badge');
  const start = html.indexOf(chunk);
  return html.slice(0, start) + changed + html.slice(start + chunk.length);
}

function updateContent(html, submitted) {
  const current = getAdminData(html);
  const input = validatePayload(submitted);
  let updated = html;

  if (input.contact.location !== current.contact.location ||
      input.contact.phonePrimary !== current.contact.phonePrimary ||
      input.contact.phoneWhatsapp !== current.contact.phoneWhatsapp ||
      input.contact.email !== current.contact.email ||
      input.contact.hours !== current.contact.hours) {
    const contactRegion = getRegion(updated, /<section\b(?=[^>]*\bid="contact")[\s\S]*?<\/section>/i, 'contact');
    let contact = contactRegion.text;
    if (input.contact.location !== current.contact.location) contact = replaceEmojiParagraph(contact, '📍', input.contact.location);
    if (input.contact.phonePrimary !== current.contact.phonePrimary || input.contact.phoneWhatsapp !== current.contact.phoneWhatsapp) {
      const phonePattern = /(<p\b[^>]*>\s*📞)[\s\S]*?(<\/p>)/i;
      if (!phonePattern.test(contact)) throw new Error('Nomor telepon tidak ditemukan.');
      contact = contact.replace(phonePattern, `$1 ${htmlEscape(input.contact.phonePrimary)} / <i class="fa-brands fa-whatsapp" style="color: #25D366;"></i> ${htmlEscape(input.contact.phoneWhatsapp)}$2`);
    }
    if (input.contact.email !== current.contact.email) contact = replaceEmojiParagraph(contact, '✉️', input.contact.email);
    if (input.contact.hours !== current.contact.hours) contact = replaceEmojiParagraph(contact, '🕒', input.contact.hours);
    updated = updated.slice(0, contactRegion.start) + contact + updated.slice(contactRegion.end);
  }

  if (Object.keys(input.hero).some(key => input.hero[key] !== current.hero[key])) {
    const heroRegion = getRegion(updated, /<div\s+class="hero-content">[\s\S]*?<div\s+class="hero-rating">[\s\S]*?<\/div>/i, 'hero');
    let hero = heroRegion.text;
    if (input.hero.title !== current.hero.title) hero = replaceTagText(hero, 'h1', input.hero.title);
    if (input.hero.subtitle !== current.hero.subtitle) hero = replaceTagText(hero, 'h2', input.hero.subtitle);
    if (input.hero.story !== current.hero.story) hero = replaceTagByIndex(hero, 'p', 0, input.hero.story);
    if (input.hero.tagline !== current.hero.tagline) hero = replaceTagByIndex(hero, 'p', 1, input.hero.tagline);
    updated = updated.slice(0, heroRegion.start) + hero + updated.slice(heroRegion.end);
  }

  if (Object.keys(input.about).some(key => input.about[key] !== current.about[key])) {
    const aboutRegion = getRegion(updated, /<section\b(?=[^>]*\bid="about")[\s\S]*?<\/section>/i, 'about');
    let about = aboutRegion.text;
    if (input.about.title !== current.about.title) about = replaceTagText(about, 'h2', input.about.title);
    if (input.about.paragraph1 !== current.about.paragraph1) about = replaceTagByIndex(about, 'p', 0, input.about.paragraph1);
    if (input.about.paragraph2 !== current.about.paragraph2) about = replaceTagByIndex(about, 'p', 1, input.about.paragraph2);
    updated = updated.slice(0, aboutRegion.start) + about + updated.slice(aboutRegion.end);
  }

  if (input.promos.some((value, index) => value !== current.promos[index])) {
    const promoRegion = getRegion(updated, /<section\s+class="promo-slider">[\s\S]*?<\/section>/i, 'promo slider');
    let promoIndex = 0;
    const promo = promoRegion.text.replace(/(<div\s+class="slide(?:\s+active)?"[^>]*>)[\s\S]*?(<\/div>)/gi, (all, open, close) => {
      const index = promoIndex++;
      return input.promos[index] !== current.promos[index] ? `${open}${htmlEscape(input.promos[index])}${close}` : all;
    });
    if (promoIndex !== 4) throw new Error('Jumlah banner promo tidak sesuai; tidak ada perubahan yang disimpan.');
    updated = updated.slice(0, promoRegion.start) + promo + updated.slice(promoRegion.end);
  }

  input.products.forEach(product => {
    const definition = PRODUCTS.find(item => item.id === product.id);
    const previous = current.products.find(item => item.id === product.id);
    updated = updateProduct(updated, definition, product, previous);
  });

  if (input.testimonials.some((item, index) => item.text !== current.testimonials[index].text || item.name !== current.testimonials[index].name)) {
    const testimonialRegion = getRegion(updated, /<section\b(?=[^>]*\bid="testimonials")[\s\S]*?<\/section>/i, 'testimonials');
    let testimonialIndex = 0;
    const testimonial = testimonialRegion.text.replace(/<div\s+class="testimonial-card"[^>]*>[\s\S]*?<\/div>/gi, card => {
      const index = testimonialIndex++;
      const values = input.testimonials[index];
      const previous = current.testimonials[index];
      if (!values || !previous) return card;
      let result = card;
      if (values.text !== previous.text) result = replaceTagText(result, 'p', values.text);
      if (values.name !== previous.name) result = replaceTagText(result, 'strong', `- ${values.name}`);
      return result;
    });
    if (testimonialIndex !== 3) throw new Error('Jumlah testimoni tidak sesuai; tidak ada perubahan yang disimpan.');
    updated = updated.slice(0, testimonialRegion.start) + testimonial + updated.slice(testimonialRegion.end);
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
    const value = text(input, name, 30);
    if (!/^[+0-9 ()-]{7,30}$/.test(value)) throw new Error(`${name} hanya boleh berisi angka, spasi, +, tanda kurung, atau tanda hubung.`);
    return value;
  };
  const price = (input, name) => {
    const value = Number(input);
    if (!Number.isInteger(value) || value < 0 || value > 1000000000) throw new Error(`${name} harus berupa angka Rupiah yang valid.`);
    return value;
  };
  if (!Array.isArray(value.promos) || value.promos.length !== 4) throw new Error('Empat promo diperlukan.');
  if (!Array.isArray(value.products) || value.products.length !== PRODUCTS.length) throw new Error('Enam produk diperlukan.');
  if (!Array.isArray(value.testimonials) || value.testimonials.length !== 3) throw new Error('Tiga testimoni diperlukan.');
  const products = value.products.map((p, index) => {
    const expected = PRODUCTS[index];
    if (!p || p.id !== expected.id) throw new Error('Urutan produk tidak valid. Muat ulang halaman admin.');
    return {
      id: expected.id,
      name: text(p.name, `Nama produk ${index + 1}`, 100),
      badge: text(p.badge, `Badge produk ${index + 1}`, 80),
      oldPrice: price(p.oldPrice, `Harga lama produk ${index + 1}`),
      price: price(p.price, `Harga produk ${index + 1}`),
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
