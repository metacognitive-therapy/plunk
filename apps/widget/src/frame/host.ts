import {
  type DistributiveOmit,
  type FrameMessage,
  type HostMessage,
  PROTOCOL,
  VISITOR_ID_PATTERN,
  isProtocolMessage,
} from '../shared/protocol';

export interface HostBridge {
  parentOrigin: string;
  post(message: DistributiveOmit<FrameMessage, 'source'>): void;
  on(type: 'opened' | 'closed' | 'update', listener: () => void): () => void;
}

/**
 * Waits for the loader on the host page to hand over the visitor id. Only messages from the
 * parent window at the origin named in the frame URL are trusted; boot then checks that origin
 * against the project's allowlist, and frame-ancestors stops any other site from framing us.
 */
export function connectToHost(
  parentOrigin: string | null,
  onInit: (visitorId: string, bridge: HostBridge, userToken?: string) => void,
) {
  if (!parentOrigin || window.parent === window) {
    return;
  }

  const listeners = new Map<string, Set<() => void>>();
  const bridge: HostBridge = {
    parentOrigin,
    post(message) {
      window.parent.postMessage({source: PROTOCOL, ...message}, parentOrigin);
    },
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
      return () => set.delete(listener);
    },
  };

  let initialised = false;
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== parentOrigin || !isProtocolMessage(event.data)) {
      return;
    }
    const message = event.data as HostMessage;
    if (message.type === 'init') {
      if (!initialised && VISITOR_ID_PATTERN.test(message.visitorId)) {
        initialised = true;
        const userToken = typeof message.userToken === 'string' && message.userToken ? message.userToken : undefined;
        onInit(message.visitorId, bridge, userToken);
      }
      return;
    }
    listeners.get(message.type)?.forEach(listener => listener());
  });

  bridge.post({type: 'ready'});
}
