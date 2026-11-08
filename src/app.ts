import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { router } from './routers/router.js';
import { errorHandler } from './middlewares/error.js';
import { NotFoundError } from './utils/appError.js';

export function createApp(): Express {
  const app = express();

  // Trust proxy for Render load balancer: client IP detection and IP-based rate limiting
  app.set('trust proxy', 1);

  // Security headers
  app.use(helmet());

  // Cookie parsing for OAuth state and sessions
  app.use(cookieParser());

  // CSRF protection is handled at route level via authentication (JWT HttpOnly cookies).
  // Routes are protected by authenticate + requireRole middleware, which prevents
  // unauthorized access without needing a separate CSRF token layer.
      // CORS configuration
      const allowedOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim());
      app.use(
        cors({
          origin: (origin, callback) => {
            // Allow requests with no origin (like mobile apps, curl, postman)
            if (!origin || allowedOrigins.includes(origin)) {
              callback(null, true);
            } else {
              callback(new Error('Blocked by CORS policy'));
            }
          },
          credentials: true,
          allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'x-request-id']
        })
      );

  // Rate Limiting (200 requests per 15 minutes per IP for general API routes)
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests from this IP. Please try again after 15 minutes.'
      }
    }
  });

  // Stricter rate limits for sensitive authentication endpoints
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many login attempts. Please try again after 15 minutes.'
      }
    }
  });

  const registerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many registration attempts. Please try again after 15 minutes.'
      }
    }
  });

  const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many token refresh attempts. Please try again after 15 minutes.'
      }
    }
  });

  // Apply auth-specific limiters before the general limiter
  app.use('/api/v1/auth/login', loginLimiter);
  app.use('/api/v1/auth/register', registerLimiter);
  app.use('/api/v1/auth/refresh', refreshLimiter);

  app.use('/api', limiter);

  // Stripe webhook needs raw body BEFORE express.json()
  app.use('/api/v1/payments/webhook/stripe', express.raw({ type: 'application/json' }));

  // Request Parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // HTTP Request Logging
  if (env.NODE_ENV !== 'test') {
    app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  }

  // API Version 1 Central Router — routes protected by authenticate + requireRole middleware
  app.use('/api/v1', router);

  // Catch-all 404 for undefined routes
  app.use((req: Request, _res: Response, next: NextFunction) => {
    next(new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`));
  });

  // Centralized Error Handler
  app.use(errorHandler);

  return app;
}

// Shared Express application instance — used by both local server (server.ts)
// and Vercel Serverless Function (default export). One instance, no duplication.
const app = createApp();

export default app;
