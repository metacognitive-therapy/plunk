import {randomUUID} from 'node:crypto';

import {Role} from '@plunk/db';
import type {Express} from 'express';
import request from 'supertest';
import {expect} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {API_URI} from '../../app/constants';
import {jwt} from '../../middleware/auth';
import {MessengerSettingsService} from '../../services/MessengerSettingsService';

export const ALLOWED = 'https://www.example.com';
export const API_ORIGIN = new URL(API_URI).origin;

export function visitorId(): string {
  return `v_${randomUUID().replace(/-/g, '')}`;
}

export async function messengerProject(settings: {enabled?: boolean; allowedOrigins?: string[]} = {}) {
  const prisma = getPrismaClient();
  const {user: owner, project} = await factories.createUserWithProject();
  await prisma.membership.update({
    where: {userId_projectId: {userId: owner.id, projectId: project.id}},
    data: {role: Role.OWNER},
  });
  await prisma.user.update({where: {id: owner.id}, data: {emailVerified: true}});
  await MessengerSettingsService.update(project.id, {
    enabled: settings.enabled ?? true,
    allowedOrigins: settings.allowedOrigins ?? [ALLOWED],
  });
  return {owner, project};
}

export function asAgent(userId: string, projectId: string) {
  return {Cookie: `next_token=${jwt.sign(userId)}`, 'X-Project-Id': projectId};
}

/** Visitor-side calls against an app that mounts the Messenger controller. */
export function messengerClient(app: Express) {
  const boot = (publicKey: string, body: {visitorId: string; parentOrigin?: string}, origin?: string) => {
    const req = request(app).post('/v1/messenger/boot').set('Authorization', `Bearer ${publicKey}`);
    if (origin) req.set('Origin', origin);
    return req.send(body);
  };

  const session = async (publicKey: string, visitor = visitorId()) => {
    const res = await boot(publicKey, {visitorId: visitor, parentOrigin: ALLOWED}, API_ORIGIN);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return {token: res.body.data.token as string, visitor};
  };

  const startConversation = async (token: string, body = 'Hello, I need help') => {
    const res = await request(app)
      .post('/v1/messenger/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({body});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data as {token: string; conversation: {id: string; messages: {body: string}[]}};
  };

  return {boot, session, startConversation};
}
