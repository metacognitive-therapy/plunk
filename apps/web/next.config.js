/** @type {import('next').NextConfig} */
module.exports = {
  transpilePackages: ['@plunk/ui'],
  output: 'standalone', // Optimized for Docker
  async headers() {
    return [
      {
        /* A cached service worker would keep old push handling alive long after a deploy. */
        source: '/sw.js',
        headers: [
          {key: 'Content-Type', value: 'application/javascript; charset=utf-8'},
          {key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate'},
          {key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'"},
        ],
      },
    ];
  },
};
