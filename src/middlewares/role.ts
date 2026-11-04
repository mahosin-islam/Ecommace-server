import { Request, Response, NextFunction } from 'express';
import { UnauthorizedError, ForbiddenError } from '../utils/appError.js';

export function requireRole(allowedRoles: ('CUSTOMER' | 'STAFF' | 'ADMIN')[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(new ForbiddenError('You do not have the permission to access this resource'));
    }

    next();
  };
}
