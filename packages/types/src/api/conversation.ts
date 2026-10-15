export type ConversationStatusValue = 'OPEN' | 'SNOOZED' | 'CLOSED';
export type MessageAuthorTypeValue = 'CONTACT' | 'AGENT' | 'SYSTEM';
export type MessageKindValue = 'COMMENT' | 'NOTE';

export interface MessengerAgent {
  id: string;
  /** Null when the agent has no name; visitors never see an agent's email. */
  name: string | null;
}

/** File details only: the content is fetched through a short-lived link issued on request. */
export interface ChatAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface ChatAttachmentLink {
  url: string;
  expiresAt: string;
}

/** Internal notes are never included in messenger responses. */
export interface MessengerMessage {
  id: string;
  authorType: MessageAuthorTypeValue;
  agent: MessengerAgent | null;
  /** Empty when the message is only an attachment. */
  body: string;
  attachments: ChatAttachment[];
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

export type MessengerReplyTimeValue = 'FEW_MINUTES' | 'FEW_HOURS' | 'ONE_DAY';

/** One open stretch on an ISO weekday (1 = Monday), in minutes after local midnight. End is exclusive, up to 1440. */
export interface OfficeHoursDay {
  day: number;
  start: number;
  end: number;
}

export interface MessengerAvailability {
  replyTime: MessengerReplyTimeValue;
  /** Null when the project has no office hours, so the team is never shown as away. */
  officeHours: {timezone: string; days: OfficeHoursDay[]} | null;
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
  availability: MessengerAvailability;
  /** The server's clock, so office hours are judged by it rather than by the visitor's device. */
  serverTime: string;
  visitor: {
    hasEmail: boolean;
  };
  /** Set when the server checks new conversations with Cloudflare Turnstile. */
  turnstileSiteKey: string | null;
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
  /** Agents @mentioned in a note. */
  mentions: {id: string; name: string}[];
  attachments: ChatAttachment[];
  /** When an agent comment was emailed because the visitor had not read it. */
  emailedAt: string | null;
  /** Sender of an email reply that did not come from the contact's address. Set on NOTEs only. */
  unverifiedSender: string | null;
  createdAt: string;
}

/** Assignable members of a project: owners and members flagged as support agents. */
export interface InboxAgent {
  id: string;
  name: string;
  email: string;
}

/** Conversations with unread visitor messages that are the agent's: assigned to them or unassigned. */
export interface InboxUnread {
  total: number;
  /** A total equal to the cap means "cap or more". */
  cap: number;
  projects: Record<string, number>;
}

export interface AgentNotificationPrefs {
  inboxBadge: boolean;
  inboxTitleCount: boolean;
  inboxSound: boolean;
  pushPreview: boolean;
  inboxEmail: boolean;
}

/** What the dashboard's service worker shows for one push. */
export interface ChatPushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
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
  tags: InboxTag[];
}

export interface InboxTag {
  id: string;
  name: string;
}

export interface SavedReply {
  id: string;
  title: string;
  /** Template source; variables are filled in when it is inserted into a conversation. */
  body: string;
  updatedAt: string;
}

export interface InboxConversation extends InboxConversationSummary {
  channel: string;
  contactLastReadAt: string | null;
  createdAt: string;
  messages: InboxMessage[];
}

/** A conversation as listed on a contact. `lastMessage` is null for members who can't open conversations. */
export interface ContactConversationSummary {
  id: string;
  status: ConversationStatusValue;
  channel: string;
  createdAt: string;
  lastMessageAt: string;
  lastMessage: {body: string; authorType: MessageAuthorTypeValue} | null;
}

export interface ContactConversations {
  /** Whether the signed-in member may open these conversations in the Inbox. */
  canOpen: boolean;
  total: number;
  conversations: ContactConversationSummary[];
}

/** The contact behind a conversation, as shown beside it in the Inbox. */
export interface InboxContactProfile extends InboxContact {
  subscribed: boolean;
  createdAt: string;
  tags: {id: string; name: string}[];
  segments: {id: string; name: string}[];
  events: {id: string; name: string; createdAt: string}[];
  /** The contact's other conversations, newest first. */
  conversations: ContactConversationSummary[];
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
  /** Receiving subdomain for emailed replies, e.g. reply.example.com. */
  replyDomain: string | null;
  /** The address emailed replies are sent from. */
  replyFromEmail: string | null;
  /** How long a message can sit unread before it is emailed: agent replies to the visitor, visitor messages to agents. */
  emailDelayMinutes: number;
  /** Whether a Slack webhook is saved. The URL itself is a credential and never leaves the server. */
  slackConnected: boolean;
  replyTime: MessengerReplyTimeValue;
  officeHoursEnabled: boolean;
  officeHours: OfficeHoursDay[];
  /** IANA time zone the office hours are kept in, e.g. Europe/Oslo. */
  timezone: string;
  /** Closed conversations are deleted this many months after they were closed. */
  retentionMonths: number;
}

/** Pushed to one visitor's messenger. Never carries internal notes or another visitor's threads. */
export type MessengerStreamEvent =
  | {type: 'ready'}
  | {type: 'message'; conversationId: string; message: MessengerMessage}
  | {type: 'conversation'; conversationId: string; status: ConversationStatusValue}
  | {type: 'typing'; conversationId: string; agentName: string | null};

export type InboxTypingAuthor = {type: 'CONTACT'} | {type: 'AGENT'; userId: string; name: string};

export type InboxReader = {type: 'CONTACT'; readAt: string} | {type: 'AGENT'; userId: string};

/** Pushed to one signed-in user, whichever project they are looking at. */
export type AgentStreamEvent =
  | {type: 'ready'}
  /* A visitor wrote in a project the agent supports. `alert` is true when the agent is one the
  message notifies: the assignee, or every agent while unassigned. */
  | {type: 'visitor_message'; projectId: string; conversationId: string; alert: boolean}
  | {
      type: 'mention';
      projectId: string;
      conversationId: string;
      messageId: string;
      author: {id: string; name: string};
      preview: string;
    };

/** Pushed to every support agent of a project. Per-agent state such as unread is refetched, not pushed. */
export type InboxStreamEvent =
  | {type: 'ready'}
  | {type: 'message'; conversationId: string; message: InboxMessage}
  | {type: 'conversation'; conversationId: string}
  | {type: 'typing'; conversationId: string; author: InboxTypingAuthor}
  | {type: 'read'; conversationId: string; reader: InboxReader}
  /* Tags were renamed or deleted, which can change any conversation in the list. */
  | {type: 'tags'};
