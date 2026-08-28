import { useCallback, useMemo } from 'react';

export interface UseAvatarPlatformResult {
  open: () => void;
  close: () => void;
  hide: () => void;
  show: () => void;
}

/**
 * Thin wrapper around the `ap:open`/`ap:close`/`ap:hide`/`ap:show` document
 * events that embed-loader.js (the script AvatarWidget mounts) listens for
 * — see public/docs/prefetching.html "Controlling the widget". Doesn't talk
 * to the widget directly; it only dispatches the same events a vanilla-JS
 * page would, so it works with whichever <AvatarWidget> instance is mounted
 * for `botId`.
 */
export function useAvatarPlatform(botId: string): UseAvatarPlatformResult {
  const dispatch = useCallback(
    (type: 'ap:open' | 'ap:close' | 'ap:hide' | 'ap:show') => {
      document.dispatchEvent(new CustomEvent(type, { detail: { botId } }));
    },
    [botId]
  );

  return useMemo(
    () => ({
      open: () => dispatch('ap:open'),
      close: () => dispatch('ap:close'),
      hide: () => dispatch('ap:hide'),
      show: () => dispatch('ap:show'),
    }),
    [dispatch]
  );
}
