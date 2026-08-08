# @avatar-platform/js

Core JS SDK for [AvatarPlatform](https://avatarplatform.ai) — mount the embeddable talking-agent widget, or call the headless ask API, from any web page. No framework required (see `@avatar-platform/react` / `@avatar-platform/vue` for framework wrappers).

## Install

```bash
npm install @avatar-platform/js
```

## `mountAvatarWidget(options)`

Mounts the same floating chat widget you'd get from the `<script data-bot>` snippet on your dashboard's Embed tab.

```js
import { mountAvatarWidget } from '@avatar-platform/js';

mountAvatarWidget({
  serverUrl: 'https://your-deployment.com',
  botId: 'YOUR_BOT_ID',
});
```

Call this once, typically as early as possible in your app's lifecycle (e.g. your root layout/entry file). It's safe to call more than once with the same `botId` — later calls are a no-op. There's no `unmount` — the underlying embed script doesn't support teardown, so the widget is meant to persist for the page's lifetime, the same way a support-chat widget script normally would.

| Option | Type | Description |
|---|---|---|
| `serverUrl` | `string` | **Required.** Base URL of your AvatarPlatform deployment, no trailing slash. |
| `botId` | `string` | **Required.** Your project's public ID (Dashboard → project → Embed tab). |

## `askAvatar(options)`

Headless Q&A — send a question, get a text answer with source citations back. No widget UI involved.

```js
import { askAvatar } from '@avatar-platform/js';

const result = await askAvatar({
  serverUrl: 'https://your-deployment.com',
  botId: 'YOUR_BOT_ID',
  question: 'What payment methods do you accept?',
});

console.log(result.answer);   // string
console.log(result.sources);  // { title, url, snippet }[]
console.log(result.sessionId); // pass this back in to continue the same conversation
```

| Option | Type | Description |
|---|---|---|
| `serverUrl` | `string` | **Required.** |
| `botId` | `string` | **Required.** |
| `question` | `string` | **Required.** |
| `sessionId` | `string` | Optional — continue an existing conversation instead of starting a new one. |

## TypeScript

Type declarations are included.

```ts
import type { MountAvatarWidgetOptions, AskAvatarOptions, AskAvatarResult, AskAvatarSource } from '@avatar-platform/js';
```

## License

MIT © AvatarPlatform
