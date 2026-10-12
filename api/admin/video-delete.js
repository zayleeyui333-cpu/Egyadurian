'use strict';

const { del } = require('@vercel/blob');
const { sendJson, requireAdmin, isSameOrigin } = require('../../lib/admin-auth');
const { OWNER, REPO, BRANCH, getFile, putFile } = require('../../lib/github-repo');
const contentAdmin = require('./content');

const VIDEO_BLOB_PREFIX = '/egyadurian-gallery-videos/';
const VIDEO_EXT_RE = /\.(?:mp4|webm|ogv|ogg|m4v)$/i;
const GITHUB_API = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;

function classifyVideoUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Alamat video tidak valid. Muat ulang galeri lalu coba lagi.');
  if (/^assets\/[A-Za-z0-9._/-]+\.(?:mp4|webm|ogv|ogg|m4v)$/i.test(value) && !value.includes('..') && !value.includes('//')) {
    return { type: 'github-asset', path: value };
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('Alamat video tidak valid.'); }
  const allowedHost = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i.test(url.hostname);
  const allowedPath = url.pathname.startsWith(VIDEO_BLOB_PREFIX)
    && VIDEO_EXT_RE.test(url.pathname)
    && !url.pathname.includes('..')
    && !url.pathname.includes('//');
  if (url.protocol !== 'https:' || !allowedHost || !allowedPath || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Video harus berasal dari folder aset video EGYA DURIAN atau Vercel Blob store EGYA DURIAN.');
  }
  return { type: 'blob', url: url.toString() };
}

function githubHeaders() {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN belum diatur di Vercel.');
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'EGYA-DURIAN-ADMIN',
  };
}

async function deleteGithubAsset(path) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const endpoint = `${GITHUB_API}/${encodedPath}`;
  const headers = githubHeaders();
  const response = await fetch(`${endpoint}?ref=${encodeURIComponent(BRANCH)}`, { headers, cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (response.status === 404) return { alreadyMissing: true };
  if (!response.ok) throw new Error(body.message || `GitHub gagal memeriksa file ${path}.`);
  if (!body.sha) throw new Error(`GitHub tidak memberikan SHA untuk file ${path}.`);

  const deleted = await fetch(endpoint, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({
      message: 'Permanently delete gallery video from EGYA DURIAN Admin',
      sha: body.sha,
      branch: BRANCH,
    }),
  });
  const deleteBody = await deleted.json().catch(() => ({}));
  if (deleted.status === 404) return { alreadyMissing: true };
  if (!deleted.ok) throw new Error(deleteBody.message || `GitHub gagal menghapus file ${path}.`);
  return { alreadyMissing: false };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });
  if (!requireAdmin(req, res)) return;
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, message: 'Permintaan ditolak.' });

  let storageDeleteCompleted = false;
  let hadPublishedReference = false;
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const target = classifyVideoUrl(body.videoUrl);
    const pendingUpload = body.pendingUpload === true && target.type === 'blob';
    const file = await getFile('index.html');
    const current = contentAdmin.getAdminData(file.content);
    const currentVideos = Array.isArray(current.galleryVideos) ? current.galleryVideos : [];
    const existingVideo = currentVideos.find(video => video.url === body.videoUrl);
    const isPublishedReference = Boolean(existingVideo);

    // A newly uploaded draft can be removed before publishing it. A saved video
    // must match one specific entry in the multi-video list.
    if (!isPublishedReference && !pendingUpload) {
      return sendJson(res, 409, { ok: false, message: 'Video ini tidak lagi tercatat di daftar galeri. Muat ulang halaman admin sebelum mencoba lagi.' });
    }

    let updated = file.content;
    if (isPublishedReference) {
      const galleryMatch = file.content.match(/<section\b(?=[^>]*\bid=["']gallery["'])[^]*?<\/section>/i);
      if (!galleryMatch) throw new Error('Bagian Galeri EGYA DURIAN tidak ditemukan di index.html.');
      const outsideGallery = file.content.replace(galleryMatch[0], '');
      if (outsideGallery.includes(body.videoUrl)) {
        throw new Error('Video ini juga dirujuk di bagian lain index.html. Demi mencegah bagian lain rusak, file tidak dihapus permanen.');
      }
      const nextData = {
        ...current,
        galleryVideos: currentVideos.filter(video => video.url !== body.videoUrl),
      };
      updated = contentAdmin.updateContent(file.content, nextData);
      hadPublishedReference = true;
    }

    // Delete the underlying file first. If the subsequent index.html commit
    // races with another edit, the admin can repeat the delete action: del()
    // and the GitHub file deletion both tolerate an already-missing object.
    if (target.type === 'blob') {
      // The Vercel Blob store is connected to this project through OIDC. With the
      // current @vercel/blob SDK, del() uses the project's OIDC credentials.
      await del(target.url);
      storageDeleteCompleted = true;
    } else {
      await deleteGithubAsset(target.path);
      storageDeleteCompleted = true;
    }

    if (hadPublishedReference && updated !== file.content) {
      try {
        await putFile('index.html', updated, 'Permanently delete gallery video from EGYA DURIAN Admin', file.sha);
      } catch (error) {
        const detail = error && error.message ? error.message : 'GitHub gagal memperbarui index.html.';
        throw new Error(`File video sudah dihapus dari penyimpanan, tetapi referensi galeri belum selesai dibersihkan. Klik Hapus Video Permanen sekali lagi untuk menyelesaikan pembersihan. Detail: ${detail}`);
      }
    }

    const message = pendingUpload && !hadPublishedReference
      ? 'Video draf berhasil dihapus permanen dari Vercel Blob. Video yang sedang diterbitkan di website tidak diubah.'
      : (target.type === 'blob'
        ? 'Video yang dipilih dihapus permanen dari Vercel Blob dan hanya referensinya yang dilepas dari galeri. Video lain tidak berubah. Penghapusan CDN dapat membutuhkan waktu hingga sekitar satu menit.'
        : 'Video yang dipilih dihapus dari versi aktif repository GitHub dan hanya referensinya yang dilepas dari galeri. Video lain tidak berubah. GitHub tetap menyimpan riwayat commit lama.');
    return sendJson(res, 200, { ok: true, message });
  } catch (error) {
    const message = storageDeleteCompleted && hadPublishedReference
      ? (error.message || 'Penyimpanan video sudah dihapus, tetapi index.html belum berhasil diperbarui. Ulangi Hapus Video Permanen untuk menyelesaikan pembersihan.')
      : (error.message || 'Gagal menghapus video.');
    return sendJson(res, 400, { ok: false, message });
  }
};
