/**
 * Supabase Storage wrapper for user-uploaded files and cropped figure
 * images — replaces local-disk storage (data/uploads/), which doesn't
 * survive Vercel's ephemeral serverless filesystem.
 *
 * Bucket layout (mirrors the old local UPLOAD_ROOT structure):
 *   <projectId>/<fileId><ext>                                  original uploads
 *   <projectId>/pages/<fileId>/page-<n>-fig-<i>.png             cropped figures
 *
 * Uses the service-role key (SUPABASE_SECRET_KEY) so the server can write/
 * delete/sign arbitrary paths in the private "uploads" bucket regardless of
 * row-level policies — this module is only ever called from trusted backend
 * code, never exposed directly to clients.
 */
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'uploads';

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required for file storage');
    }
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  }
  return _client;
}

// Signed upload URL the browser can PUT/POST directly to, bypassing the
// server entirely — required because Vercel serverless functions cap
// request bodies at 4.5MB, well under this app's 100MB upload limit.
async function createSignedUploadUrl(key) {
  const { data, error } = await client().storage.from(BUCKET).createSignedUploadUrl(key);
  if (error) throw error;
  return data; // { path, token, signedUrl }
}

async function objectExists(key) {
  const dir = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
  const name = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
  const { data, error } = await client().storage.from(BUCKET).list(dir, { search: name });
  if (error) throw error;
  return (data || []).some(f => f.name === name);
}

async function uploadBuffer(key, buffer, contentType) {
  const { error } = await client().storage.from(BUCKET).upload(key, buffer, {
    contentType,
    upsert: true,
  });
  if (error) throw error;
  return key;
}

async function downloadBuffer(key) {
  const { data, error } = await client().storage.from(BUCKET).download(key);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

// Short-lived — signed URLs are consumed immediately via a redirect, never
// persisted or shown to the user, so a short TTL only reduces exposure.
async function getSignedDownloadUrl(key, expiresIn = 60) {
  const { data, error } = await client().storage.from(BUCKET).createSignedUrl(key, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

async function removeObject(key) {
  const { error } = await client().storage.from(BUCKET).remove([key]);
  if (error) throw error;
}

// Supabase Storage has no native "delete folder" — list then bulk-remove.
async function removePrefix(prefix) {
  const { data, error } = await client().storage.from(BUCKET).list(prefix);
  if (error) throw error;
  if (!data || !data.length) return;
  const keys = data.map(f => `${prefix}/${f.name}`);
  const { error: rmErr } = await client().storage.from(BUCKET).remove(keys);
  if (rmErr) throw rmErr;
}

module.exports = {
  createSignedUploadUrl,
  objectExists,
  uploadBuffer,
  downloadBuffer,
  getSignedDownloadUrl,
  removeObject,
  removePrefix,
};
