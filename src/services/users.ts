import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { NotFoundError, ForbiddenError } from '../utils/appError.js';
import { sendSuccess } from '../utils/response.js';
import { authenticate } from '../middlewares/auth.js';

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(50).optional(),
  lastName: z.string().min(1).max(50).optional(),
  phone: z.string().optional()
});

export class UserService {
  static async getProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        createdAt: true,
        addresses: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    return user;
  }

  static async updateProfile(userId: string, data: z.infer<typeof updateProfileSchema>) {
    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        updatedAt: true
      }
    });

    return user;
  }
}

export const usersRouter = Router();

usersRouter.use(authenticate);

usersRouter.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profile = await UserService.getProfile(req.user!.id);
    sendSuccess(res, 200, profile);
  } catch (err) {
    next(err);
  }
});

usersRouter.put('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateProfileSchema.parse(req.body);
    const updated = await UserService.updateProfile(req.user!.id, data);
    sendSuccess(res, 200, updated);
  } catch (err) {
    next(err);
  }
});

usersRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestingUserId = req.user!.id;
    const requestingUserRole = req.user!.role;
    const targetUserId = req.params.id as string;

    // Customers can only access their own profile.
    // ADMIN/STAFF can access any profile (existing RBAC policy).
    if (requestingUserRole !== 'ADMIN' && requestingUserRole !== 'STAFF') {
      if (requestingUserId !== targetUserId) {
        throw new ForbiddenError('You can only access your own profile');
      }
    }

    const profile = await UserService.getProfile(targetUserId);
    sendSuccess(res, 200, profile);
  } catch (err) {
    next(err);
  }
});
