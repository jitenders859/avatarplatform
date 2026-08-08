# @avatar-platform/react

React SDK for [AvatarPlatform](https://avatarplatform.ai) — embed a live AI talking character in any React app with one component.

## Install

```bash
npm install @avatar-platform/react
# or
yarn add @avatar-platform/react
# or
pnpm add @avatar-platform/react
```

## Quick start

```jsx
import { AvatarWidget } from '@avatar-platform/react';

export default function App() {
  return (
    <>
      <YourApp />
      <AvatarWidget
        serverUrl="https://your-deployment.com"
        botId="YOUR_BOT_ID"
      />
    </>
  );
}
```

Place `<AvatarWidget>` once, typically near your root layout so it persists across route changes. It renders nothing visible itself — it mounts the real embed widget as a side effect, the same one you'd get from the `<script data-bot>` snippet on your dashboard's Embed tab.

### Props

| Prop | Type | Description |
|---|---|---|
| `serverUrl` | `string` | **Required.** Base URL of your AvatarPlatform deployment, no trailing slash. |
| `botId` | `string` | **Required.** Your project's public ID (Dashboard → project → Embed tab). |

There's no `position`/`theme`/`open`/`close` props — those are configured per-project in your AvatarPlatform dashboard's Widget settings, not overridable per-mount.

## `askAvatar(options)`

Headless Q&A — send a question, get a text answer with source citations, without showing the widget at all.

```jsx
import { askAvatar } from '@avatar-platform/react';

async function handleSearch(query) {
  const { answer, sources } = await askAvatar({
    serverUrl: 'https://your-deployment.com',
    botId: 'YOUR_BOT_ID',
    question: query,
  });
  console.log(answer, sources);
}
```

## Next.js

Mark the component as a client component and add it to your root layout:

```tsx
// app/layout.tsx
'use client';
import { AvatarWidget } from '@avatar-platform/react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <AvatarWidget
          serverUrl={process.env.NEXT_PUBLIC_AVATARPLATFORM_URL!}
          botId={process.env.NEXT_PUBLIC_BOT_ID!}
        />
      </body>
    </html>
  );
}
```

The widget renders on the client only — safe inside `'use client'` components; the rest of your tree can stay a Server Component.

## TypeScript

Type declarations are included.

```ts
import type { AvatarWidgetProps, AskAvatarOptions, AskAvatarResult } from '@avatar-platform/react';
```

## License

MIT © AvatarPlatform
