import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { sendSuccess } from '../utils/response.js';

export class SettingService {
  static async getPublicSettings() {
    const settings = await prisma.storeSetting.findMany({
      where: {
        group: {
          in: ['general', 'localization', 'shipping', 'tax', 'features']
        }
      }
    });

    const formatted: Record<string, string | number | boolean> = {};

    for (const s of settings) {
      if (s.type === 'number') {
        formatted[s.key] = parseFloat(s.value);
      } else if (s.type === 'boolean') {
        formatted[s.key] = s.value === 'true';
      } else {
        formatted[s.key] = s.value;
      }
    }

    return formatted;
  }
}

export const settingRouter = Router();

settingRouter.get('/public', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await SettingService.getPublicSettings();
    sendSuccess(res, 200, settings);
  } catch (err) {
    next(err);
  }
});
