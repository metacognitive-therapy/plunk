import {Section, Text} from '@react-email/components';
import * as React from 'react';

interface FooterProps {
  projectId?: string;
}

export function Footer({projectId}: FooterProps) {
  if (!projectId) return null;

  return (
    <Section className="border-t border-gray-100 bg-gray-50 px-8 py-8">
      <Text className="mb-0 mt-0 text-center text-xs leading-relaxed text-gray-400">
        Project ID: <span className="font-mono">{projectId}</span>
      </Text>
    </Section>
  );
}
