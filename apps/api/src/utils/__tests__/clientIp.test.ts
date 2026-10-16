import type {Request} from 'express';
import {describe, expect, it} from 'vitest';

import {clientIp, isCloudflareAddress} from '../clientIp.js';

function req(ip: string | undefined, cfConnectingIp?: string): Request {
  return {ip, get: (name: string) => (name.toLowerCase() === 'cf-connecting-ip' ? cfConnectingIp : undefined)} as Request;
}

describe('isCloudflareAddress', () => {
  it('recognises Cloudflare edges, including IPv4-mapped and IPv6 ones', () => {
    expect(isCloudflareAddress('172.69.138.90')).toBe(true);
    expect(isCloudflareAddress('104.23.253.58')).toBe(true);
    expect(isCloudflareAddress('::ffff:162.158.1.1')).toBe(true);
    expect(isCloudflareAddress('2606:4700:10::6816:1')).toBe(true);
  });

  it('rejects other and malformed addresses', () => {
    expect(isCloudflareAddress('46.151.194.129')).toBe(false);
    expect(isCloudflareAddress('104.28.211.49')).toBe(false);
    expect(isCloudflareAddress('100.64.0.6')).toBe(false);
    expect(isCloudflareAddress('2001:db8::1')).toBe(false);
    expect(isCloudflareAddress('not-an-ip')).toBe(false);
  });
});

describe('clientIp', () => {
  it('reads the visitor from CF-Connecting-IP when a Cloudflare edge connected', () => {
    expect(clientIp(req('172.69.138.90', '198.51.100.23'))).toBe('198.51.100.23');
    expect(clientIp(req('::ffff:172.69.138.90', ' 2001:db8::7 '))).toBe('2001:db8::7');
  });

  it('ignores the header from anything that is not Cloudflare', () => {
    expect(clientIp(req('203.0.113.9', '198.51.100.23'))).toBe('203.0.113.9');
  });

  it('falls back to req.ip when Cloudflare sent no usable header', () => {
    expect(clientIp(req('172.69.138.90'))).toBe('172.69.138.90');
    expect(clientIp(req('172.69.138.90', 'garbage'))).toBe('172.69.138.90');
    expect(clientIp(req(undefined, '198.51.100.23'))).toBeUndefined();
  });
});
