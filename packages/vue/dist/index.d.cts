import * as vue from 'vue';
export { AskAvatarOptions, AskAvatarResult, AskAvatarSource, askAvatar } from '@avatar-platform/js';

/**
 * Renders nothing itself — mounts the AvatarPlatform embed widget as a
 * side effect. Place once near your app root so it persists across route
 * changes. Written as a render-function component (not a .vue SFC) so the
 * whole workspace can build with plain tsup — no extra Vue-aware bundler
 * plugin needed.
 */
declare const AvatarWidget: vue.DefineComponent<vue.ExtractPropTypes<{
    /** Base URL of your AvatarPlatform deployment, no trailing slash. */
    serverUrl: {
        type: StringConstructor;
        required: true;
    };
    /** Your project's public ID. */
    botId: {
        type: StringConstructor;
        required: true;
    };
}>, () => null, {}, {}, {}, vue.ComponentOptionsMixin, vue.ComponentOptionsMixin, {}, string, vue.PublicProps, Readonly<vue.ExtractPropTypes<{
    /** Base URL of your AvatarPlatform deployment, no trailing slash. */
    serverUrl: {
        type: StringConstructor;
        required: true;
    };
    /** Your project's public ID. */
    botId: {
        type: StringConstructor;
        required: true;
    };
}>> & Readonly<{}>, {}, {}, {}, {}, string, vue.ComponentProvideOptions, true, {}, any>;

export { AvatarWidget };
