import signale from 'signale';

import {TURNSTILE_ENABLED, TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY} from '../app/constants.js';
import {ErrorCode, HttpException} from '../exceptions/index.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5000;

export class TurnstileService {
  public static siteKey(): string | null {
    return TURNSTILE_ENABLED ? TURNSTILE_SITE_KEY : null;
  }

  /**
   * Refuses the request unless Cloudflare confirms the token. Skipped entirely when Turnstile is
   * not configured. A Cloudflare outage refuses too: failing open would let a bot through exactly
   * when it is easiest to hide.
   */
  public static async assertHuman(token: string | undefined, remoteIp: string | undefined): Promise<void> {
    if (!TURNSTILE_ENABLED) {
      return;
    }
    if (!token) {
      throw new HttpException(403, 'Please confirm you are human and try again', ErrorCode.FORBIDDEN);
    }

    const body = new URLSearchParams({secret: TURNSTILE_SECRET_KEY, response: token});
    if (remoteIp) {
      body.set('remoteip', remoteIp);
    }

    let success = false;
    try {
      const response = await fetch(VERIFY_URL, {method: 'POST', body, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)});
      const result = (await response.json()) as {success?: boolean};
      success = result.success === true;
    } catch (error) {
      signale.warn('[TURNSTILE] Verification request failed:', error);
    }

    if (!success) {
      throw new HttpException(403, 'Please confirm you are human and try again', ErrorCode.FORBIDDEN);
    }
  }
}
