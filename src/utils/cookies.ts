import { env } from '../config/env.js';

const isProduction = env.NODE_ENV === 'production';

export const COOKIE_NAMES = {
  ACCESS_TOKEN: 'modora_access_token',
  REFRESH_TOKEN: 'modora_refresh_token',
} as const;

export const COOKIE_PATHS = {
  ACCESS_TOKEN: '/',
  REFRESH_TOKEN: '/api/v1/auth',
} as const;

export function getAccessTokenMaxAge(): number {
  return parseInt(env.JWT_EXPIRES_IN, 10) * 60 * 1000;
}

export function getRefreshTokenMaxAge(): number {
  return parseInt(env.JWT_REFRESH_EXPIRES_IN, 10) * 24 * 60 * 60 * 1000;
}

export function getCookieOptions(maxAge: number, path: string): Record<string, unknown> {
  const sameSite = env.COOKIE_SAME_SITE ?? (isProduction ? 'none' : 'lax');

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite,
    path,
    maxAge,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function setAuthCookies(
  res: { cookie: (name: string, value: string, options: Record<string, unknown>) => void },
  accessToken: string,
  refreshToken: string
): void {
  res.cookie(COOKIE_NAMES.ACCESS_TOKEN, accessToken, {
    ...getCookieOptions(getAccessTokenMaxAge(), COOKIE_PATHS.ACCESS_TOKEN),
  });

  res.cookie(COOKIE_NAMES.REFRESH_TOKEN, refreshToken, {
    ...getCookieOptions(getRefreshTokenMaxAge(), COOKIE_PATHS.REFRESH_TOKEN),
  });
}

export function clearAuthCookies(
  res: { clearCookie: (name: string, options?: Record<string, unknown>) => void }
): void {
  res.clearCookie(COOKIE_NAMES.ACCESS_TOKEN, {
    path: COOKIE_PATHS.ACCESS_TOKEN,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });

  res.clearCookie(COOKIE_NAMES.REFRESH_TOKEN, {
    path: COOKIE_PATHS.REFRESH_TOKEN,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });
}
