'use strict';

const { issueSignedToken } = require('@vercel/blob');
const { handleUploadPresigned } = require('@vercel/blob/client');
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

  // Vercel Blob calls this endpoint server-to-server after upload. handleUploadPresigned
  // verifies that callback with BLOB_WEBHOOK_PUBLIC_KEY; browser URL requests still need owner auth.
  if (!isBlobCompletionCallback) {
    if (!verifySession(req)) return sendJson(res, 401, { ok: false, message: 'Sesi berakhir. Silakan login kembali.' });
    if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, message: 'Permintaan ditolak.' });
  }

  try {
    const response = await handleUploadPresigned({
      body,
      request: req,
      getSignedToken: async (pathname) => {
        if (!verifySession(req)) throw new Error('Sesi berakhir. Silakan login kembali.');
        if (!isSameOrigin(req)) throw new Error('Permintaan upload harus berasal dari halaman admin EGYA DURIAN.');
        if (!isValidVideoPath(pathname)) throw new Error('Path video tidak valid. Gunakan video MP4, WebM, atau OGG.');

        // The Blob store is connected to this Vercel project through OIDC. handleUpload
        // requires a static read-write token, so use the presigned flow for OIDC instead.
        const token = await issueSignedToken({
          pathname,
          operations: ['put'],
          allowedContentTypes: ALLOWED_VIDEO_TYPES,
          maximumSizeInBytes: MAX_VIDEO_BYTES,
          validUntil: Date.now() + 15 * 60 * 1000,
        });

        return {
          token,
          urlOptions: {
            access: 'public',
            allowedContentTypes: ALLOWED_VIDEO_TYPES,
            maximumSizeInBytes: MAX_VIDEO_BYTES,
            addRandomSuffix: true,
            allowOverwrite: false,
            validUntil: Date.now() + 10 * 60 * 1000,
            tokenPayload: JSON.stringify({ feature: 'egyadurian-gallery-video' }),
          },
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // The browser stages blob.url in the admin draft. The owner activates it only
        // after pressing Save Changes, so the existing public video remains untouched until then.
        if (!blob || typeof blob.url !== 'string' || !blob.url.startsWith('https://') || !String(tokenPayload || '').includes('egyadurian-gallery-video')) {
          throw new Error('Upload video galeri tidak dapat diverifikasi.');
        }
      },
    });

    return sendJson(res, 200, response);
  } catch (error) {
    const message = error && error.message ? error.message : 'Unggah video gagal.';
    const status = /sesi berakhir/i.test(message) ? 401 : (/permintaan upload harus|permintaan ditolak/i.test(message) ? 403 : 400);
    return sendJson(res, status, { ok: false, error: message, message });
  }
};
