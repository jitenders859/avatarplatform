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
 *
 * A second, PUBLIC bucket ("character-assets") is exposed via the
 * `characterAssets` namespace below for admin-uploaded Rive character
 * files — those must be fetchable with no auth (the embed widget is loaded
 * by anonymous visitors on third-party sites), unlike everything in
 * "uploads", which is tenant-owned RAG source material and stays private.
 */
const { createClient } = require('@supabase/supabase-js');

const UPLOADS_BUCKET = 'uploads';
const CHARACTER_ASSETS_BUCKET = 'character-assets';

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

function makeBucketOps(bucketName) {
  return {
    // Signed upload URL the browser can PUT/POST directly to, bypassing the
    // server entirely — required because Vercel serverless functions cap
    // request bodies at 4.5MB, well under this app's 100MB upload limit.
    async createSignedUploadUrl(key) {
      const { data, error } = await client().storage.from(bucketName).createSignedUploadUrl(key);
      if (error) throw error;
      return data; // { path, token, signedUrl }
    },

    async objectExists(key) {
      const dir = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
      const name = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
      const { data, error } = await client().storage.from(bucketName).list(dir, { search: name });
      if (error) throw error;
      return (data || []).some(f => f.name === name);
    },

    async uploadBuffer(key, buffer, contentType) {
      const { error } = await client().storage.from(bucketName).upload(key, buffer, {
        contentType,
        upsert: true,
      });
      if (error) throw error;
      return key;
    },

    async downloadBuffer(key) {
      const { data, error } = await client().storage.from(bucketName).download(key);
      if (error) throw error;
      return Buffer.from(await data.arrayBuffer());
    },

    // Short-lived — signed URLs are consumed immediately via a redirect, never
    // persisted or shown to the user, so a short TTL only reduces exposure.
    async getSignedDownloadUrl(key, expiresIn = 60) {
      const { data, error } = await client().storage.from(bucketName).createSignedUrl(key, expiresIn);
      if (error) throw error;
      return data.signedUrl;
    },

    async removeObject(key) {
      const { error } = await client().storage.from(bucketName).remove([key]);
      if (error) throw error;
    },

    // Supabase Storage has no native "delete folder" — list then bulk-remove.
    async removePrefix(prefix) {
      const { data, error } = await client().storage.from(bucketName).list(prefix);
      if (error) throw error;
      if (!data || !data.length) return;
      const keys = data.map(f => `${prefix}/${f.name}`);
      const { error: rmErr } = await client().storage.from(bucketName).remove(keys);
      if (rmErr) throw rmErr;
    },
  };
}

const uploadsBucket = makeBucketOps(UPLOADS_BUCKET);
const characterAssetsBucket = makeBucketOps(CHARACTER_ASSETS_BUCKET);

// No signing needed — the bucket itself is public, so this is a stable,
// cacheable URL suitable for the embed widget's <script src>-equivalent
// riveSrc, unlike getSignedDownloadUrl's short-lived redirect links.
function getCharacterPublicUrl(key) {
  const { data } = client().storage.from(CHARACTER_ASSETS_BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

module.exports = {
  // Private "uploads" bucket — unchanged behavior/signatures for existing callers.
  createSignedUploadUrl: uploadsBucket.createSignedUploadUrl,
  objectExists: uploadsBucket.objectExists,
  uploadBuffer: uploadsBucket.uploadBuffer,
  downloadBuffer: uploadsBucket.downloadBuffer,
  getSignedDownloadUrl: uploadsBucket.getSignedDownloadUrl,
  removeObject: uploadsBucket.removeObject,
  removePrefix: uploadsBucket.removePrefix,

  // Public "character-assets" bucket.
  characterAssets: {
    ...characterAssetsBucket,
    getPublicUrl: getCharacterPublicUrl,
  },
};
