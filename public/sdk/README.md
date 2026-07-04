# @avatar-platform/react

React SDK for [AvatarPlatform](https://avatarplatform.ai) — embed a live AI talking character in any React app with one component.

## Install

```bash
npm install @avatar-platform/react
# or
yarn add @avatar-platform/react
```

## Quick start

```jsx
import { AvatarWidget } from '@avatar-platform/react';

export default function App() {
  return (
    <AvatarWidget
      botId="your-public-id"
      position="bottom-right"
      theme="#6366f1"
      size="md"
    />
  );
}
```

---

## `<AvatarWidget>` props

| Prop | Type | Default | Description |
|---|---|---|---|
| `botId` | `string` | **required** | Your project's `publicId` from the AvatarPlatform dashboard |
| `position` | `'bottom-right' \| 'bottom-left'` | `'bottom-right'` | Widget anchor corner |
| `theme` | `string` | `'#6366f1'` | Primary accent colour (hex) |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | Widget size |
| `startOpen` | `boolean` | `false` | Open the chat panel on first render |
| `compactMobile` | `boolean` | `true` | Shrink avatar on screens < 768 px |

---

## `useAvatarPlatform(botId)`

Imperative controls for a mounted widget.

```jsx
import { AvatarWidget, useAvatarPlatform } from '@avatar-platform/react';

function ChatPage() {
  const { ask, preload, open, close } = useAvatarPlatform('your-public-id');

  // Prefetch config before the widget opens
  useEffect(() => { preload(); }, []);

  async function handleSearch(query) {
    const { answer, sources } = await ask(query);
    console.log(answer, sources);
  }

  return (
    <>
      <AvatarWidget botId="your-public-id" />
      <button onClick={open}>Open chat</button>
    </>
  );
}
```

### Return values

| Name | Signature | Description |
|---|---|---|
| `ask` | `(question: string, sessionId?: string) => Promise<{answer, sources, sessionId}>` | Send a question and get a text answer with source cards |
| `preload` | `() => Promise<config>` | Fetch and cache bot config — call early to eliminate first-load latency |
| `open` | `() => void` | Programmatically open the widget panel |
| `close` | `() => void` | Programmatically close the widget panel |

---

## How it works

The npm package bundles [lipsync-sdk.js](https://avatarplatform.ai/lipsync-sdk.js) — the same embed script served from the platform — as a React component wrapper. The `<AvatarWidget>` component injects the script tag with the correct `data-*` attributes and removes it on unmount.

The browser-compatible ES module at `/sdk/react.js` (this repo) imports React directly from `esm.run` and is used for live documentation demos. The npm package ships a standard CommonJS + ESM bundle that works with your existing React installation.

---

## TypeScript

Type declarations are included in the npm package. The browser module works with `// @ts-ignore` or a local `.d.ts` shim:

```ts
declare module '@avatar-platform/react' {
  export interface AvatarWidgetProps {
    botId: string;
    position?: 'bottom-right' | 'bottom-left';
    theme?: string;
    size?: 'sm' | 'md' | 'lg';
    startOpen?: boolean;
    compactMobile?: boolean;
  }
  export function AvatarWidget(props: AvatarWidgetProps): JSX.Element;
  export function useAvatarPlatform(botId: string): {
    ask: (question: string, sessionId?: string) => Promise<{ answer: string; sources: object[]; sessionId: string }>;
    preload: () => Promise<object>;
    open: () => void;
    close: () => void;
  };
}
```

---

## License

MIT © AvatarPlatform
