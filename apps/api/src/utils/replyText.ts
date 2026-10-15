/** Put at the top of every emailed reply. Whatever the visitor writes above it is their answer. */
export const REPLY_ABOVE_MARKER = '##- Write your reply above this line -##';

/* Lines that start the quoted part of a reply in the mail clients our visitors use, in English
and Norwegian. "On <date>, <name> wrote:" may be wrapped over two lines by the client, so it is
matched on the joined text. */
const QUOTE_HEADERS = [
  /^On\b[^\n]{0,200}?\n?[^\n]{0,200}?\bwrote:\s*$/im,
  /^(?:Den|På)\b[^\n]{0,200}?\n?[^\n]{0,200}?\bskrev\b[^\n]{0,200}(?:\n[^\n]{0,200})?:\s*$/im,
  /^-{2,}\s*(?:Original Message|Opprinnelig melding|Videresendt melding|Forwarded message)\s*-{2,}\s*$/im,
  /^_{10,}\s*$/m,
  /^(?:From|Fra):[^\n]*\n(?:[^\n]*\n){0,3}?(?:Sent|Sendt|Date|Dato):/im,
];

const SIGNATURES = [/^-- ?$/m, /^(?:Sent from my|Sendt fra min|Hentet fra|Get Outlook for)\b.*$/im];

/**
 * Keeps only what the visitor wrote: cuts at our marker, then at the first quote header or
 * signature, and drops any remaining `>` quoted lines.
 */
export function stripQuotedReply(text: string): string {
  let body = text.replace(/\r\n?/g, '\n');

  const marker = body.indexOf(REPLY_ABOVE_MARKER);
  if (marker >= 0) {
    body = body.slice(0, marker);
  }

  for (const pattern of [...QUOTE_HEADERS, ...SIGNATURES]) {
    const match = pattern.exec(body);
    if (match) {
      body = body.slice(0, match.index);
    }
  }

  return body
    .split('\n')
    .filter(line => !line.startsWith('>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
