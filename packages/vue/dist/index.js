// src/AvatarWidget.ts
import { defineComponent, onMounted, onBeforeUnmount, watch } from "vue";
import { mountAvatarWidget, unmountAvatarWidget } from "@avatar-platform/js";
var AvatarWidget = defineComponent({
  name: "AvatarWidget",
  props: {
    /** Base URL of your AvatarPlatform deployment, no trailing slash. */
    serverUrl: { type: String, required: true },
    /** Your project's public ID. */
    botId: { type: String, required: true }
  },
  setup(props) {
    onMounted(() => {
      mountAvatarWidget({ serverUrl: props.serverUrl, botId: props.botId });
    });
    watch(
      () => [props.serverUrl, props.botId],
      ([newServerUrl, newBotId], [, oldBotId]) => {
        if (oldBotId) unmountAvatarWidget(oldBotId);
        mountAvatarWidget({ serverUrl: newServerUrl, botId: newBotId });
      }
    );
    onBeforeUnmount(() => unmountAvatarWidget(props.botId));
    return () => null;
  }
});

// src/index.ts
import { askAvatar } from "@avatar-platform/js";
export {
  AvatarWidget,
  askAvatar
};
//# sourceMappingURL=index.js.map