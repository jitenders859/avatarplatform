/**
 * Admin character library — upload, versioning, library listing, lifecycle
 * (draft/active/archived), and per-tenant access grants for admin-managed
 * Rive character files.
 *
 * Upload uses the same two-step signed-URL pattern as routes/files.js
 * (init → browser uploads directly to Supabase Storage → complete),
 * required because Vercel serverless functions cap request bodies at
 * 4.5MB. Files land in the PUBLIC 'character-assets' bucket (see
 * services/storage.js) since the embed widget is loaded by anonymous
 * visitors on third-party sites with no way to authenticate.
 *
 * Contract validation (artboard "Character", state machine "InLesson",
 * inputs 100-122) is NOT done here — there's no Rive parser in Node. It
 * happens client-side in the admin panel via the real rive.js runtime
 * (a genuine inspector, doubling as "test before releasing"). This route
 * only confirms the upload is actually a Rive binary at all (see
 * services/riveValidation.js) and rejects/rolls back if not.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { adminAuthRequired } = require('../middleware/auth');
const { logAdminAction } = require('../services/auditLog');
const { validate, schemas } = require('../middleware/validate');
const storage = require('../services/storage');
const { isValidRiveBinary } = require('../services/riveValidation');

const router = express.Router();
router.use(adminAuthRequired);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Character not found' });
  next();
});
router.param('triggerId', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Trigger not found' });
  next();
});

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '') || 'character';
}

async function uniqueSlug(name) {
  const base = slugify(name);
  let slug = base;
  let n = 1;
  // Collisions are rare (admin-facing, low volume) — a loop is simpler and
  // clearer here than a single query with a generated suffix.
  while (await db.findOne('characters', { slug })) {
    slug = `${base}_${++n}`;
  }
  return slug;
}

async function findCharacterOr404(req, res) {
  const character = await db.findOne('characters', { id: req.params.id });
  if (!character) { res.status(404).json({ error: 'Character not found' }); return null; }
  return character;
}

// ── Library ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const characters = await db.query(
    `SELECT c.*,
            COUNT(p.id)::int AS usage_count
       FROM characters c
       LEFT JOIN projects p ON p.character_id = c.slug
      GROUP BY c.id
      ORDER BY c.created_at DESC`
  );
  res.json({
    characters: characters.map(c => ({
      ...c,
      publicUrl: storage.characterAssets.getPublicUrl(c.storageKey),
      thumbnailUrl: c.thumbnailStorageKey ? storage.characterAssets.getPublicUrl(c.thumbnailStorageKey) : null,
    })),
  });
});

router.get('/:id', async (req, res) => {
  const character = await findCharacterOr404(req, res);
  if (!character) return;

  const [versions, access, usage, triggers] = await Promise.all([
    db.findAll('character_versions', { characterId: character.id }, { orderBy: 'version', order: 'desc' }),
    db.query(
      `SELECT ca.user_id, ca.created_at, u.email
         FROM character_access ca JOIN users u ON u.id = ca.user_id
        WHERE ca.character_id = $1 ORDER BY ca.created_at DESC`,
      [character.id]
    ),
    db.queryOne('SELECT COUNT(*)::int AS count FROM projects WHERE character_id = $1', [character.slug]),
    db.findAll('character_triggers', { characterId: character.id }, { orderBy: 'createdAt', order: 'asc' }),
  ]);

  res.json({
    character: {
      ...character,
      publicUrl: storage.characterAssets.getPublicUrl(character.storageKey),
      thumbnailUrl: character.thumbnailStorageKey ? storage.characterAssets.getPublicUrl(character.thumbnailStorageKey) : null,
      usageCount: usage.count,
    },
    versions: versions.map(v => ({
      id: v.id, version: v.version, fileSize: v.fileSize, inspectorMeta: v.inspectorMeta, createdAt: v.createdAt,
      publicUrl: storage.characterAssets.getPublicUrl(v.storageKey),
    })),
    access,
    triggers,
  });
});

// ── Upload (new character) ──────────────────────────────────
router.post('/init', validate(schemas.characterInit), async (req, res) => {
  const { name, description, visibility } = req.body;
  const id = crypto.randomUUID();
  const slug = await uniqueSlug(name);
  const storageKey = `${id}/v1.riv`;
  const now = Date.now();

  await db.insert('characters', {
    id, slug, name, description: description || null,
    storageKey, version: 1, fileSize: 0,
    status: 'draft', visibility: visibility || 'restricted',
    uploadedBy: req.admin.id, createdAt: now,
  });
  await db.insert('character_versions', {
    id: crypto.randomUUID(), characterId: id, version: 1, storageKey, fileSize: 0,
    uploadedBy: req.admin.id, createdAt: now,
  });

  const { signedUrl, token } = await storage.characterAssets.createSignedUploadUrl(storageKey);
  res.json({ characterId: id, slug, storageKey, uploadUrl: signedUrl, uploadToken: token });
});

router.post('/:id/complete', validate(schemas.characterComplete), async (req, res) => {
  const character = await findCharacterOr404(req, res);
  if (!character) return;
  const versionRow = await db.findOne('character_versions', { characterId: character.id, version: 1 });

  const result = await finalizeUpload({
    storageKey: character.storageKey,
    inspectorMeta: req.body.inspectorMeta,
    onInvalid: async () => {
      await db.remove('character_versions', { characterId: character.id });
      await db.remove('characters', { id: character.id });
    },
    onValid: async (fileSize, inspectorMeta) => {
      await db.update('characters', character.id, { fileSize, inspectorMeta: inspectorMeta || null });
      if (versionRow) await db.update('character_versions', versionRow.id, { fileSize, inspectorMeta: inspectorMeta || null });
    },
  });
  if (!result.ok) return res.status(400).json({ error: result.error });

  await logAdminAction({
    adminId: req.admin.id,
    action: 'character_upload',
    meta: { characterId: character.id, slug: character.slug, name: character.name },
  });
  res.json({ character: await db.findOne('characters', { id: character.id }) });
});

// ── Upload (new version of an existing character) ───────────
router.post('/:id/versions/init', async (req, res) => {
  const character = await findCharacterOr404(req, res);
  if (!character) return;

  const nextVersion = character.version + 1;
  const storageKey = `${character.id}/v${nextVersion}.riv`;
  await db.insert('character_versions', {
    id: crypto.randomUUID(), characterId: character.id, version: nextVersion, storageKey, fileSize: 0,
    uploadedBy: req.admin.id, createdAt: Date.now(),
  });

  const { signedUrl, token } = await storage.characterAssets.createSignedUploadUrl(storageKey);
  res.json({ version: nextVersion, storageKey, uploadUrl: signedUrl, uploadToken: token });
});

router.post('/:id/versions/:version/complete', validate(schemas.characterComplete), async (req, res) => {
  const character = await findCharacterOr404(req, res);
  if (!character) return;
  const version = parseInt(req.params.version, 10);
  const versionRow = await db.findOne('character_versions', { characterId: character.id, version });
  if (!versionRow) return res.status(404).json({ error: 'Version not found' });

  const result = await finalizeUpload({
    storageKey: versionRow.storageKey,
    inspectorMeta: req.body.inspectorMeta,
    onInvalid: async () => {
      await db.remove('character_versions', { id: versionRow.id });
    },
    onValid: async (fileSize, inspectorMeta) => {
      await db.update('character_versions', versionRow.id, { fileSize, inspectorMeta: inspectorMeta || null });
      // This version becomes current only once it passes validation — a
      // failed re-upload must never leave the character pointing at a
      // storage key that doesn't exist or isn't a valid Rive file.
      await db.update('characters', character.id, {
        storageKey: versionRow.storageKey, version, fileSize, inspectorMeta: inspectorMeta || null,
      });
    },
  });
  if (!result.ok) return res.status(400).json({ error: result.error });

  await logAdminAction({
    adminId: req.admin.id,
    action: 'character_new_version',
    meta: { characterId: character.id, slug: character.slug, version },
  });
  res.json({ character: await db.findOne('characters', { id: character.id }) });
});

// Shared by both /complete endpoints: verify the object landed, sanity-check
// it's actually a Rive binary, and either persist or roll back.
async function finalizeUpload({ storageKey, inspectorMeta, onInvalid, onValid }) {
  const exists = await storage.characterAssets.objectExists(storageKey);
  if (!exists) return { ok: false, error: 'Upload did not complete — object not found in storage' };

  const buffer = await storage.characterAssets.downloadBuffer(storageKey);
  if (!isValidRiveBinary(buffer)) {
    await storage.characterAssets.removeObject(storageKey).catch(() => {});
    await onInvalid();
    return { ok: false, error: 'That file is not a valid Rive (.riv) binary' };
  }

  await onValid(buffer.length, inspectorMeta);
  return { ok: true };
}

// ── Lifecycle / metadata ─────────────────────────────────────
router.patch('/:id', validate(schemas.characterPatch), async (req, res) => {
  const character = await findCharacterOr404(req, res);
  if (!character) return;

  const updated = await db.update('characters', character.id, req.body);
  if (req.body.status && req.body.status !== character.status) {
    await logAdminAction({
      adminId: req.admin.id,
      action: 'character_status_change',
      meta: { characterId: character.id, slug: character.slug, fromStatus: character.status, toStatus: req.body.status },
    });
  }
  if (req.body.visibility && req.body.visibility !== character.visibility) {
    await logAdminAction({
      adminId: req.admin.id,
      action: 'character_visibility_change',
      meta: { characterId: character.id, slug: character.slug, fromVisibility: character.visibility, toVisibility: req.body.visibility },
    });
  }
  res.json({ character: updated });
});

// ── Tenant access grants ─────────────────────────────────────
router.post('/:id/access', validate(schemas.characterAccessGrant), async (req, res) => {
  const character = await findCharacterOr404(req, res);
  if (!character) return;
  const user = await db.findOne('users', { id: req.body.userId });
  if (!user) return res.status(400).json({ error: 'Unknown user' });

  await db.query(
    `INSERT INTO character_access (character_id, user_id, granted_by, created_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [character.id, user.id, req.admin.id, Date.now()]
  );
  await logAdminAction({
    adminId: req.admin.id,
    action: 'character_access_grant',
    targetUserId: user.id,
    targetEmail: user.email,
    meta: { characterId: character.id, slug: character.slug },
  });
  res.json({ ok: true });
});

router.delete('/:id/access/:userId', async (req, res) => {
  const character = await findCharacterOr404(req, res);
  if (!character) return;
  await db.query('DELETE FROM character_access WHERE character_id = $1 AND user_id = $2', [character.id, req.params.userId]);
  const user = await db.findOne('users', { id: req.params.userId });
  await logAdminAction({
    adminId: req.admin.id,
    action: 'character_access_revoke',
    targetUserId: req.params.userId,
    targetEmail: user?.email || null,
    meta: { characterId: character.id, slug: character.slug },
  });
  res.json({ ok: true });
});

// ── Behavior triggers ────────────────────────────────────────
// Named gestures (thinking/listening/laughing/joking/anything) an admin
// maps to a specific Rive state machine input on this character. The SDK
// (public/lipsync-sdk.js, CharacterBehaviorController) fires one either
// automatically — when its keywords appear in the AI's spoken transcript,
// same mechanism as the built-in happy/sad/surprised gestures — or on
// demand via LipsyncAvatar#fireCharacterTrigger(name).
router.get('/:id/triggers', async (req, res) => {
  const character = await findCharacterOr404(req, res);
  if (!character) return;
  const triggers = await db.findAll('character_triggers', { characterId: character.id }, { orderBy: 'createdAt', order: 'asc' });
  res.json({ triggers });
});

router.post('/:id/triggers', validate(schemas.characterTriggerCreate), async (req, res) => {
  const character = await findCharacterOr404(req, res);
  if (!character) return;

  const existing = await db.findOne('character_triggers', { characterId: character.id, name: req.body.name });
  if (existing) return res.status(409).json({ error: 'A trigger with this name already exists on this character' });

  const trigger = await db.insert('character_triggers', {
    id: crypto.randomUUID(),
    characterId: character.id,
    name: req.body.name,
    riveInput: req.body.riveInput,
    inputType: req.body.inputType || 'trigger',
    activeValue: req.body.activeValue ?? null,
    holdMs: req.body.holdMs ?? 1200,
    keywords: req.body.keywords || null,
    createdBy: req.admin.id,
    createdAt: Date.now(),
  });

  await logAdminAction({
    adminId: req.admin.id,
    action: 'character_trigger_create',
    meta: { characterId: character.id, slug: character.slug, triggerId: trigger.id, name: trigger.name },
  });
  res.json({ trigger });
});

router.patch('/:id/triggers/:triggerId', validate(schemas.characterTriggerPatch), async (req, res) => {
  const character = await findCharacterOr404(req, res);
  if (!character) return;
  const trigger = await db.findOne('character_triggers', { id: req.params.triggerId, characterId: character.id });
  if (!trigger) return res.status(404).json({ error: 'Trigger not found' });

  if (req.body.name && req.body.name !== trigger.name) {
    const dupe = await db.findOne('character_triggers', { characterId: character.id, name: req.body.name });
    if (dupe) return res.status(409).json({ error: 'A trigger with this name already exists on this character' });
  }

  const updated = await db.update('character_triggers', trigger.id, req.body);
  await logAdminAction({
    adminId: req.admin.id,
    action: 'character_trigger_update',
    meta: { characterId: character.id, slug: character.slug, triggerId: trigger.id, name: updated.name },
  });
  res.json({ trigger: updated });
});

router.delete('/:id/triggers/:triggerId', async (req, res) => {
  const character = await findCharacterOr404(req, res);
  if (!character) return;
  const trigger = await db.findOne('character_triggers', { id: req.params.triggerId, characterId: character.id });
  if (!trigger) return res.status(404).json({ error: 'Trigger not found' });

  await db.remove('character_triggers', { id: trigger.id });
  await logAdminAction({
    adminId: req.admin.id,
    action: 'character_trigger_delete',
    meta: { characterId: character.id, slug: character.slug, triggerId: trigger.id, name: trigger.name },
  });
  res.json({ ok: true });
});

module.exports = router;
