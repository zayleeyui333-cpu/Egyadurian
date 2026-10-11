'use strict';

const { sendJson, safeEqual, createSession, setSessionCookie, isSameOrigin } = require('../../lib/admin-auth');

// Best-effort throttling per warm function instance; also enable Vercel Firewall rate limits for stronger protection.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, message: 'Permintaan ditolak.' });

  const expectedPassword = process.env.ADMIN_PASSWORD;
  if (!expectedPassword || !process.env.SESSION_SECRET) {
    return sendJson(res, 500, { ok: false, message: 'Pengaturan login di server belum lengkap.' });
  }

  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || String(req.headers['x-real-ip'] || 'unknown');
  const now = Date.now();
  const record = attempts.get(ip);
  if (record && now - record.startedAt < WINDOW_MS && record.failures >= MAX_FAILURES) {
    return sendJson(res, 429, { ok: false, message: 'Terlalu banyak percobaan login. Coba lagi setelah 15 menit.' });
  }
  if (record && now - record.startedAt >= WINDOW_MS) attempts.delete(ip);

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || !safeEqual(password, expectedPassword)) {
    const current = attempts.get(ip);
    if (!current || now - current.startedAt >= WINDOW_MS) attempts.set(ip, { startedAt: now, failures: 1 });
    else current.failures += 1;
    return sendJson(res, 401, { ok: false, message: 'Kata sandi tidak benar.' });
  }
  attempts.delete(ip);

  try {
    setSessionCookie(res, createSession());
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 500, { ok: false, message: error.message || 'Login gagal.' });
  }
};
