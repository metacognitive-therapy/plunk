import {VISITOR_ID_PATTERN} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';
import signale from 'signale';

import {RateLimitError} from '../exceptions/index.js';
import {Keys} from '../services/keys.js';
import {clientIp} from '../utils/clientIp.js';
import {takeToken} from './rateLimit.js';

interface Budget {
  burst: number;
  /** Tokens regained per second. */
  refill: number;
}

/* Sized for a person typing in a chat, not for integrations, so unlike the API's project budgets
these are always on. The IP budget is looser than the visitor one because offices and mobile
carriers put many visitors behind one address. */
const BUDGETS = {
  boot: {visitor: {burst: 30, refill: 1 / 5}, ip: {burst: 120, refill: 1}},
  start: {visitor: {burst: 5, refill: 1 / 120}, ip: {burst: 20, refill: 1 / 30}},
  message: {visitor: {burst: 30, refill: 1 / 2}, ip: {burst: 120, refill: 2}},
  upload: {visitor: {burst: 10, refill: 1 / 30}, ip: {burst: 30, refill: 1 / 10}},
  email: {visitor: {burst: 5, refill: 1 / 60}, ip: {burst: 20, refill: 1 / 30}},
  push: {visitor: {burst: 10, refill: 1 / 60}, ip: {burst: 60, refill: 1 / 5}},
  /* Apps update attributes on launch and log progress events as the user moves through content. */
  user: {visitor: {burst: 20, refill: 1 / 10}, ip: {burst: 120, refill: 1}},
  event: {visitor: {burst: 60, refill: 1}, ip: {burst: 300, refill: 5}},
} satisfies Record<string, {visitor: Budget; ip: Budget}>;

export type MessengerAction = keyof typeof BUDGETS;

/* Every supertest request comes from one loopback address, so the suite would trip the IP budgets.
Off under test except in the test that switches it on to exercise them. */
export const messengerRateLimits = {enabled: process.env.NODE_ENV !== 'test'};

function visitorOf(req: Request, res: Response): string | null {
  const session = res.locals.messenger as {projectId: string; visitorId: string} | undefined;
  if (session) {
    return `${session.projectId}:${session.visitorId}`;
  }
  const bodyVisitor = (req.body as {visitorId?: unknown} | undefined)?.visitorId;
  return typeof bodyVisitor === 'string' && VISITOR_ID_PATTERN.test(bodyVisitor) ? bodyVisitor : null;
}

/**
 * Limits a messenger action per visitor and per IP. Mount it after the session middleware so the
 * visitor is known. Like the API limiter, it lets requests through when Redis is unreachable.
 */
export function messengerRateLimit(action: MessengerAction) {
  const budget = BUDGETS[action];
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!messengerRateLimits.enabled) {
      return next();
    }
    const checks: [string, Budget][] = [[Keys.RateLimit.messenger(action, 'ip', clientIp(req) ?? 'unknown'), budget.ip]];
    const visitor = visitorOf(req, res);
    if (visitor) {
      checks.push([Keys.RateLimit.messenger(action, 'visitor', visitor), budget.visitor]);
    }

    try {
      for (const [key, {burst, refill}] of checks) {
        const result = await takeToken(key, burst, refill);
        if (!result.allowed) {
          res.set('Retry-After', String(result.retryAfterSeconds));
          return next(new RateLimitError('Too many requests. Please wait a moment and try again.', result.retryAfterSeconds));
        }
      }
    } catch (error) {
      signale.warn(`[RATE-LIMIT] Messenger check failed for "${action}", allowing request:`, error);
    }
    return next();
  };
}
