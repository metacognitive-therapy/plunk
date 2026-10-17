import {type Brand, resolveBrand} from '@plunk/shared';

import {Keys} from './keys.js';
import {wrapRedis} from '../database/redis.js';
import {prisma} from '../database/prisma.js';

export class ProjectService {
  public static async id(id: string) {
    return wrapRedis(Keys.Project.id(id), async () => {
      return prisma.project.findUnique({where: {id}});
    });
  }

  // Uncached on purpose: the project PATCH route doesn't invalidate Keys.Project.id, and a stale brand would reach contacts.
  public static async brand(id: string): Promise<Brand> {
    const project = await prisma.project.findUnique({where: {id}, select: {name: true, brandName: true, brandLogoUrl: true}});
    return resolveBrand(project);
  }

  public static async secret(key: string) {
    return wrapRedis(Keys.Project.secret(key), async () => {
      return prisma.project.findUnique({
        where: {
          secret: key,
        },
      });
    });
  }

  public static async public(key: string) {
    return wrapRedis(Keys.Project.public(key), async () => {
      return prisma.project.findUnique({
        where: {
          public: key,
        },
      });
    });
  }
}
