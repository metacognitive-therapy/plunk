import {describe, expect, it} from 'vitest';

import {NEUTRAL_BRAND_NAME, resolveBrand} from '../brand.js';
import {ProjectSchemas} from '../schemas/index.js';

describe('resolveBrand', () => {
  it('uses the project brand when set', () => {
    expect(resolveBrand({brandName: 'MKT-Oslo', brandLogoUrl: 'https://cdn.example.com/logo.png'})).toEqual({
      name: 'MKT-Oslo',
      logoUrl: 'https://cdn.example.com/logo.png',
    });
  });

  it('falls back to the neutral brand, never the project name', () => {
    expect(resolveBrand({brandName: null, brandLogoUrl: null})).toEqual({name: NEUTRAL_BRAND_NAME, logoUrl: null});
    expect(resolveBrand({brandName: '   '})).toEqual({name: NEUTRAL_BRAND_NAME, logoUrl: null});
    expect(resolveBrand(null)).toEqual({name: NEUTRAL_BRAND_NAME, logoUrl: null});
  });
});

describe('ProjectSchemas.update branding', () => {
  const parse = (body: unknown) => ProjectSchemas.update.safeParse(body);

  it('accepts https logos and clearing both fields', () => {
    expect(parse({brandName: 'Metacognitive Therapy', brandLogoUrl: 'https://cdn.example.com/m.png'}).success).toBe(
      true,
    );
    expect(parse({brandName: null, brandLogoUrl: null}).success).toBe(true);
  });

  it('rejects non-https logo URLs', () => {
    expect(parse({brandLogoUrl: 'http://cdn.example.com/m.png'}).success).toBe(false);
    expect(parse({brandLogoUrl: 'http://localhost.example.com/m.png'}).success).toBe(false);
    expect(parse({brandLogoUrl: 'javascript:alert(1)'}).success).toBe(false);
    expect(parse({brandLogoUrl: 'data:image/png;base64,AAAA'}).success).toBe(false);
  });

  it('rejects look-alike characters in the brand name', () => {
    expect(parse({brandName: 'Ｍetacognitive'}).success).toBe(false);
    expect(parse({brandName: 'Meta​cognitive'}).success).toBe(false);
  });
});
