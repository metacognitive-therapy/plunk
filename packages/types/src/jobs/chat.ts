/**
 * Live chat notification job data types
 */

/**
 * Job data for notifying agents about a chat message
 * Used by: chatNotificationQueue worker
 */
export type ChatNotificationJobData =
  | {type: 'mention'; messageId: string}
  /** Notifies agents of a visitor message, in the dashboard and by push. */
  | {type: 'visitor_message'; messageId: string}
  /** Emails the visitor the agent replies they have not read, once the project's delay has passed. */
  | {type: 'reply_email'; messageId: string}
  /** Emails agents about a visitor message still unread after the project's delay. */
  | {type: 'agent_email'; messageId: string}
  /** Posts a new conversation, or a reply on an unassigned one, to the project's Slack webhook. */
  | {type: 'slack'; messageId: string};
