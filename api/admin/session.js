'use strict';

const { sendJson, verifySession } = require('../../lib/admin-auth');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });
  return sendJson(res, 200, { ok: true, authenticated: verifySession(req) });
};
