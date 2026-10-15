import {Server} from '@overnightjs/core';
import cookies from 'cookie-parser';
import {json, type Router} from 'express';
import helmet from 'helmet';

import {errorHandler} from '../../middleware/errorHandler.js';

/**
 * A minimal HTTP app for supertest. Importing app.ts would start listening and schedule the
 * background jobs, so tests mount only the controllers and routers they exercise.
 */
export function buildHttpApp(options: {controllers?: object[]; routers?: Record<string, Router>} = {}) {
  const server = new (class extends Server {
    public constructor() {
      super();
      this.app.use(json());
      this.app.use(cookies());
      this.app.use(helmet());
      for (const [path, router] of Object.entries(options.routers ?? {})) {
        this.app.use(path, router);
      }
      this.addControllers(options.controllers ?? []);
      this.app.use(errorHandler);
    }
  })();
  return server.app;
}
