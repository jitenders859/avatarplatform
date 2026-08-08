# @avatar-platform/vue

Vue 3 SDK for [AvatarPlatform](https://avatarplatform.ai) — embed a live AI talking character in any Vue app with one component.

## Install

```bash
npm install @avatar-platform/vue
```

## Quick start

```vue
<script setup>
import { AvatarWidget } from '@avatar-platform/vue';
</script>

<template>
  <YourApp />
  <AvatarWidget server-url="https://your-deployment.com" bot-id="YOUR_BOT_ID" />
</template>
```

Place `<AvatarWidget>` once, typically near your root layout so it persists across route changes. It renders nothing visible itself — it mounts the real embed widget as a side effect, the same one you'd get from the `<script data-bot>` snippet on your dashboard's Embed tab.

### Props

| Prop | Type | Description |
|---|---|---|
| `server-url` | `string` | **Required.** Base URL of your AvatarPlatform deployment, no trailing slash. |
| `bot-id` | `string` | **Required.** Your project's public ID (Dashboard → project → Embed tab). |

There's no `position`/`theme`/`open`/`close` props — those are configured per-project in your AvatarPlatform dashboard's Widget settings, not overridable per-mount.

## `askAvatar(options)`

Headless Q&A — send a question, get a text answer with source citations, without showing the widget at all.

```js
import { askAvatar } from '@avatar-platform/vue';

const { answer, sources } = await askAvatar({
  serverUrl: 'https://your-deployment.com',
  botId: 'YOUR_BOT_ID',
  question: 'What payment methods do you accept?',
});
```

## TypeScript

Type declarations are included.

```ts
import type { AskAvatarOptions, AskAvatarResult } from '@avatar-platform/vue';
```

## License

MIT © AvatarPlatform
