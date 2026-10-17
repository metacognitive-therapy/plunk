import {Img, Section} from '@react-email/components';
import * as React from 'react';

export function Header() {
  return (
    <Section className="border-b border-gray-100 bg-white px-8 py-8">
      <Img
        src="https://www.useplunk.com/assets/logo.png"
        alt="Plunk"
        width="40"
        height="40"
        className="mx-auto"
      />
    </Section>
  );
}
