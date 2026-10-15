import {type ReactNode, useEffect, useMemo} from 'react';
import {AppState} from 'react-native';

import {conversationOf, MessengerController} from './controller';
import {defaultStrings, type Strings} from './strings';
import type {PlunkConfig, UserLogin} from './types';
import {Messenger} from './ui';
import {xhrTransport} from './xhr-transport';

let current: MessengerController | null = null;
/* A notification handled before <PlunkProvider> mounted, as on a cold start from a tap. */
let early: {pushToken: string | null; notification: unknown} = {pushToken: null, notification: null};

function controller(): MessengerController {
  if (!current) {
    throw new Error('Plunk is not set up yet: render <PlunkProvider> near the root of the app first.');
  }
  return current;
}

/**
 * The messenger's imperative API, shaped after the parts of @intercom/intercom-react-native an app
 * typically calls, so switching is mostly a rename. It acts on the messenger of the mounted
 * <PlunkProvider>.
 */
export const Plunk = {
  /** Signs a user in with tokens from your backend. Their conversations from every device show up. */
  loginUser(login: UserLogin): Promise<void> {
    return controller().loginUser(login);
  },
  /** Starts an anonymous session. If the project checks for bots, an anonymous user can only read past chats. */
  loginUnidentifiedUser(): Promise<void> {
    return controller().loginUnidentifiedUser();
  },
  /** Call on sign-out: the next user starts with no conversations. */
  logout(): Promise<void> {
    return controller().logout();
  },
  present(): void {
    controller().present();
  },
  /** Opens a new conversation with the composer prefilled. */
  presentMessageComposer(initialMessage?: string): void {
    controller().presentMessageComposer(initialMessage);
  },
  presentConversation(conversationId: string): void {
    controller().presentConversation(conversationId);
  },
  hide(): void {
    controller().hide();
  },
  getUnreadConversationCount(): number {
    return controller().getUnreadConversationCount();
  },
  /** Fires whenever the number of conversations with an unread reply changes. Returns an unsubscribe function. */
  addUnreadCountListener(listener: (count: number) => void): () => void {
    return controller().addUnreadCountListener(listener);
  },
  /** An Expo push token from `getExpoPushTokenAsync`. Registered for each signed-in user until logout. */
  registerPushToken(token: string): void {
    if (current) {
      current.registerPushToken(token);
    } else {
      early = {...early, pushToken: token};
    }
  },
  /**
   * Pass a tapped notification's data (`response.notification.request.content.data`). Returns
   * false when it isn't one of ours. The conversation opens once `loginUser` has signed in.
   */
  handlePushNotification(data: unknown): boolean {
    if (current) {
      return current.handlePushNotification(data);
    }
    if (!conversationOf(data)) {
      return false;
    }
    early = {...early, notification: data};
    return true;
  },
};

export interface PlunkProviderProps extends PlunkConfig {
  children?: ReactNode;
  /** Overrides any of the messenger's English labels. */
  strings?: Partial<Strings>;
}

export function PlunkProvider({children, strings, apiUrl, publicKey, storage, pickAttachment}: PlunkProviderProps) {
  /* Storage is read once, when the messenger is created; an inline picker may change every render. */
  const instance = useMemo(() => {
    const created = new MessengerController({apiUrl, publicKey, storage}, xhrTransport);
    if (early.pushToken) {
      created.registerPushToken(early.pushToken);
    }
    if (early.notification) {
      created.handlePushNotification(early.notification);
    }
    early = {pushToken: null, notification: null};
    current = created;
    return created;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl, publicKey]);
  instance.config.pickAttachment = pickAttachment;
  const labels = useMemo(() => ({...defaultStrings, ...strings}), [strings]);

  useEffect(() => {
    current = instance;
    instance.setAppActive(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', state => instance.setAppActive(state === 'active'));
    return () => {
      subscription.remove();
      instance.setAppActive(false);
      if (current === instance) {
        current = null;
      }
    };
  }, [instance]);

  return (
    <>
      {children}
      <Messenger controller={instance} strings={labels} />
    </>
  );
}
