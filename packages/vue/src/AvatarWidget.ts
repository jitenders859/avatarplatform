import { defineComponent, onMounted } from 'vue';
import { mountAvatarWidget } from '@avatar-platform/js';

/**
 * Renders nothing itself — mounts the AvatarPlatform embed widget as a
 * side effect. Place once near your app root so it persists across route
 * changes. Written as a render-function component (not a .vue SFC) so the
 * whole workspace can build with plain tsup — no extra Vue-aware bundler
 * plugin needed.
 */
export const AvatarWidget = defineComponent({
  name: 'AvatarWidget',
  props: {
    /** Base URL of your AvatarPlatform deployment, no trailing slash. */
    serverUrl: { type: String, required: true },
    /** Your project's public ID. */
    botId: { type: String, required: true },
  },
  setup(props) {
    onMounted(() => {
      mountAvatarWidget({ serverUrl: props.serverUrl, botId: props.botId });
    });
    return () => null;
  },
});
