/* Compiled by `npm run typecheck`: fails when the SDK's copy of the wire types drifts from the API's. */
import type {
  ChatAttachment,
  ChatAttachmentLink,
  MessengerBootResponse,
  MessengerConversation,
  MessengerConversationSummary,
  MessengerMessage,
  MessengerStartResponse,
  MessengerStreamEvent,
} from '@plunk/types';

import type {
  Attachment,
  AttachmentLink,
  BootResponse,
  Conversation,
  ConversationSummary,
  Message,
  StartResponse,
  StreamEvent,
} from '../src/types';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const wireTypesMatch: [
  Same<Attachment, ChatAttachment>,
  Same<AttachmentLink, ChatAttachmentLink>,
  Same<BootResponse, MessengerBootResponse>,
  Same<Conversation, MessengerConversation>,
  Same<ConversationSummary, MessengerConversationSummary>,
  Same<Message, MessengerMessage>,
  Same<StartResponse, MessengerStartResponse>,
  Same<StreamEvent, MessengerStreamEvent>,
] = [true, true, true, true, true, true, true, true];
