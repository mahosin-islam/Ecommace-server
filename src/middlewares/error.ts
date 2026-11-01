import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/appError.js';
import { sendError } from '../utils/response.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): Response {
  if (err instanceof ZodError) {
    const formattedErrors = err.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message
    }));
    return sendError(res, 400, 'VALIDATION_ERROR', 'Validation failed', formattedErrors);
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(`AppError [${err.errorCode}]: ${err.message}`, {
        path: req.path,
        method: req.method,
        details: err.details
      });
    }

    return sendError(res, err.statusCode, err.errorCode, err.message, err.details);
  }

  // Handle Prisma Known Request Errors
  if ('code' in err && typeof err.code === 'string') {
    if (err.code === 'P2002') {
      const target = (err as any).meta?.target;
      return sendError(
        res,
        409,
        'CONFLICT',
        `A record with this ${Array.isArray(target) ? target.join(', ') : 'field'} already exists.`
      );
    }
    if (err.code === 'P2025') {
      return sendError(res, 404, 'NOT_FOUND', 'Record not found.');
    }
  }

  // Unhandled / Internal Server Errors
  logger.error(`Unhandled Exception: ${err.message}`, {
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  const message =
    env.NODE_ENV === 'production'
      ? 'An unexpected error occurred. Please try again later.'
      : err.message;

  return sendError(res, 500, 'INTERNAL_SERVER_ERROR', message);
}
