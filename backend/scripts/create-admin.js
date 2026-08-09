require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');

async function main() {
  const [, , email, password] = process.argv;
  if (!email || !password) {
    console.error('Usage: node backend/scripts/create-admin.js <email> <password>');
    process.exit(1);
  }
  const existing = await db.findOne('admin_users', { email: email.toLowerCase().trim() });
  if (existing) {
    console.error('An admin with that email already exists.');
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert('admin_users', {
    id: crypto.randomUUID(),
    email: email.toLowerCase().trim(),
    passwordHash,
    createdAt: Date.now(),
  });
  console.log(`Admin account created for ${email}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
