import { Request, Response, NextFunction } from 'express';
import { UnauthorizedError } from '../utils/appError.js';
import { verifyAccessToken } from '../utils/token.js';
import { prisma } from '../lib/prisma.js';
import { COOKIE_NAMES } from '../utils/cookies.js';

export interface AuthUser {
  id: string;
  email: string;
  role: 'CUSTOMER' | 'STAFF' | 'ADMIN';
  firstName: string | null;
  lastName: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }

  const cookieToken = req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];
  if (cookieToken) {
    return cookieToken;
  }

  return null;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    return next(new UnauthorizedError('Authentication token is required'));
  }

  try {
    const payload = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        role: true,
        firstName: true,
        lastName: true,
        isActive: true
      }
    });

    if (!user || !user.isActive) {
      return next(new UnauthorizedError('Account is inactive or does not exist'));
    }

    req.user = user;
    next();
  } catch {
    next(new UnauthorizedError('Invalid or expired authentication token'));
  }
}
