const en = {
  greeting: 'Hi there 👋',
  intro: 'Ask us anything.',
  replyFewMinutes: 'We usually reply in a few minutes',
  replyFewHours: 'We usually reply in a few hours',
  replyOneDay: 'We usually reply within a day',
  online: "We're online",
  away: "We're away right now",
  backInMinutes: 'Back in {minutes} min',
  backToday: 'Back today at {time}',
  backTomorrow: 'Back tomorrow at {time}',
  backOn: 'Back on {day} at {time}',
  unread: 'Unread reply',
  newConversation: 'Send us a message',
  yourConversations: 'Your conversations',
  placeholder: 'Write a message…',
  send: 'Send',
  back: 'Back',
  close: 'Close',
  you: 'You',
  team: 'The team',
  sending: 'Sending…',
  typing: 'Typing…',
  failed: 'Could not send. Try again.',
  tooFast: "You're sending messages too quickly. Wait a moment and try again.",
  humanCheckFailed: "We couldn't confirm you're human. Try again.",
  unavailable: 'The messenger is not available right now.',
  closed: 'This conversation is closed. Write again to reopen it.',
  emailPrompt: 'Get notified by email',
  emailHint: "We'll email you here if you're away when we reply.",
  emailAwayHint: "We're away right now. Leave your email and we'll reply there too.",
  emailPlaceholder: 'you@example.com',
  emailConsent: 'Also send me news and updates',
  emailSave: 'Save',
  emailSaving: 'Saving…',
  emailSaved: "Thanks! We'll email you at",
  emailInvalid: 'Enter a valid email address.',
  attach: 'Attach a file',
  attachmentTooLarge: 'Files can be up to 10 MB.',
  attachmentFailed: 'Could not load this file.',
  download: 'Download',
};

export type Strings = typeof en;

const catalogs: Record<string, Strings> = {en};

export function stringsFor(language: string | undefined): Strings {
  return (language && catalogs[language]) || en;
}
