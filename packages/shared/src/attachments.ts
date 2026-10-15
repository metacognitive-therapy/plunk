/* Dependency-free so the messenger bundle can import it through the `./attachments` subpath. */

export const CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/* Types the messenger and the Inbox accept, with the extensions a picker should offer. SVG and
HTML are left out on purpose: they are served from the API origin and could run script. */
export const CHAT_ATTACHMENT_TYPES: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt'],
  'text/csv': ['.csv'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};

export const CHAT_ATTACHMENT_ACCEPT = Object.entries(CHAT_ATTACHMENT_TYPES)
  .flatMap(([type, extensions]) => [type, ...extensions])
  .join(',');

export function isInlineImage(contentType: string): boolean {
  return contentType.startsWith('image/');
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
