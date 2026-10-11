'use strict';

const { sendJson, clearSessionCookie, isSameOrigin } = require('../../lib/admin-auth');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, message: 'Permintaan ditolak.' });
  clearSessionCookie(res);
  return sendJson(res, 200, { ok: true });
};
