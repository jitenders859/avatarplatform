#!/usr/bin/env node
/**
 * Single-sources the platform version.
 *
 * Before this script, four things claimed a version independently and
 * drifted: root package.json (the platform release), each of the four
 * @avatar-platform/* npm packages (all stuck at 0.1.0 since they were
 * scaffolded), and public/lipsync-sdk.js's own banner comment ("v2.3.0",
 * bumped ad hoc as the widget engine changed). A customer reading the
 * docs had no way to know which of those numbers, if any, corresponded
 * to what they'd actually get from `npm install @avatar-platform/react`.
 *
 * root package.json's "version" is now the one source of truth. Run this
 * (via `npm run sync-version`, or automatically as part of `npm run
 * build:sdk`) after bumping it, and it propagates to:
 *   - packages/{js,react,react-native,vue}/package.json's "version"
 *   - public/lipsync-sdk.js's banner comment
 *
 * This intentionally retires lipsync-sdk.js's separate v2.x numbering —
 * that's exactly the drift this script exists to close, not a second
 * version scheme to keep in parallel.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-version: root package.json version "${version}" doesn't look like semver — refusing to propagate it.`);
  process.exit(1);
}

const PACKAGES = ['js', 'react', 'react-native', 'vue'];
for (const pkg of PACKAGES) {
  const pkgPath = path.join(ROOT, 'packages', pkg, 'package.json');
  const json = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (json.version === version) continue;
  json.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(json, null, 2) + '\n');
  console.log(`sync-version: packages/${pkg} -> ${version}`);
}

const sdkPath = path.join(ROOT, 'public', 'lipsync-sdk.js');
const sdkSrc = fs.readFileSync(sdkPath, 'utf8');
const bannerRe = /(\* LipsyncAvatar SDK\s+)v[\d.]+/;
if (bannerRe.test(sdkSrc)) {
  const updated = sdkSrc.replace(bannerRe, `$1v${version}`);
  if (updated !== sdkSrc) {
    fs.writeFileSync(sdkPath, updated);
    console.log(`sync-version: public/lipsync-sdk.js banner -> v${version}`);
  }
} else {
  console.warn('sync-version: lipsync-sdk.js banner pattern not found — leaving it untouched. Update this script\'s bannerRe if the banner format changed.');
}
