// src/AvatarWidget.tsx
import { useEffect } from "react";
import { mountAvatarWidget } from "@avatar-platform/js";
function AvatarWidget({ serverUrl, botId }) {
  useEffect(() => {
    mountAvatarWidget({ serverUrl, botId });
  }, [serverUrl, botId]);
  return null;
}

// src/useAvatarPlatform.ts
import { useCallback, useMemo } from "react";
function useAvatarPlatform(botId) {
  const dispatch = useCallback(
    (type) => {
      document.dispatchEvent(new CustomEvent(type, { detail: { botId } }));
    },
    [botId]
  );
  return useMemo(
    () => ({
      open: () => dispatch("ap:open"),
      close: () => dispatch("ap:close"),
      hide: () => dispatch("ap:hide"),
      show: () => dispatch("ap:show")
    }),
    [dispatch]
  );
}

// src/index.ts
import { askAvatar } from "@avatar-platform/js";
export {
  AvatarWidget,
  askAvatar,
  useAvatarPlatform
};
//# sourceMappingURL=index.js.map