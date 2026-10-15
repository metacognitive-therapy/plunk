/*
 * Stands in for the app's backend: signs messenger user tokens with the identity secret from
 * Settings > Messenger. Development only. In a real app the backend signs a token for the user it
 * has authenticated, never for whatever the client asks.
 *
 *   PLUNK_IDENTITY_SECRET=... node token-server.mjs
 */
import {createHmac} from 'node:crypto';
import {createServer} from 'node:http';

const secret = process.env.PLUNK_IDENTITY_SECRET;
const port = Number(process.env.PORT ?? 5602);
if (!secret) {
  console.error('Set PLUNK_IDENTITY_SECRET to the messenger identity secret.');
  process.exit(1);
}

const base64url = value => Buffer.from(value).toString('base64url');

function sign(claims) {
  const header = base64url(JSON.stringify({alg: 'HS256', typ: 'JWT'}));
  const payload = base64url(JSON.stringify({...claims, exp: Math.floor(Date.now() / 1000) + 3600}));
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/token') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    const {sub, email, name} = JSON.parse(body || '{}');
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({token: sign({sub, email, name})}));
  });
}).listen(port, () => console.log(`Token server on http://localhost:${port}`));
