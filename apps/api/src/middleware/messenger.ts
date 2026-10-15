import type {NextFunction, Request, Response} from 'express';

import {ErrorCode, HttpException} from '../exceptions/index.js';
import {type MessengerSession, MessengerSessionService} from '../services/MessengerSessionService.js';
import {MessengerSettingsService} from '../services/MessengerSettingsService.js';
import {ProjectService} from '../services/ProjectService.js';

export function messengerSession(res: Response): MessengerSession {
  return res.locals.messenger as MessengerSession;
}

/**
 * Authenticates a messenger request by its session token. The project and messenger state are
 * re-checked on every request, so disabling either cuts off sessions that are still unexpired.
 */
export const requireMessengerSession = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new HttpException(401, 'A messenger session token is required', ErrorCode.MISSING_AUTH);
    }

    const session = MessengerSessionService.verify(token);
    const [project, settings] = await Promise.all([
      ProjectService.id(session.projectId),
      MessengerSettingsService.get(session.projectId),
    ]);

    if (!project || project.disabled) {
      throw new HttpException(403, 'This project has been disabled', ErrorCode.PROJECT_DISABLED);
    }
    if (!settings.enabled) {
      throw new HttpException(403, 'The messenger is not enabled for this project', ErrorCode.FORBIDDEN);
    }

    res.locals.messenger = session;
    next();
  } catch (error) {
    next(error);
  }
};
