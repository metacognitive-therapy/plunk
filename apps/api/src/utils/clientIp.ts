import {BlockList, isIP} from 'node:net';

import type {Request} from 'express';

/* Cloudflare's published edge ranges, from https://www.cloudflare.com/ips/. */
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const cloudflare = new BlockList();
for (const range of CLOUDFLARE_RANGES) {
  const [network = '', prefix] = range.split('/');
  cloudflare.addSubnet(network, Number(prefix), isIP(network) === 6 ? 'ipv6' : 'ipv4');
}

function unmapped(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

export function isCloudflareAddress(ip: string): boolean {
  const address = unmapped(ip);
  const family = isIP(address);
  return family !== 0 && cloudflare.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * The visitor's IP. Behind Cloudflare, `req.ip` is the Cloudflare edge that connected, which many
 * visitors share, so the visitor is read from CF-Connecting-IP instead. The header is believed only
 * when `req.ip` is a Cloudflare edge: a client that connects directly can't choose its address.
 */
export function clientIp(req: Request): string | undefined {
  const ip = req.ip;
  if (ip && isCloudflareAddress(ip)) {
    const header = req.get('cf-connecting-ip')?.trim();
    if (header && isIP(header)) {
      return unmapped(header);
    }
  }
  return ip;
}
