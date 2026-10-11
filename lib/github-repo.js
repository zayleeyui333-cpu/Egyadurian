'use strict';

const OWNER = 'zayleeyui333-cpu';
const REPO = 'Egyadurian';
const BRANCH = 'main';
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN belum diatur di Vercel.');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'EGYA-DURIAN-ADMIN',
  };
}

async function getFile(path) {
  const url = `${API_BASE}/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(BRANCH)}`;
  const response = await fetch(url, { headers: githubHeaders(), cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `GitHub gagal membaca ${path}.`);
    error.status = response.status;
    throw error;
  }
  if (!body.content || !body.sha) throw new Error(`Isi file ${path} tidak ditemukan di GitHub.`);
  return {
    content: Buffer.from(body.content.replace(/\n/g, ''), 'base64').toString('utf8'),
    sha: body.sha,
  };
}

async function putEncodedFile(path, base64Content, message, sha) {
  const url = `${API_BASE}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const payload = { message, content: base64Content, branch: BRANCH };
  if (sha) payload.sha = sha;
  const response = await fetch(url, { method: 'PUT', headers: githubHeaders(), body: JSON.stringify(payload) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `GitHub gagal menyimpan ${path}.`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function putFile(path, content, message, sha) {
  return putEncodedFile(path, Buffer.from(content, 'utf8').toString('base64'), message, sha);
}

module.exports = { OWNER, REPO, BRANCH, getFile, putFile, putEncodedFile };
