import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import express, {type Request, type Response, Router} from 'express';

import {NODE_ENV} from './constants.js';
import {MessengerSettingsService} from '../services/MessengerSettingsService.js';
import {ProjectService} from '../services/ProjectService.js';

/* src/app and dist/app sit at the same depth under apps/api, so one relative path serves tsx, the
compiled build and the Docker runner alike. */
const DEFAULT_WIDGET_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../widget/dist');

async function frameAncestors(publicKey: unknown): Promise<string> {
  if (typeof publicKey !== 'string' || !publicKey) {
    return "'none'";
  }
  const project = await ProjectService.public(publicKey);
  if (!project) {
    return "'none'";
  }
  const settings = await MessengerSettingsService.get(project.id);
  return settings.enabled && settings.allowedOrigins.length > 0 ? settings.allowedOrigins.join(' ') : "'none'";
}

/**
 * Serves the messenger. The frame page is rendered per request because its frame-ancestors must
 * be the allowlist of the project named in the URL, which overrides helmet's same-origin default.
 */
export function widgetRouter({distDir = DEFAULT_WIDGET_DIST}: {distDir?: string} = {}): Router {
  const router = Router();
  let cachedFrameHtml: string | null = null;

  const frameHtml = async (): Promise<string | null> => {
    if (cachedFrameHtml && NODE_ENV !== 'development') {
      return cachedFrameHtml;
    }
    try {
      cachedFrameHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
      return cachedFrameHtml;
    } catch {
      return null;
    }
  };

  const serveFrame = async (req: Request, res: Response) => {
    const html = await frameHtml();
    if (!html) {
      return res.status(503).type('text/plain').send('The messenger has not been built');
    }

    const ancestors = await frameAncestors(req.query.key);
    res.removeHeader('X-Frame-Options');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
        `frame-ancestors ${ancestors}`,
      ].join('; '),
    );
    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').send(html);
  };

  router.get('/', serveFrame);
  router.get('/frame', serveFrame);

  router.use(
    express.static(distDir, {
      index: false,
      setHeaders(res, filePath) {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
        res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
      },
    }),
  );

  return router;
}
