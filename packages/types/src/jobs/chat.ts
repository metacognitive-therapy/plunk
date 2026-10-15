/**
 * Live chat notification job data types
 */

/**
 * Job data for notifying agents about a chat message
 * Used by: chatNotificationQueue worker
 */
export type ChatNotificationJobData =
  | {type: 'mention'; messageId: string}
  /** Emails the visitor the agent replies they have not read, once the project's delay has passed. */
  | {type: 'reply_email'; messageId: string};
