'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'egya_admin_session';
const SESSION_SECONDS = 8 * 60 * 60;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(body));
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(value); } catch { out[name] = value; }
  }
  return out;
}

function sign(payload) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET belum diatur dengan benar.');
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSession() {
  const payload = Buffer.from(JSON.stringify({ role: 'owner', exp: Date.now() + SESSION_SECONDS * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifySession(req) {
  try {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return false;
    const lastDot = token.lastIndexOf('.');
    if (lastDot <= 0) return false;
    const payload = token.slice(0, lastDot);
    const providedSignature = token.slice(lastDot + 1);
    if (!safeEqual(sign(payload), providedSignature)) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.role === 'owner' && Number.isFinite(data.exp) && data.exp > Date.now();
  } catch {
    return false;
  }
}

function setSessionCookie(res, token) {
  const secure = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    const allowedHosts = new Set([
      req.headers.host,
      req.headers['x-forwarded-host'],
    ].filter(Boolean).flatMap(value => String(value).split(',').map(item => item.trim().toLowerCase())));
    return allowedHosts.has(originUrl.host.toLowerCase());
  } catch {
    return false;
  }
}

function requireAdmin(req, res) {
  if (!verifySession(req)) {
    sendJson(res, 401, { ok: false, message: 'Sesi berakhir. Silakan login kembali.' });
    return false;
  }
  return true;
}

module.exports = {
  COOKIE_NAME,
  SESSION_SECONDS,
  sendJson,
  safeEqual,
  createSession,
  verifySession,
  setSessionCookie,
  clearSessionCookie,
  isSameOrigin,
  requireAdmin,
};
