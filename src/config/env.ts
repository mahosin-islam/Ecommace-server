import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const PRODUCTION_JWT_MIN_LENGTH = 32;

const JWT_PLACEHOLDER_VALUES = new Set([
  'dev_secret_key_minimum_16_characters_placeholder',
  'dev_refresh_key_minimum_16_characters_placeholder',
  'ecommerce_dev_access_jwt_secret_key_32chars_long_minimum',
  'ecommerce_dev_refresh_jwt_secret_key_32chars_long_minimum'
]);

const PLACEHOLDER_MARKERS =
  /(placeholder|change[_-]?me|replace[_-]?me|your[_-]|dummy|example|dev[_-]?secret|test[_-]?secret)/i;

function looksLikePlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return JWT_PLACEHOLDER_VALUES.has(normalized) || PLACEHOLDER_MARKERS.test(normalized);
}

function looksLikePlaceholderDatabaseUrl(value: string): boolean {
  return /(your[_-]?password|:postgres@|placeholder|change[_-]?me|replace[_-]?me)/i.test(value);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isHttpUrl(value: string): boolean {
  const url = parseUrl(value);
  return Boolean(url && (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname);
}

function isLocalhost(value: string): boolean {
  const url = parseUrl(value);
  if (!url) return false;

  const hostname = url.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function createDatabaseUrlSchema(variable: 'DATABASE_URL' | 'DIRECT_URL') {
  return z
    .string({ required_error: `${variable} is required` })
    .trim()
    .min(1, `${variable} is required`)
    .superRefine((value, ctx) => {
      const url = parseUrl(value);

      if (!url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${variable} must be a valid PostgreSQL connection URL`
        });
        return;
      }

      if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${variable} must use the postgresql:// or postgres:// scheme`
        });
      }

      if (!url.hostname) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${variable} must include a database host`
        });
      }
    });
}

const databaseUrlSchema = createDatabaseUrlSchema('DATABASE_URL');
const directUrlSchema = createDatabaseUrlSchema('DIRECT_URL');

const corsOriginSchema = z
  .string({ required_error: 'CORS_ORIGIN is required' })
  .trim()
  .min(1, 'CORS_ORIGIN is required')
  .superRefine((value, ctx) => {
    const origins = value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);

    if (origins.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CORS_ORIGIN must contain at least one allowed origin'
      });
      return;
    }

    for (const origin of origins) {
      if (origin === '*') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CORS_ORIGIN cannot contain the wildcard "*" when credentials are enabled'
        });
        continue;
      }

      if (origin.endsWith('/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CORS_ORIGIN entries must not end with a slash'
        });
      }

      const url = parseUrl(origin);

      if (!url || !isHttpUrl(origin)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CORS_ORIGIN entries must be valid http(s) origins'
        });
        continue;
      }

      if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CORS_ORIGIN entries must be origins only, without paths, credentials, queries, or fragments'
        });
      }
    }
  });

const frontendUrlSchema = z
  .string({ required_error: 'FRONTEND_URL is required' })
  .trim()
  .min(1, 'FRONTEND_URL is required')
  .superRefine((value, ctx) => {
    if (!isHttpUrl(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'FRONTEND_URL must be a valid http(s) URL'
      });
      return;
    }

    if (value.endsWith('/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'FRONTEND_URL must not end with a slash'
      });
    }
  });

const googleCallbackUrlSchema = z
  .string({ required_error: 'GOOGLE_CALLBACK_URL is required' })
  .trim()
  .min(1, 'GOOGLE_CALLBACK_URL is required')
  .superRefine((value, ctx) => {
    if (!isHttpUrl(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GOOGLE_CALLBACK_URL must be a valid http(s) URL'
      });
    }
  });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce
      .number()
      .int('PORT must be an integer')
      .min(1, 'PORT must be at least 1')
      .max(65535, 'PORT must be at most 65535')
      .default(5000),
    // DIRECT_URL is only needed for pooled Neon connections, not local PostgreSQL.
    DATABASE_URL: databaseUrlSchema,
    DIRECT_URL: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      directUrlSchema.optional()
    ),
    JWT_SECRET: z
      .string({ required_error: 'JWT_SECRET is required' })
      .trim()
      .min(16, 'JWT_SECRET must be at least 16 characters'),
    JWT_REFRESH_SECRET: z
      .string({ required_error: 'JWT_REFRESH_SECRET is required' })
      .trim()
      .min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
    JWT_EXPIRES_IN: z.string().trim().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().trim().default('7d'),
    CORS_ORIGIN: corsOriginSchema,
    GOOGLE_CLIENT_ID: z.string().trim().optional(),
    GOOGLE_CLIENT_SECRET: z.string().trim().optional(),
    GOOGLE_CALLBACK_URL: googleCallbackUrlSchema.default('http://localhost:4000/api/v1/auth/google/callback'),
    FRONTEND_URL: frontendUrlSchema.default('http://localhost:3000'),
    STRIPE_SECRET_KEY: z.string().trim().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().trim().optional(),
    COOKIE_DOMAIN: z.string().trim().optional(),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).optional()
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== 'production') {
      return;
    }

    const addIssue = (variable: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [variable], message });

    if (looksLikePlaceholderDatabaseUrl(data.DATABASE_URL)) {
      addIssue('DATABASE_URL', 'DATABASE_URL must not use a placeholder value in production');
    }

    if (data.DIRECT_URL && looksLikePlaceholderDatabaseUrl(data.DIRECT_URL)) {
      addIssue('DIRECT_URL', 'DIRECT_URL must not use a placeholder value in production');
    }

    if (data.DATABASE_URL.includes('-pooler') && !data.DIRECT_URL) {
      addIssue(
        'DIRECT_URL',
        'DIRECT_URL is required in production when DATABASE_URL uses a pooled connection'
      );
    }

    for (const variable of ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      const value = data[variable];

      if (looksLikePlaceholder(value)) {
        addIssue(variable, `${variable} must not use a placeholder value in production`);
      }

      if (value.length < PRODUCTION_JWT_MIN_LENGTH) {
        addIssue(
          variable,
          `${variable} must be at least ${PRODUCTION_JWT_MIN_LENGTH} characters in production`
        );
      }
    }

    if (data.JWT_SECRET === data.JWT_REFRESH_SECRET) {
      addIssue('JWT_REFRESH_SECRET', 'JWT_REFRESH_SECRET must be different from JWT_SECRET');
    }

    const corsOrigins = data.CORS_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);

    for (const origin of corsOrigins) {
      if (isLocalhost(origin)) {
        addIssue('CORS_ORIGIN', 'CORS_ORIGIN must not include localhost origins in production');
      }
    }

    if (isLocalhost(data.FRONTEND_URL)) {
      addIssue('FRONTEND_URL', 'FRONTEND_URL must not point to localhost in production');
    }

    const googleConfigured = Boolean(data.GOOGLE_CLIENT_ID || data.GOOGLE_CLIENT_SECRET);

    if (googleConfigured && (!data.GOOGLE_CLIENT_ID || !data.GOOGLE_CLIENT_SECRET)) {
      if (!data.GOOGLE_CLIENT_ID) {
        addIssue('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID is required when GOOGLE_CLIENT_SECRET is set');
      }
      if (!data.GOOGLE_CLIENT_SECRET) {
        addIssue('GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set');
      }
    }

    if (data.GOOGLE_CLIENT_ID && looksLikePlaceholder(data.GOOGLE_CLIENT_ID)) {
      addIssue('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID must not use a placeholder value in production');
    }

    if (data.GOOGLE_CLIENT_SECRET && looksLikePlaceholder(data.GOOGLE_CLIENT_SECRET)) {
      addIssue(
        'GOOGLE_CLIENT_SECRET',
        'GOOGLE_CLIENT_SECRET must not use a placeholder value in production'
      );
    }

    if (googleConfigured && isLocalhost(data.GOOGLE_CALLBACK_URL)) {
      addIssue(
        'GOOGLE_CALLBACK_URL',
        'GOOGLE_CALLBACK_URL must not point to localhost in production when Google OAuth is configured'
      );
    }

    if (data.STRIPE_SECRET_KEY) {
      if (looksLikePlaceholder(data.STRIPE_SECRET_KEY)) {
        addIssue('STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY must not use a placeholder value in production');
      } else if (!/^(sk|rk)_(test|live)_/.test(data.STRIPE_SECRET_KEY)) {
        addIssue('STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY must be a valid Stripe secret key');
      }
    }

    if (data.STRIPE_WEBHOOK_SECRET) {
      if (looksLikePlaceholder(data.STRIPE_WEBHOOK_SECRET)) {
        addIssue(
          'STRIPE_WEBHOOK_SECRET',
          'STRIPE_WEBHOOK_SECRET must not use a placeholder value in production'
        );
      } else if (!data.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
        addIssue('STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET must start with "whsec_"');
      }

      if (!data.STRIPE_SECRET_KEY) {
        addIssue(
          'STRIPE_SECRET_KEY',
          'STRIPE_SECRET_KEY is required when STRIPE_WEBHOOK_SECRET is set'
        );
      }
    }
  });

type Env = z.infer<typeof envSchema>;

function normalizeNodeEnv(value: string | undefined): Env['NODE_ENV'] {
  return value === 'production' || value === 'test' ? value : 'development';
}

function normalizePort(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 5000;
}

function normalizeCookieSameSite(value: string | undefined): Env['COOKIE_SAME_SITE'] {
  return value === 'lax' || value === 'strict' || value === 'none' ? value : undefined;
}

function buildDevelopmentEnv(): Env {
  return {
    NODE_ENV: normalizeNodeEnv(process.env.NODE_ENV),
    PORT: normalizePort(process.env.PORT),
    DATABASE_URL:
      process.env.DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/ecommarce?schema=public',
    DIRECT_URL: process.env.DIRECT_URL || undefined,
    JWT_SECRET: process.env.JWT_SECRET || 'dev_secret_key_minimum_16_characters_placeholder',
    JWT_REFRESH_SECRET:
      process.env.JWT_REFRESH_SECRET || 'dev_refresh_key_minimum_16_characters_placeholder',
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '15m',
    JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000',
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || undefined,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || undefined,
    GOOGLE_CALLBACK_URL:
      process.env.GOOGLE_CALLBACK_URL || 'http://localhost:4000/api/v1/auth/google/callback',
    FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || undefined,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || undefined,
    COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || undefined,
    COOKIE_SAME_SITE: normalizeCookieSameSite(process.env.COOKIE_SAME_SITE)
  };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const variable = issue.path.length > 0 ? issue.path.join('.') : 'environment';
      return `  - ${variable}: ${issue.message}`;
    })
    .join('\n');
}

function resolveEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (parsed.success) {
    return parsed.data;
  }

  const details = formatIssues(parsed.error);

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `Invalid production environment configuration. Fix the following variables and restart:\n${details}`
    );
  }

  console.warn('⚠️ Invalid or missing environment variables for development:');
  console.warn(details);
  console.warn('⚠️ Falling back to placeholder configuration for local bootstrapping.');

  return buildDevelopmentEnv();
}

export const env = resolveEnv();
