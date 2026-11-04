import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { sendSuccess, sendError } from '../utils/response.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  try {
    // Ping database to verify connection health
    await prisma.$queryRaw`SELECT 1`;

    sendSuccess(res, 200, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      uptimeSeconds: process.uptime()
    });
  } catch (err: any) {
    sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Database connection unavailable');
  }
});
