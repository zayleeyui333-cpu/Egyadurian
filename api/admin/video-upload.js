'use strict';

const { handleUpload } = require('@vercel/blob/client');
const { sendJson, verifySession, isSameOrigin } = require('../../lib/admin-auth');

const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg'];
const ALLOWED_EXTENSIONS = /\.(?:mp4|webm|ogv|ogg)$/i;

function isValidVideoPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('egyadurian-gallery-videos/')) return false;
  const filename = pathname.slice('egyadurian-gallery-videos/'.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(filename) && ALLOWED_EXTENSIONS.test(filename) && !filename.includes('..');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const isBlobCompletionCallback = body.type === 'blob.upload-completed';

  // Vercel Blob invokes the completion callback server-to-server. The SDK validates
  // that callback; all browser token-generation requests still require the owner session.
  if (!isBlobCompletionCallback) {
    if (!verifySession(req)) return sendJson(res, 401, { ok: false, message: 'Sesi berakhir. Silakan login kembali.' });
    if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, message: 'Permintaan ditolak.' });
  }

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error('BLOB_READ_WRITE_TOKEN belum tersedia. Buat Vercel Blob Store berakses Public dan hubungkan ke project EGYA DURIAN.');
    }

    const response = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async pathname => {
        if (!verifySession(req)) throw new Error('Sesi berakhir. Silakan login kembali.');
        if (!isSameOrigin(req)) throw new Error('Permintaan upload harus berasal dari halaman admin EGYA DURIAN.');
        if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN belum tersedia.');
        if (!isValidVideoPath(pathname)) throw new Error('Path video tidak valid. Gunakan video MP4, WebM, atau OGG.');

        return {
          allowedContentTypes: ALLOWED_VIDEO_TYPES,
          maximumSizeInBytes: MAX_VIDEO_BYTES,
          addRandomSuffix: true,
          allowOverwrite: false,
          tokenPayload: JSON.stringify({ feature: 'egyadurian-gallery-video' }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // The browser adds blob.url to the admin draft; the owner then presses
        // “Simpan Perubahan” to commit the URL into index.html. No database update is needed here.
        if (!blob || typeof blob.url !== 'string' || !String(tokenPayload || '').includes('egyadurian-gallery-video')) {
          throw new Error('Upload video galeri tidak dapat diverifikasi.');
        }
      },
    });

    // Keep this response shape exactly as expected by @vercel/blob/client.
    return sendJson(res, 200, response);
  } catch (error) {
    const message = error && error.message ? error.message : 'Unggah video gagal.';
    const status = /sesi berakhir/i.test(message) ? 401 : (/permintaan upload harus|permintaan ditolak/i.test(message) ? 403 : 400);
    return sendJson(res, status, { ok: false, error: message, message });
  }
};
