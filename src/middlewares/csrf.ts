import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ForbiddenError } from '../utils/appError.js';
import { env } from '../config/env.js';

const CSRF_COOKIE_NAME = 'modora_csrf_token';
const CSRF_HEADER_NAME = 'x-csrf-token';

// Paths that do not require CSRF validation (stateless auth endpoints).
// These handle their own authentication and are not cookie-session state-changing.
const CSRF_EXEMPT_PATHS = [
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/google',
  '/api/v1/auth/google/callback',
  '/api/v1/auth/google/one-tap',
  '/api/v1/auth/google/config',
  '/api/v1/auth/csrf-token',
];

const isCsrfExemptPath = (path: string): boolean => {
  return CSRF_EXEMPT_PATHS.some((p) => path.startsWith(p));
};

export const generateCsrfToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

export function csrfTokenHandler(_req: Request, res: Response, next: NextFunction): void {
  // Only set the CSRF cookie on GET/HEAD/OPTIONS (safe methods).
  // State-changing requests are validated by csrfProtection middleware.
  if (['GET', 'HEAD', 'OPTIONS'].includes(_req.method)) {
    const isProduction = env.NODE_ENV === 'production';
    const sameSite = env.COOKIE_SAME_SITE ?? (isProduction ? 'none' : 'lax');
    res.cookie(CSRF_COOKIE_NAME, generateCsrfToken(), {
      httpOnly: false, // must be readable by frontend JS to send in header
      secure: isProduction,
      sameSite,
      path: '/',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    });
  }
  next();
}

export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  // Only validate state-changing methods
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    next();
    return;
  }

  // Skip CSRF for exempt paths (auth endpoints)
 const requestPath = req.originalUrl.split('?')[0];

if (isCsrfExemptPath(requestPath)) {
  next();
  return;
}
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME] as string | undefined;

  if (!cookieToken || !headerToken) {
    throw new ForbiddenError('CSRF token is missing');
  }

  if (!crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))) {
    throw new ForbiddenError('CSRF token mismatch');
  }

  next();
}

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME };
