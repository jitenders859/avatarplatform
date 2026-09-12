import { defineComponent, onMounted, onBeforeUnmount, watch } from 'vue';
import { mountAvatarWidget, unmountAvatarWidget } from '@avatar-platform/js';

/**
 * Renders nothing itself — mounts the AvatarPlatform embed widget as a
 * side effect. Place once near your app root so it persists across route
 * changes. Written as a render-function component (not a .vue SFC) so the
 * whole workspace can build with plain tsup — no extra Vue-aware bundler
 * plugin needed.
 *
 * Reacts to a botId change by unmounting the previous bot before mounting
 * the new one, and unmounts on the component's own teardown — previously
 * this only ever mounted once on the initial onMounted and never cleaned
 * up, so a changing botId (or the component being torn down) left the old
 * iframe/AudioContext/Gemini Live socket running forever.
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
    watch(
      () => [props.serverUrl, props.botId] as const,
      ([newServerUrl, newBotId], [, oldBotId]) => {
        if (oldBotId) unmountAvatarWidget(oldBotId);
        mountAvatarWidget({ serverUrl: newServerUrl, botId: newBotId });
      }
    );
    onBeforeUnmount(() => unmountAvatarWidget(props.botId));
    return () => null;
  },
});
