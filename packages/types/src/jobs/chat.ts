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
  | {type: 'reply_email'; messageId: string};
