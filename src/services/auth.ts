import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken, verifyAccessToken } from '../utils/token.js';
import { ConflictError, UnauthorizedError, NotFoundError } from '../utils/appError.js';
import { sendSuccess } from '../utils/response.js';
import { authenticate } from '../middlewares/auth.js';
import { GoogleAuthService } from './googleAuth.js';
import { env } from '../config/env.js';
import {
  COOKIE_NAMES,
  COOKIE_PATHS,
  setAuthCookies,
  clearAuthCookies,
  getCookieOptions,
  getAccessTokenMaxAge,
  getRefreshTokenMaxAge
} from '../utils/cookies.js';
import { CSRF_COOKIE_NAME, generateCsrfToken } from '../middlewares/csrf.js';

export const registerSchema = z.object({
  email: z.string().email('Please provide a valid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100, 'Password cannot exceed 100 characters'),
  firstName: z.string().max(50).optional(),
  lastName: z.string().max(50).optional(),
  phone: z.string().optional()
});

export const loginSchema = z.object({
  email: z.string().email('Please provide a valid email address'),
  password: z.string().min(1, 'Password is required')
});

export const googleOneTapSchema = z.object({
  credential: z.string().min(1, 'Google credential token is required')
});

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  static async register(data: z.infer<typeof registerSchema>, res: Response) {
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email.toLowerCase() }
    });

    if (existingUser) {
      throw new ConflictError('An account with this email address already exists');
    }

    const passwordHash = await hashPassword(data.password);

    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: data.email.toLowerCase(),
          passwordHash,
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
          role: 'CUSTOMER'
        }
      });

      await tx.cart.create({
        data: { userId: newUser.id }
      });

      await tx.wishlist.create({
        data: { userId: newUser.id }
      });

      return newUser;
    });

    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role as 'CUSTOMER' | 'STAFF' | 'ADMIN'
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId: crypto.randomBytes(16).toString('hex'),
        expiresAt
      }
    });

    setAuthCookies(res, accessToken, refreshToken);

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        phone: user.phone
      }
    };
  }

  static async login(data: z.infer<typeof loginSchema>, res: Response) {
    const user = await prisma.user.findUnique({
      where: { email: data.email.toLowerCase() }
    });

    if (!user || !user.isActive || !user.passwordHash) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const isMatch = await comparePassword(data.password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedError('Invalid email or password');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role as 'CUSTOMER' | 'STAFF' | 'ADMIN'
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId: crypto.randomBytes(16).toString('hex'),
        expiresAt
      }
    });

    setAuthCookies(res, accessToken, refreshToken);

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        phone: user.phone
      }
    };
  }

  static async refresh(req: Request, res: Response) {
    const rawRefreshToken = req.cookies?.[COOKIE_NAMES.REFRESH_TOKEN] as string | undefined;

    if (!rawRefreshToken) {
      throw new UnauthorizedError('Refresh token cookie is required');
    }

    try {
      const payload = verifyRefreshToken(rawRefreshToken);
      const tokenHash = hashToken(rawRefreshToken);

      const storedToken = await prisma.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: true }
      });

      if (!storedToken || storedToken.isRevoked || storedToken.expiresAt < new Date()) {
        throw new UnauthorizedError('Invalid or expired refresh token');
      }

      if (!storedToken.user.isActive) {
        throw new UnauthorizedError('Account is inactive');
      }

      const familyId = storedToken.familyId ?? storedToken.id;

      // Revoke the entire family on reuse detection (refresh token rotation)
      await prisma.refreshToken.updateMany({
        where: { familyId },
        data: { isRevoked: true, revokedAt: new Date() }
      });

      const newRefreshToken = generateRefreshToken({
        userId: storedToken.user.id,
        email: storedToken.user.email,
        role: storedToken.user.role as 'CUSTOMER' | 'STAFF' | 'ADMIN'
      });

      const newAccessToken = generateAccessToken({
        userId: storedToken.user.id,
        email: storedToken.user.email,
        role: storedToken.user.role as 'CUSTOMER' | 'STAFF' | 'ADMIN'
      });

      const newExpiresAt = new Date();
      newExpiresAt.setDate(newExpiresAt.getDate() + 7);

      await prisma.refreshToken.create({
        data: {
          userId: storedToken.user.id,
          tokenHash: hashToken(newRefreshToken),
          familyId,
          replacedByTokenHash: tokenHash,
          expiresAt: newExpiresAt
        }
      });

      setAuthCookies(res, newAccessToken, newRefreshToken);

      return { accessToken: newAccessToken };
    } catch {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }
  }

  static async logout(req: Request, res: Response) {
    const rawRefreshToken = req.cookies?.[COOKIE_NAMES.REFRESH_TOKEN] as string | undefined;

    if (rawRefreshToken) {
      const tokenHash = hashToken(rawRefreshToken);
      const storedToken = await prisma.refreshToken.findUnique({
        where: { tokenHash }
      });

      if (storedToken) {
        const familyId = storedToken.familyId ?? storedToken.id;
        await prisma.refreshToken.updateMany({
          where: { familyId },
          data: { isRevoked: true, revokedAt: new Date() }
        });
      }
    }

    clearAuthCookies(res);
    return { message: 'Logged out successfully' };
  }

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
}

export const authRouter = Router();

authRouter.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = registerSchema.parse(req.body);
    const result = await AuthService.register(data, res);
    sendSuccess(res, 201, result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = loginSchema.parse(req.body);
    const result = await AuthService.login(data, res);
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await AuthService.refresh(req, res);
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await AuthService.logout(req, res);
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profile = await AuthService.getProfile(req.user!.id);
    sendSuccess(res, 200, profile);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/auth/google
 * Initiates the Google OAuth 2.0 Authorization Code Flow.
 */
authRouter.get('/google', (req: Request, res: Response, next: NextFunction) => {
  try {
    const redirectTo = typeof req.query.redirect_to === 'string' ? req.query.redirect_to : undefined;
    const { authUrl, nonce } = GoogleAuthService.getAuthorizationUrl(redirectTo);

    res.cookie('oauth_state', nonce, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000
    });

    res.redirect(authUrl);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/auth/google/callback
 * Handles the Google OAuth 2.0 redirect callback.
 * Sets HTTP-only session cookies and redirects to frontend without tokens in URL.
 */
authRouter.get('/google/callback', async (req: Request, res: Response, _next: NextFunction) => {
  const frontendUrl = env.FRONTEND_URL;
  const error = req.query.error as string | undefined;

  if (error) {
    const errorCode = error === 'access_denied' ? 'cancelled' : error;
    return res.redirect(`${frontendUrl}/auth/callback?error=${encodeURIComponent(errorCode)}`);
  }

  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const cookieNonce = req.cookies?.oauth_state as string | undefined;

  res.clearCookie('oauth_state');

  if (!code || !state) {
    return res.redirect(`${frontendUrl}/auth/callback?error=invalid_request&message=Missing+code+or+state`);
  }

  try {
    const result = await GoogleAuthService.handleCallback(code, state, cookieNonce);

    const tokenPayload = {
      userId: result.user.id,
      email: result.user.email,
      role: result.user.role
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await prisma.refreshToken.create({
      data: {
        userId: result.user.id,
        tokenHash: hashToken(refreshToken),
        familyId: crypto.randomBytes(16).toString('hex'),
        expiresAt
      }
    });

    setAuthCookies(res, accessToken, refreshToken);

    const redirectTarget = result.redirectTo ? `&redirect_to=${encodeURIComponent(result.redirectTo)}` : '';

    return res.redirect(`${frontendUrl}/auth/callback${redirectTarget}`);
  } catch (err: any) {
    const errorCode = err?.errorCode || (err?.statusCode === 409 ? 'GOOGLE_ACCOUNT_LINK_REQUIRED' : 'auth_failed');
    const message = err?.message || 'Google authentication failed';

    return res.redirect(
      `${frontendUrl}/auth/callback?error=${encodeURIComponent(errorCode)}&message=${encodeURIComponent(message)}`
    );
  }
});

/**
 * GET /api/v1/auth/google/config
 * Exposes the public Google Client ID to client applications.
 */
authRouter.get('/google/config', (_req: Request, res: Response) => {
  sendSuccess(res, 200, {
    clientId: env.GOOGLE_CLIENT_ID || null
  });
});

/**
 * POST /api/v1/auth/google/one-tap
 * Handles Google One Tap credential verification.
 * Sets HTTP-only session cookies instead of returning tokens in JSON body.
 */
authRouter.post('/google/one-tap', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { credential } = googleOneTapSchema.parse(req.body);
    const result = await GoogleAuthService.verifyAndAuthenticateIdToken(credential);

    const tokenPayload = {
      userId: result.user.id,
      email: result.user.email,
      role: result.user.role
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await prisma.refreshToken.create({
      data: {
        userId: result.user.id,
        tokenHash: hashToken(refreshToken),
        familyId: crypto.randomBytes(16).toString('hex'),
        expiresAt
      }
    });

    setAuthCookies(res, accessToken, refreshToken);

    sendSuccess(res, 200, {
      user: result.user
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/auth/csrf-token
 * Issues or returns a CSRF token with proper cross-domain cookie attributes,
 * and also returns the token in the response payload for frontend fetch clients.
 */
authRouter.get('/csrf-token', (req: Request, res: Response) => {
  let token = req.cookies?.[CSRF_COOKIE_NAME];
  if (!token) {
    token = generateCsrfToken();
    const isProduction = env.NODE_ENV === 'production';
    const sameSite = env.COOKIE_SAME_SITE ?? (isProduction ? 'none' : 'lax');
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false,
      secure: isProduction,
      sameSite,
      path: '/',
      maxAge: 24 * 60 * 60 * 1000,
      ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    });
  }
  sendSuccess(res, 200, { csrfToken: token });
});
