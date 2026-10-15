import {type ReactNode, useEffect, useMemo} from 'react';
import {AppState} from 'react-native';

import {MessengerController} from './controller';
import {defaultStrings, type Strings} from './strings';
import type {PlunkConfig, UserLogin} from './types';
import {Messenger} from './ui';
import {xhrTransport} from './xhr-transport';

let current: MessengerController | null = null;

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
