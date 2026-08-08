// src/AvatarWidget.tsx
import { useEffect } from "react";
import { mountAvatarWidget } from "@avatar-platform/js";
function AvatarWidget({ serverUrl, botId }) {
  useEffect(() => {
    mountAvatarWidget({ serverUrl, botId });
  }, [serverUrl, botId]);
  return null;
}

// src/index.ts
import { askAvatar } from "@avatar-platform/js";
export {
  AvatarWidget,
  askAvatar
};
//# sourceMappingURL=index.js.map