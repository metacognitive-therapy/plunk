const en = {
  greeting: 'Hi there 👋',
  intro: 'Ask us anything. We usually reply within a few hours.',
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
  unavailable: 'The messenger is not available right now.',
  closed: 'This conversation is closed. Write again to reopen it.',
  emailPrompt: 'Get notified by email',
  emailHint: "We'll email you here if you're away when we reply.",
  emailPlaceholder: 'you@example.com',
  emailConsent: 'Also send me news and updates',
  emailSave: 'Save',
  emailSaving: 'Saving…',
  emailSaved: "Thanks! We'll email you at",
  emailInvalid: 'Enter a valid email address.',
};

export type Strings = typeof en;

const catalogs: Record<string, Strings> = {en};

export function stringsFor(language: string | undefined): Strings {
  return (language && catalogs[language]) || en;
}
