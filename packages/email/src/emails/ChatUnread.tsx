import {Heading, Link, Section, Text} from '@react-email/components';
import * as React from 'react';
import {EmailLayout} from '../common/EmailLayout';
import {Footer} from '../common/Footer';
import {Header} from '../common/Header';

interface ChatUnreadEmailProps {
  sender: string;
  messages: string[];
  minutes: number;
  conversationUrl: string;
  assignedToYou: boolean;
  projectName: string;
}

export function ChatUnreadEmail({
  sender = 'A visitor',
  messages = ['Hi, is the workshop still open for sign-ups?'],
  minutes = 5,
  conversationUrl = 'https://example.com/inbox',
  assignedToYou = false,
  projectName = 'Acme',
}: ChatUnreadEmailProps) {
  return (
    <EmailLayout>
      <Header />

      <Section className="px-8 pb-10 pt-10">
        <Heading className="mb-2 mt-0 text-2xl font-semibold tracking-tight text-gray-900">
          {sender} is waiting for a reply
        </Heading>

        <Text className="mb-8 mt-0 text-base leading-relaxed text-gray-600">
          {assignedToYou
            ? `A conversation assigned to you has had no reply for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
            : `No one on the team has read this for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`}
        </Text>

        <Section className="mb-8 rounded-lg bg-gray-50 px-6 py-4" style={{border: '1px solid #e5e7eb'}}>
          {messages.map((message, index) => (
            <Text
              key={index}
              className={`mt-0 text-sm leading-relaxed text-gray-700 ${index === messages.length - 1 ? 'mb-0' : 'mb-3'}`}
            >
              {message}
            </Text>
          ))}
        </Section>

        <Section>
          <Link
            href={conversationUrl}
            className="inline-block rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white no-underline"
          >
            Open the conversation
          </Link>
        </Section>

        <Text className="mb-0 mt-8 text-xs leading-relaxed text-gray-400">
          You get this because you answer live chat for {projectName}. Turn these emails off under Settings → Messenger
          → Your notifications.
        </Text>
      </Section>

      <Footer />
    </EmailLayout>
  );
}

export default ChatUnreadEmail;
