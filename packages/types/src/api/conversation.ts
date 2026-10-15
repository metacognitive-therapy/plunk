export type ConversationStatusValue = 'OPEN' | 'SNOOZED' | 'CLOSED';
export type MessageAuthorTypeValue = 'CONTACT' | 'AGENT' | 'SYSTEM';
export type MessageKindValue = 'COMMENT' | 'NOTE';

export interface MessengerAgent {
  id: string;
  /** Null when the agent has no name; visitors never see an agent's email. */
  name: string | null;
}

/** Internal notes are never included in messenger responses. */
export interface MessengerMessage {
  id: string;
  authorType: MessageAuthorTypeValue;
  agent: MessengerAgent | null;
  body: string;
  createdAt: string;
}

export interface MessengerConversationSummary {
  id: string;
  status: ConversationStatusValue;
  lastMessageAt: string;
  lastMessage: {body: string; authorType: MessageAuthorTypeValue} | null;
  unread: boolean;
}

export interface MessengerConversation {
  id: string;
  status: ConversationStatusValue;
  messages: MessengerMessage[];
}

export interface MessengerStartResponse {
  token: string;
  expiresAt: string;
  conversation: MessengerConversation;
}

export type MessengerLauncherPositionValue = 'LEFT' | 'RIGHT';

export interface MessengerAppearance {
  accentColor: string;
  launcherPosition: MessengerLauncherPositionValue;
  /** Null means the messenger's default greeting in the project's language. */
  greeting: string | null;
  /** Named support agents only, in the order the project chose. */
  team: {id: string; name: string}[];
}

export interface MessengerBootResponse {
  token: string;
  expiresAt: string;
  project: {
    name: string;
    logoUrl: string | null;
    language: string;
  };
  appearance: MessengerAppearance;
  visitor: {
    hasEmail: boolean;
  };
}

export interface MessengerEmailResponse {
  token: string;
  expiresAt: string;
}

/** What a SYSTEM line records. The author of the line is the agent who acted, if any. */
export type InboxSystemEvent =
  | {action: 'closed'}
  | {action: 'reopened'; trigger: 'agent' | 'contact' | 'snooze_expired'}
  | {action: 'snoozed'; until: string | null}
  | {action: 'assigned'; assignee: {id: string; name: string}}
  | {action: 'unassigned'};

export interface InboxMessage {
  id: string;
  authorType: MessageAuthorTypeValue;
  kind: MessageKindValue;
  author: {id: string; name: string; email: string} | null;
  body: string;
  source: string;
  /** Set on SYSTEM lines only. */
  event: InboxSystemEvent | null;
  createdAt: string;
}

/** Assignable members of a project: owners and members flagged as support agents. */
export interface InboxAgent {
  id: string;
  name: string;
  email: string;
}

/** Per-view totals, each capped at `cap`; a value equal to the cap means "cap or more". */
export interface InboxCounts {
  unassigned: number;
  mine: number;
  all: number;
  closed: number;
  cap: number;
}

export interface InboxContact {
  id: string;
  email: string | null;
  externalId: string | null;
  data: Record<string, unknown> | null;
}

export interface InboxConversationSummary {
  id: string;
  status: ConversationStatusValue;
  assigneeId: string | null;
  /** Null while SNOOZED means "until the visitor replies". */
  snoozedUntil: string | null;
  contact: InboxContact;
  lastMessageAt: string;
  lastMessage: {body: string; authorType: MessageAuthorTypeValue} | null;
  unread: boolean;
}

export interface InboxConversation extends InboxConversationSummary {
  channel: string;
  contactLastReadAt: string | null;
  createdAt: string;
  messages: InboxMessage[];
}

export interface InboxPage {
  conversations: InboxConversationSummary[];
  nextCursor: string | null;
}

export interface MessengerSettingsData {
  enabled: boolean;
  allowedOrigins: string[];
  accentColor: string;
  launcherPosition: MessengerLauncherPositionValue;
  greeting: string | null;
  teamUserIds: string[];
}

/** Pushed to one visitor's messenger. Never carries internal notes or another visitor's threads. */
export type MessengerStreamEvent =
  | {type: 'ready'}
  | {type: 'message'; conversationId: string; message: MessengerMessage}
  | {type: 'conversation'; conversationId: string; status: ConversationStatusValue}
  | {type: 'typing'; conversationId: string; agentName: string | null};

export type InboxTypingAuthor = {type: 'CONTACT'} | {type: 'AGENT'; userId: string; name: string};

export type InboxReader = {type: 'CONTACT'; readAt: string} | {type: 'AGENT'; userId: string};

/** Pushed to every support agent of a project. Per-agent state such as unread is refetched, not pushed. */
export type InboxStreamEvent =
  | {type: 'ready'}
  | {type: 'message'; conversationId: string; message: InboxMessage}
  | {type: 'conversation'; conversationId: string}
  | {type: 'typing'; conversationId: string; author: InboxTypingAuthor}
  | {type: 'read'; conversationId: string; reader: InboxReader};
