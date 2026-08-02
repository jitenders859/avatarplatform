# Publishable npm SDK packages (React, React Native, Vue, JS)

**Files:** `package.json` (root, new `workspaces`), `packages/js/**`, `packages/react/**`, `packages/vue/**`, `packages/react-native/**` (all new), `tsconfig.base.json` (new), `public/docs/react-sdk.html`, `public/docs/react-native-sdk.html`, `public/sdk/` (removed), `backend/server.js` (`/sdk/:file` route removed)
**Status:** Approved, ready for implementation plan

## Context

`docs/react-sdk.html` and `docs/react-native-sdk.html` already advertise `npm install @avatar-platform/react` and `@avatar-platform/react-native`, but no such packages exist — `public/sdk/react.js` is a dead browser-ESM demo file (referenced by nothing) that mounts via `/lipsync-sdk.js` with `data-public-id`/`data-theme`/`data-size` attributes nothing reads. The real, working embed mechanism is `public/js/embed-loader.js` (`<script data-bot="PUBLIC_ID">` → creates an iframe at `/e/:publicId`, config pulled server-side from the project's saved settings) plus a genuinely working `POST /embed/:publicId/ask` REST endpoint (`{question, sessionId} → {answer, sources, sessionId}`).

The docs also promise per-mount overrides (`position`, `theme`, `size`, `startOpen`, `compactMobile`, `offsetX`/`offsetY` props, plus an imperative `useAvatarPlatform()` hook with `open`/`close`/`hide`/`show`) that have **no backing anywhere in the platform** — `embed.html` only reads `?bot=`/`?mode=inline` from the URL, and `embed-loader.js` is a self-contained IIFE that attaches nothing to `window` and has no inbound command channel from arbitrary host JS. Decision (confirmed during brainstorming): **ship SDKs that only expose what's real** — `serverUrl` + `botId` to mount, and `askAvatar()` for headless Q&A. No fake props. The two existing doc pages get corrected to match, not left promising a fictional API.

**Key portability insight:** `askAvatar()` is pure `fetch` + JSON — zero DOM dependency — so it works unmodified in React Native. Only *widget mounting* differs: web injects the `embed-loader.js` script tag; React Native renders a `WebView` at `/e/:publicId` directly (no script injection). This drives the package split below.

Out of scope (confirmed during brainstorming): adding real per-mount override support to `embed.html`/`embed-loader.js` (a separate, larger platform change); new docs-site pages for the Vue/JS packages (README-only for this round); actually running `npm publish` (requires the user's npm credentials — this spec produces publish-ready packages, the user runs the publish).

---

## Part 1 — Workspace setup

**Root `package.json`**: add
```json
"workspaces": ["packages/*"],
```
and one new script (existing `build`/`postinstall`/`dev`/`start` scripts are untouched — they drive the main app's `lipsync-sdk.min.js` terser build and must keep working exactly as today):
```json
"build:sdk": "npm run build --workspaces --if-present",
```

**`tsconfig.base.json`** (new, repo root):
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Each package gets its own `tsconfig.json` extending this (`{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "jsx": "react-jsx" }, "include": ["src"] }` — `jsx` line only in `react`/`react-native` packages) and its own `tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

`devDependencies` in every package: `"tsup": "^8.3.5", "typescript": "^5.7.2"`. `npm install` at the repo root installs all workspace packages' dependencies; `npm run build:sdk` builds all four.

---

## Part 2 — `packages/js` (`@avatar-platform/js`) — core, DOM-based

```
packages/js/
  package.json
  tsconfig.json
  tsup.config.ts
  README.md
  src/
    index.ts
    mount.ts
    ask.ts
    types.ts
```

**`src/types.ts`**:
```ts
export interface MountAvatarWidgetOptions {
  /** Base URL of your AvatarPlatform deployment, no trailing slash. */
  serverUrl: string;
  /** Your project's public ID (Dashboard → project → Embed tab). */
  botId: string;
}

export interface AskAvatarOptions {
  serverUrl: string;
  botId: string;
  question: string;
  /** Continue an existing conversation; omit to start a new one. */
  sessionId?: string;
}

export interface AskAvatarSource {
  title: string;
  url: string | null;
  snippet: string;
}

export interface AskAvatarResult {
  answer: string;
  sources: AskAvatarSource[];
  sessionId: string;
}
```

**`src/mount.ts`**:
```ts
import type { MountAvatarWidgetOptions } from './types';

/**
 * Mounts the AvatarPlatform embed widget by injecting the real
 * embed-loader.js script tag (same mechanism as the plain HTML snippet
 * from the dashboard's Embed tab). Idempotent per botId — calling this
 * twice with the same botId (e.g. React StrictMode's double-invoke) is a
 * safe no-op, since embed-loader.js provides no unmount hook itself
 * (it appends the iframe/launcher directly to document.body with no
 * identifiable wrapper to remove later). Meant to be mounted once for
 * the lifetime of the page, typically near your app root.
 */
export function mountAvatarWidget({ serverUrl, botId }: MountAvatarWidgetOptions): void {
  if (typeof document === 'undefined') return; // SSR guard
  if (document.querySelector(`script[data-bot="${botId}"]`)) return;

  const script = document.createElement('script');
  script.src = `${serverUrl.replace(/\/$/, '')}/js/embed-loader.js`;
  script.dataset.bot = botId;
  script.defer = true;
  document.body.appendChild(script);
}
```

**`src/ask.ts`**:
```ts
import type { AskAvatarOptions, AskAvatarResult } from './types';

/** Calls POST /embed/:publicId/ask directly — no widget UI required. */
export async function askAvatar({ serverUrl, botId, question, sessionId }: AskAvatarOptions): Promise<AskAvatarResult> {
  const res = await fetch(`${serverUrl.replace(/\/$/, '')}/embed/${encodeURIComponent(botId)}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, sessionId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  }
  return res.json();
}
```

**`src/index.ts`**:
```ts
export { mountAvatarWidget } from './mount';
export { askAvatar } from './ask';
export type { MountAvatarWidgetOptions, AskAvatarOptions, AskAvatarResult, AskAvatarSource } from './types';
```

**`package.json`**:
```json
{
  "name": "@avatar-platform/js",
  "version": "0.1.0",
  "description": "Core JS SDK for AvatarPlatform — mount the embeddable talking-agent widget or call the headless ask API from any web page.",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "require": "./dist/index.cjs", "types": "./dist/index.d.ts" } },
  "files": ["dist"],
  "scripts": { "build": "tsup", "dev": "tsup --watch" },
  "devDependencies": { "tsup": "^8.3.5", "typescript": "^5.7.2" },
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/jitenders859/avatarplatform.git", "directory": "packages/js" },
  "keywords": ["avatarplatform", "chatbot", "widget", "embed"]
}
```

**`README.md`** covers: install, `mountAvatarWidget({ serverUrl, botId })` (mount-once semantics called out explicitly, same caveat as the code comment), `askAvatar()` full example, TypeScript types.

---

## Part 3 — `packages/react` (`@avatar-platform/react`)

```
packages/react/
  package.json, tsconfig.json, tsup.config.ts, README.md
  src/index.ts, src/AvatarWidget.tsx
```

**`src/AvatarWidget.tsx`**:
```tsx
import { useEffect } from 'react';
import { mountAvatarWidget } from '@avatar-platform/js';

export interface AvatarWidgetProps {
  /** Base URL of your AvatarPlatform deployment, no trailing slash. */
  serverUrl: string;
  /** Your project's public ID. */
  botId: string;
}

/**
 * Renders nothing itself — mounts the AvatarPlatform embed widget as a
 * side effect. Place once near your app root so it persists across route
 * changes; unmounting this component does not remove the widget (see
 * @avatar-platform/js's mountAvatarWidget for why).
 */
export function AvatarWidget({ serverUrl, botId }: AvatarWidgetProps) {
  useEffect(() => {
    mountAvatarWidget({ serverUrl, botId });
  }, [serverUrl, botId]);
  return null;
}
```

**`src/index.ts`**:
```ts
export { AvatarWidget } from './AvatarWidget';
export type { AvatarWidgetProps } from './AvatarWidget';
export { askAvatar } from '@avatar-platform/js';
export type { AskAvatarOptions, AskAvatarResult, AskAvatarSource } from '@avatar-platform/js';
```

**`package.json`** — same shape as `packages/js` (name `@avatar-platform/react`, description "React SDK for AvatarPlatform..."), plus:
```json
"dependencies": { "@avatar-platform/js": "^0.1.0" },
"peerDependencies": { "react": ">=16.8.0" },
"devDependencies": { "tsup": "^8.3.5", "typescript": "^5.7.2", "@types/react": "^18.3.0" }
```
`tsconfig.json` for this package adds `"jsx": "react-jsx"`.

---

## Part 4 — `packages/vue` (`@avatar-platform/vue`)

Written as a plain `defineComponent` (render function, not an `.vue` SFC) — this keeps `tsup` sufficient for every package in the workspace with zero extra bundler plugins, at the cost of no `<template>` syntax (irrelevant here since the component renders nothing).

**`src/AvatarWidget.ts`**:
```ts
import { defineComponent, onMounted } from 'vue';
import { mountAvatarWidget } from '@avatar-platform/js';

export const AvatarWidget = defineComponent({
  name: 'AvatarWidget',
  props: {
    serverUrl: { type: String, required: true },
    botId: { type: String, required: true },
  },
  setup(props) {
    onMounted(() => {
      mountAvatarWidget({ serverUrl: props.serverUrl, botId: props.botId });
    });
    return () => null;
  },
});
```

**`src/index.ts`**:
```ts
export { AvatarWidget } from './AvatarWidget';
export { askAvatar } from '@avatar-platform/js';
export type { AskAvatarOptions, AskAvatarResult, AskAvatarSource } from '@avatar-platform/js';
```

**`package.json`** — same shape, name `@avatar-platform/vue`, plus:
```json
"dependencies": { "@avatar-platform/js": "^0.1.0" },
"peerDependencies": { "vue": "^3.0.0" },
"devDependencies": { "tsup": "^8.3.5", "typescript": "^5.7.2" }
```

---

## Part 5 — `packages/react-native` (`@avatar-platform/react-native`)

```
packages/react-native/
  package.json, tsconfig.json, tsup.config.ts, README.md
  src/index.ts, src/AvatarWidget.tsx
```

**`src/AvatarWidget.tsx`**:
```tsx
import React from 'react';
import { View, type ViewStyle, type StyleProp } from 'react-native';
import { WebView } from 'react-native-webview';

export interface AvatarWidgetProps {
  /** Base URL of your AvatarPlatform deployment, no trailing slash. */
  serverUrl: string;
  /** Your project's public ID. */
  botId: string;
  /** Container style — defaults to filling the nearest positioned ancestor. Position it yourself (e.g. absolute + bottom/right) the same way you'd position any floating RN element. */
  style?: StyleProp<ViewStyle>;
}

/**
 * WebView pointed at the same /e/:publicId page the web widget and raw
 * <iframe> embed snippet use — Rive rendering and Gemini Live audio run
 * inside the WebView's own browser engine. Requires react-native-webview
 * (peer dependency) and mic permissions declared in your app (see README).
 */
export function AvatarWidget({ serverUrl, botId, style }: AvatarWidgetProps) {
  const uri = `${serverUrl.replace(/\/$/, '')}/e/${encodeURIComponent(botId)}`;
  return (
    <View style={style ?? { flex: 1 }}>
      <WebView
        source={{ uri }}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={['*']}
      />
    </View>
  );
}
```

**`src/index.ts`**:
```ts
export { AvatarWidget } from './AvatarWidget';
export type { AvatarWidgetProps } from './AvatarWidget';
export { askAvatar } from '@avatar-platform/js';
export type { AskAvatarOptions, AskAvatarResult, AskAvatarSource } from '@avatar-platform/js';
```

**`package.json`** plus:
```json
"dependencies": { "@avatar-platform/js": "^0.1.0" },
"peerDependencies": { "react": ">=16.8.0", "react-native": ">=0.70.0", "react-native-webview": ">=13.0.0" },
"devDependencies": { "tsup": "^8.3.5", "typescript": "^5.7.2", "@types/react": "^18.3.0" }
```
`tsconfig.json` adds `"jsx": "react-jsx"`.

**README.md** keeps the existing (already-accurate) iOS/Android mic-permission guidance from `docs/react-native-sdk.html` (`NSMicrophoneUsageDescription`, `RECORD_AUDIO`), since that guidance was correct — only the `<AvatarWidget>` prop list was fictional.

---

## Part 6 — Fix `public/docs/react-sdk.html` and `react-native-sdk.html`

Both currently document the fictional prop set (`position`, `theme`, `size`, `startOpen`, `compactMobile`, `offsetX`, `offsetY`) and, for React, a `useAvatarPlatform()` hook with `ask`/`preload`/`open`/`close`/`hide`/`show`. Replace with the real API:

- **Props table** (both pages): just `serverUrl` (required, "Base URL of your AvatarPlatform deployment, no trailing slash") and `botId` (required) — React Native keeps its existing `style` row.
- **`react-sdk.html`**: remove the entire "useAvatarPlatform hook" `<h2>` section and its two tables; replace with an "Async Q&A" section mirroring `react-native-sdk.html`'s existing pattern (`import { askAvatar } from '@avatar-platform/react'; const result = await askAvatar({ serverUrl, botId, question })`).
- **TypeScript types section** (`react-sdk.html`): replace with the real `AvatarWidgetProps { serverUrl: string; botId: string }`, `AskAvatarOptions`, `AskAvatarResult` shapes from Part 2/3.
- **Next.js example** (`react-sdk.html`): drop the `position` prop from the JSX snippet, add `serverUrl={process.env.NEXT_PUBLIC_AVATARPLATFORM_URL!}`.
- **`react-native-sdk.html`**: update its existing `<AvatarWidget>` example to drop `position`/`theme` (already has `serverUrl`, `botId`, `style` — those stay).
- Both pages' "Installation" `<pre>` blocks stay as-is — the package names were already correct.

## Part 7 — Cleanup

- Delete `public/sdk/react.js` and `public/sdk/README.md` — dead code, superseded by the real `packages/react` and its README. Nothing references `/sdk/react.js` at runtime (verified: zero matches across `public/**/*.html`).
- Remove the now-dead `/sdk/:file` static route in `backend/server.js` (the one guarding `allowed = ['react.js']`).

## Error handling / edge cases

- `askAvatar` on a nonexistent `botId`: the real endpoint 404s with `{ error: 'Chatbot not found' }`; the SDK surfaces that as a thrown `Error` with that message (not a silent empty result).
- `mountAvatarWidget` called twice with the same `botId` (React StrictMode double-invoking effects in dev): the `document.querySelector('script[data-bot="..."]')` guard makes the second call a no-op — no duplicate iframe/launcher.
- `mountAvatarWidget` called with two *different* `botId`s on the same page: both mount independently (embed-loader.js already supports multiple independent script tags — no cross-instance state) — not a scenario the SDK needs to guard against itself.
- SSR (Next.js Server Components, etc.): `mountAvatarWidget` no-ops when `document` is undefined; the React wrapper's `useEffect` never runs during SSR anyway, so this guard is belt-and-suspenders for anyone calling `mountAvatarWidget` directly outside a `useEffect`.
- RN WebView on a device with no microphone permission granted: same behavior as the web widget denying mic access today — the underlying Gemini Live voice path fails gracefully inside the WebView; not a new failure mode this SDK introduces.

## Testing

No automated test suite in this repo (consistent with the rest of the codebase) — manual verification:

1. `npm install` at repo root — confirms workspace linking resolves (`@avatar-platform/js` symlinked into `react`/`vue`/`react-native`'s `node_modules`).
2. `npm run build:sdk` — confirms all four packages build cleanly (`dist/index.js`, `dist/index.cjs`, `dist/index.d.ts` present in each).
3. In a scratch React app (e.g. Vite), `npm link` (or `file:` reference) `@avatar-platform/react`, render `<AvatarWidget serverUrl="http://localhost:8080" botId="<a real project's publicId>" />` against the locally running dev server — confirm the real floating widget appears and functions identically to the plain `<script data-bot>` snippet.
4. Call `askAvatar({ serverUrl: 'http://localhost:8080', botId, question: 'test' })` from a scratch script — confirm it returns `{ answer, sources, sessionId }` matching a direct `curl -X POST localhost:8080/embed/<publicId>/ask`.
5. Repeat step 3's mount check for `@avatar-platform/vue`.
6. For `@avatar-platform/react-native`: cannot fully verify without a device/simulator in this environment — at minimum confirm the package builds and its `AvatarWidget` renders a `WebView` with the correct computed `uri` in a quick RN/Expo scratch project if one is available; otherwise document this as unverified-on-device in the handoff.
7. Confirm `/sdk/react.js` now 404s and `public/docs/react-sdk.html`/`react-native-sdk.html` render correctly with the corrected prop tables and examples.
