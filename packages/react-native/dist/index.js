// src/AvatarWidget.tsx
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { jsx } from "react/jsx-runtime";
function AvatarWidget({ serverUrl, botId, style }) {
  const uri = `${serverUrl.replace(/\/$/, "")}/e/${encodeURIComponent(botId)}`;
  return /* @__PURE__ */ jsx(View, { style: style ?? { flex: 1 }, children: /* @__PURE__ */ jsx(
    WebView,
    {
      source: { uri },
      allowsInlineMediaPlayback: true,
      mediaPlaybackRequiresUserAction: false,
      originWhitelist: ["*"]
    }
  ) });
}

// src/index.ts
import { askAvatar } from "@avatar-platform/js";
export {
  AvatarWidget,
  askAvatar
};
//# sourceMappingURL=index.js.map