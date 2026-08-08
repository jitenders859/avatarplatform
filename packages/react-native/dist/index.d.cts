import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
export { AskAvatarOptions, AskAvatarResult, AskAvatarSource, askAvatar } from '@avatar-platform/js';

interface AvatarWidgetProps {
    /** Base URL of your AvatarPlatform deployment, no trailing slash. */
    serverUrl: string;
    /** Your project's public ID. */
    botId: string;
    /** Container style — position it yourself (e.g. absolute + bottom/right) the same way you'd position any floating RN element. Defaults to filling its parent. */
    style?: StyleProp<ViewStyle>;
}
/**
 * WebView pointed at the same /e/:publicId page the web widget and raw
 * <iframe> embed snippet use — Rive rendering and Gemini Live audio run
 * inside the WebView's own browser engine. Requires react-native-webview
 * (peer dependency) and mic permissions declared in your app (see README).
 */
declare function AvatarWidget({ serverUrl, botId, style }: AvatarWidgetProps): React.JSX.Element;

export { AvatarWidget, type AvatarWidgetProps };
