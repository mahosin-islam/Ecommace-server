import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authenticate } from '../../middlewares/auth.js';
import { requireRole } from '../../middlewares/role.js';
import { prisma } from '../../lib/prisma.js';
import { sendSuccess } from '../../utils/response.js';
import { AppError, BadRequestError } from '../../utils/appError.js';

// ── Validation Schemas ───────────────────────────────────────────────────────

const listBannersSchema = z.object({
  search: z.string().trim().optional(),
  status: z.enum(['all', 'active', 'scheduled', 'expired', 'inactive']).default('all'),
});

const createBannerSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(500).optional(),
  imageUrl: z.string().url({ message: 'imageUrl must be a valid URL' }),
  linkUrl: z.string().url().optional().or(z.literal('')),
  badgeText: z.string().max(50).optional(),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  startDate: z.string().datetime().nullable().optional(),
  endDate: z.string().datetime().nullable().optional(),
});

const updateBannerSchema = createBannerSchema.partial();

const statusSchema = z.object({
  isActive: z.boolean(),
});

const reorderSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        sortOrder: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

type BannerStatus = 'active' | 'scheduled' | 'expired' | 'inactive';

function bannerStatus(banner: {
  isActive: boolean;
  startDate: Date | null;
  endDate: Date | null;
}): BannerStatus {
  const now = new Date();
  if (!banner.isActive) return 'inactive';
  if (banner.endDate && banner.endDate < now) return 'expired';
  if (banner.startDate && banner.startDate > now) return 'scheduled';
  return 'active';
}

function assertSchedule(startDate: Date | null, endDate: Date | null) {
  if (startDate && endDate && endDate <= startDate) {
    throw new BadRequestError('endDate must be after startDate');
  }
}

// ── Service Class ────────────────────────────────────────────────────────────

export class AdminBannersService {
  async listBanners(query: z.infer<typeof listBannersSchema>) {
    const now = new Date();
    const where: Prisma.BannerWhereInput = {};

    if (query.status === 'inactive') where.isActive = false;
    if (query.status === 'scheduled') {
      where.isActive = true;
      where.startDate = { gt: now };
    }
    if (query.status === 'expired') where.endDate = { lt: now };
    if (query.status === 'active') {
      where.isActive = true;
      where.AND = [
        { OR: [{ startDate: null }, { startDate: { lte: now } }] },
        { OR: [{ endDate: null }, { endDate: { gte: now } }] },
      ];
    }
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { subtitle: { contains: query.search, mode: 'insensitive' } },
        { badgeText: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const banners = await prisma.banner.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });

    return banners.map((banner) => ({ ...banner, status: bannerStatus(banner) }));
  }

  async getBanner(id: string) {
    const banner = await prisma.banner.findUnique({ where: { id } });
    if (!banner) throw new AppError('Banner not found', 404, 'NOT_FOUND');
    return { ...banner, status: bannerStatus(banner) };
  }

  async createBanner(data: z.infer<typeof createBannerSchema>) {
    const startDate = data.startDate ? new Date(data.startDate) : null;
    const endDate = data.endDate ? new Date(data.endDate) : null;
    assertSchedule(startDate, endDate);

    const banner = await prisma.banner.create({
      data: {
        ...data,
        linkUrl: data.linkUrl || null,
        startDate,
        endDate,
      },
    });
    return { ...banner, status: bannerStatus(banner) };
  }

  async updateBanner(id: string, data: z.infer<typeof updateBannerSchema>) {
    const existing = await prisma.banner.findUnique({ where: { id } });
    if (!existing) throw new AppError('Banner not found', 404, 'NOT_FOUND');

    const startDate =
      data.startDate !== undefined
        ? data.startDate
          ? new Date(data.startDate)
          : null
        : existing.startDate;
    const endDate =
      data.endDate !== undefined ? (data.endDate ? new Date(data.endDate) : null) : existing.endDate;
    assertSchedule(startDate, endDate);

    const updated = await prisma.banner.update({
      where: { id },
      data: {
        ...data,
        ...(data.linkUrl !== undefined ? { linkUrl: data.linkUrl || null } : {}),
        ...(data.startDate !== undefined ? { startDate } : {}),
        ...(data.endDate !== undefined ? { endDate } : {}),
      },
    });

    return { ...updated, status: bannerStatus(updated) };
  }

  async updateStatus(id: string, isActive: boolean) {
    const existing = await prisma.banner.findUnique({ where: { id } });
    if (!existing) throw new AppError('Banner not found', 404, 'NOT_FOUND');
    if (existing.isActive === isActive) {
      throw new BadRequestError(`Banner is already ${isActive ? 'active' : 'inactive'}`);
    }

    const updated = await prisma.banner.update({
      where: { id },
      data: { isActive },
    });
    return { ...updated, status: bannerStatus(updated) };
  }

  async reorderBanners(data: z.infer<typeof reorderSchema>) {
    const ids = data.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestError('Duplicate banner ids in reorder payload');
    }

    const existing = await prisma.banner.count({ where: { id: { in: ids } } });
    if (existing !== ids.length) {
      throw new BadRequestError('One or more banners do not exist');
    }

    await prisma.$transaction(
      data.items.map((item) =>
        prisma.banner.update({
          where: { id: item.id },
          data: { sortOrder: item.sortOrder },
        }),
      ),
    );

    return this.listBanners({ status: 'all' });
  }

  async deleteBanner(id: string) {
    const existing = await prisma.banner.findUnique({ where: { id } });
    if (!existing) throw new AppError('Banner not found', 404, 'NOT_FOUND');
    await prisma.banner.delete({ where: { id } });
    return { message: 'Banner deleted successfully' };
  }

  async getPublicBanners() {
    const now = new Date();
    return prisma.banner.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startDate: null }, { startDate: { lte: now } }] },
          { OR: [{ endDate: null }, { endDate: { gte: now } }] },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }
}

// ── Routers ──────────────────────────────────────────────────────────────────

const svc = new AdminBannersService();

export const adminBannersRouter = Router();
const adminGuard = [authenticate, requireRole(['ADMIN', 'STAFF'])];

adminBannersRouter.get('/', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listBannersSchema.parse(req.query);
    const banners = await svc.listBanners(query);
    sendSuccess(res, 200, banners);
  } catch (err) {
    next(err);
  }
});

adminBannersRouter.patch('/reorder', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = reorderSchema.parse(req.body);
    const banners = await svc.reorderBanners(data);
    sendSuccess(res, 200, banners);
  } catch (err) {
    next(err);
  }
});

adminBannersRouter.get('/:id', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const banner = await svc.getBanner(req.params.id!);
    sendSuccess(res, 200, banner);
  } catch (err) {
    next(err);
  }
});

adminBannersRouter.post('/', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createBannerSchema.parse(req.body);
    const banner = await svc.createBanner(data);
    sendSuccess(res, 201, banner);
  } catch (err) {
    next(err);
  }
});

adminBannersRouter.put('/:id', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateBannerSchema.parse(req.body);
    const banner = await svc.updateBanner(req.params.id!, data);
    sendSuccess(res, 200, banner);
  } catch (err) {
    next(err);
  }
});

adminBannersRouter.patch('/:id/status', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { isActive } = statusSchema.parse(req.body);
    const banner = await svc.updateStatus(req.params.id!, isActive);
    sendSuccess(res, 200, banner);
  } catch (err) {
    next(err);
  }
});

adminBannersRouter.delete('/:id', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.deleteBanner(req.params.id!);
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});

export const publicBannersRouter = Router();

publicBannersRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const banners = await svc.getPublicBanners();
    sendSuccess(res, 200, banners);
  } catch (err) {
    next(err);
  }
});
