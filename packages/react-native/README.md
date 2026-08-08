# @avatar-platform/react-native

React Native SDK for [AvatarPlatform](https://avatarplatform.ai) — embed the AI talking-agent widget in your iOS and Android app using a WebView-based component. Works with Expo (managed and bare) and bare React Native.

## Install

```bash
npm install @avatar-platform/react-native react-native-webview
# or, with Expo:
expo install @avatar-platform/react-native react-native-webview
```

> The SDK depends on `react-native-webview` for rendering the Rive character and Gemini Live audio. Expo Go does not include `react-native-webview` — use a development build or bare workflow for the full `<AvatarWidget>`. The `askAvatar` async helper (below) works in Expo Go since it only uses `fetch`.

## How it works

`<AvatarWidget>` embeds a `WebView` that points to the same `/e/:publicId` page used by the web widget and the raw `<iframe>` embed snippet. Rive runs inside the WebView using its HTML5 canvas renderer; audio is handled by the browser engine inside the WebView. No native modules to link beyond `react-native-webview`.

```tsx
import { AvatarWidget } from '@avatar-platform/react-native';
import { View } from 'react-native';

export default function HomeScreen() {
  return (
    <View style={{ flex: 1 }}>
      <YourContent />

      {/* Floating overlay widget */}
      <AvatarWidget
        serverUrl="https://your-deployment.com"
        botId="YOUR_BOT_ID"
        style={{ position: 'absolute', bottom: 20, right: 20, width: 72, height: 72 }}
      />
    </View>
  );
}
```

### Props

| Prop | Type | Description |
|---|---|---|
| `serverUrl` | `string` | **Required.** Base URL of your AvatarPlatform deployment, no trailing slash. |
| `botId` | `string` | **Required.** The public ID of your project. |
| `style` | `ViewStyle` | Style for the container `View`. Position it yourself (e.g. `position: 'absolute'`) the same way you'd position any floating RN element — defaults to filling its parent. |

There's no `position`/`theme`/`startOpen` props — those are configured per-project in your AvatarPlatform dashboard's Widget settings, not overridable per-mount. Size and placement of the WebView itself is entirely up to your own `style`.

## Platform notes

### iOS

- Add `NSMicrophoneUsageDescription` to your `Info.plist` — the WebView will request mic access for Gemini Live voice chat.
- In Expo, set `infoPlist.NSMicrophoneUsageDescription` in `app.json`.
- Requires iOS 14+ for WebRTC support inside WKWebView.

```xml
<!-- iOS Info.plist -->
<key>NSMicrophoneUsageDescription</key>
<string>The AI assistant needs your microphone to respond by voice.</string>
```

### Android

- Add the `RECORD_AUDIO` permission to `AndroidManifest.xml`.
- The WebView uses `android.webkit.PermissionRequest` to surface the mic prompt to the user.
- Requires Android 7.0+ (API 24).

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.INTERNET" />
```

## `askAvatar(options)` — headless Q&A (no WebView)

For integrations that don't need the animated character — search bars, chatbots, in-app FAQ flows:

```tsx
import { askAvatar } from '@avatar-platform/react-native';

const result = await askAvatar({
  serverUrl: 'https://your-deployment.com',
  botId: 'YOUR_BOT_ID',
  question: 'What payment methods do you accept?',
});

console.log(result.answer);  // text answer
console.log(result.sources); // source citations
```

This calls `POST /embed/:publicId/ask` over HTTPS — no WebView, no audio, no Rive. Works in Expo Go.

## TypeScript

Type declarations are included.

```ts
import type { AvatarWidgetProps, AskAvatarOptions, AskAvatarResult } from '@avatar-platform/react-native';
```

## License

MIT © AvatarPlatform
