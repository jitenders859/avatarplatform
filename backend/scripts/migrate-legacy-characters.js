/**
 * One-off migration: move the 4 hardcoded characters (backend/routes/
 * projects.js's old CHARACTERS array) into the new DB-driven character
 * library, uploading their .riv files from public/assets/characters/ into
 * the public 'character-assets' Supabase Storage bucket.
 *
 * Run once: node backend/scripts/migrate-legacy-characters.js
 *
 * Idempotent — skips any slug that already exists in `characters`, so it's
 * safe to re-run (e.g. after adding a 5th legacy character by hand).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const storage = require('../services/storage');
const { isValidRiveBinary } = require('../services/riveValidation');

// Mirrors the CHARACTERS array being retired from backend/routes/projects.js.
const LEGACY_CHARACTERS = [
  { slug: 'character_1', name: 'Aria', description: 'Friendly, expressive default character' },
  { slug: 'character_2', name: 'Kai', description: 'Calm, professional support agent vibe' },
  { slug: 'character_3', name: 'Nova', description: 'Energetic, upbeat brand ambassador' },
  { slug: 'character_4', name: 'Echo', description: 'Soft-spoken, thoughtful guide' },
];

const ASSETS_DIR = path.join(__dirname, '..', '..', 'public', 'assets', 'characters');

async function main() {
  for (const legacy of LEGACY_CHARACTERS) {
    const existing = await db.findOne('characters', { slug: legacy.slug });
    if (existing) {
      console.log(`skip ${legacy.slug} — already migrated`);
      continue;
    }

    const filePath = path.join(ASSETS_DIR, `${legacy.slug}.riv`);
    const buffer = fs.readFileSync(filePath);
    if (!isValidRiveBinary(buffer)) {
      console.error(`ABORT ${legacy.slug}: ${filePath} is not a valid Rive binary`);
      process.exitCode = 1;
      continue;
    }

    const id = crypto.randomUUID();
    const storageKey = `${id}/v1.riv`;
    await storage.characterAssets.uploadBuffer(storageKey, buffer, 'application/octet-stream');

    const now = Date.now();
    await db.insert('characters', {
      id,
      slug: legacy.slug,
      name: legacy.name,
      description: legacy.description,
      storageKey,
      version: 1,
      fileSize: buffer.length,
      status: 'active',
      visibility: 'global',
      uploadedBy: null,
      createdAt: now,
    });
    await db.insert('character_versions', {
      id: crypto.randomUUID(),
      characterId: id,
      version: 1,
      storageKey,
      fileSize: buffer.length,
      uploadedBy: null,
      createdAt: now,
    });

    console.log(`migrated ${legacy.slug} -> ${id} (${buffer.length} bytes)`);
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((e) => { console.error(e); process.exit(1); });
