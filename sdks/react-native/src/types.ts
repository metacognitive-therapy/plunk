/*
 * The messenger API's wire types, declared here rather than imported so the published package
 * depends on no private workspace package. `__tests__/types.test.ts` fails to compile if they drift
 * from @plunk/types.
 */

export type ConversationStatus = 'OPEN' | 'SNOOZED' | 'CLOSED';
export type MessageAuthorType = 'CONTACT' | 'AGENT' | 'SYSTEM';
export type ReplyTime = 'FEW_MINUTES' | 'FEW_HOURS' | 'ONE_DAY';

export interface OfficeHoursDay {
  day: number;
  start: number;
  end: number;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface AttachmentLink {
  url: string;
  expiresAt: string;
}

export interface Message {
  id: string;
  authorType: MessageAuthorType;
  agent: {id: string; name: string | null} | null;
  body: string;
  attachments: Attachment[];
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  status: ConversationStatus;
  lastMessageAt: string;
  lastMessage: {body: string; authorType: MessageAuthorType} | null;
  unread: boolean;
}

export interface Conversation {
  id: string;
  status: ConversationStatus;
  /** An imported conversation: shown as history, with no composer. */
  readOnly: boolean;
  messages: Message[];
}

export interface BootResponse {
  token: string;
  expiresAt: string;
  project: {name: string; logoUrl: string | null; language: string};
  appearance: {
    accentColor: string;
    launcherPosition: 'LEFT' | 'RIGHT';
    greeting: string | null;
    team: {id: string; name: string}[];
  };
  availability: {
    replyTime: ReplyTime;
    officeHours: {timezone: string; days: OfficeHoursDay[]} | null;
  };
  serverTime: string;
  visitor: {hasEmail: boolean; verified: boolean};
  turnstileSiteKey: string | null;
}

export interface StartResponse {
  token: string;
  expiresAt: string;
  conversation: Conversation;
}

export type StreamEvent =
  | {type: 'ready'}
  | {type: 'message'; conversationId: string; message: Message}
  | {type: 'conversation'; conversationId: string; status: ConversationStatus}
  | {type: 'typing'; conversationId: string; agentName: string | null};

/** A file chosen by the host app's picker, in the shape React Native's FormData uploads. */
export interface PickedFile {
  uri: string;
  name: string;
  type: string;
  size?: number;
}

/** Where the SDK keeps the visitor id between launches, e.g. AsyncStorage or expo-secure-store. */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface PlunkConfig {
  /** The messaging API, e.g. https://api.example.com. */
  apiUrl: string;
  /** The project's public key (pk_...). */
  publicKey: string;
  /** Without it the visitor id lasts until the app is closed, which only matters for anonymous users. */
  storage?: KeyValueStorage;
  /** Shows the device's picker and resolves with the chosen file, or null when cancelled. */
  pickAttachment?: () => Promise<PickedFile | null>;
}

/** A contact attribute value; null removes the attribute. */
export type UserAttributeValue = string | number | boolean | null;

export interface LogEventOptions {
  /** When it happened, if not now: a Date, an ISO string or epoch milliseconds. */
  occurredAt?: Date | string | number;
}

/** Signs a user in. The token comes from the app's backend, signed with the messenger's identity secret. */
export interface UserLogin {
  /** Called whenever a token is needed, so it can return a fresh one: tokens last an hour at most. */
  getUserToken: () => Promise<string>;
}
