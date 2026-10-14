import {type Brand, NEUTRAL_BRAND} from '@plunk/shared';
import {Img, Section, Text} from '@react-email/components';
import * as React from 'react';

interface HeaderProps {
  brand?: Brand;
}

export function Header({brand = NEUTRAL_BRAND}: HeaderProps) {
  return (
    <Section className="border-b border-gray-100 bg-white px-8 py-8">
      {brand.logoUrl ? (
        <Img src={brand.logoUrl} alt={brand.name} width="40" height="40" className="mx-auto" />
      ) : (
        <Text className="m-0 text-center text-lg font-semibold tracking-tight text-gray-900">{brand.name}</Text>
      )}
    </Section>
  );
}
