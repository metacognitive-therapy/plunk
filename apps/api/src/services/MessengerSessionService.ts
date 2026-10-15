import {createHmac} from 'node:crypto';

import jsonwebtoken from 'jsonwebtoken';

import {JWT_SECRET} from '../app/constants.js';
import {ErrorCode, HttpException} from '../exceptions/index.js';

const AUDIENCE = 'plunk-messenger';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

/* A key derived from JWT_SECRET plus a distinct audience means a dashboard session token can never
be accepted as a messenger session, and a messenger token can never be accepted by the dashboard. */
const SIGNING_KEY = createHmac('sha256', JWT_SECRET).update('plunk-messenger-session-v1').digest();

export interface MessengerSession {
  projectId: string;
  visitorId: string;
  contactId: string | null;
  verified: boolean;
}

export interface VerifiedMessengerSession extends MessengerSession {
  expiresAt: Date;
}

interface SessionClaims {
  pid: string;
  vid: string;
  cid: string | null;
  ver: boolean;
}

export class MessengerSessionService {
  public static sign(session: MessengerSession): {token: string; expiresAt: Date} {
    const claims: SessionClaims = {
      pid: session.projectId,
      vid: session.visitorId,
      cid: session.contactId,
      ver: session.verified,
    };
    const token = jsonwebtoken.sign(claims, SIGNING_KEY, {
      audience: AUDIENCE,
      expiresIn: SESSION_TTL_SECONDS,
      algorithm: 'HS256',
    });
    return {token, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000)};
  }

  public static verify(token: string): VerifiedMessengerSession {
    try {
      const claims = jsonwebtoken.verify(token, SIGNING_KEY, {
        audience: AUDIENCE,
        algorithms: ['HS256'],
      }) as SessionClaims & {exp: number};
      if (typeof claims.pid !== 'string' || typeof claims.vid !== 'string') {
        throw new Error('Malformed messenger session');
      }
      return {
        projectId: claims.pid,
        visitorId: claims.vid,
        contactId: typeof claims.cid === 'string' ? claims.cid : null,
        verified: claims.ver === true,
        expiresAt: new Date(claims.exp * 1000),
      };
    } catch {
      throw new HttpException(401, 'Messenger session is invalid or has expired', ErrorCode.MISSING_AUTH);
    }
  }
}
