/**
 * Live chat notification job data types
 */

/**
 * Job data for notifying agents about a chat message
 * Used by: chatNotificationQueue worker
 */
export type ChatNotificationJobData = {type: 'mention'; messageId: string};
