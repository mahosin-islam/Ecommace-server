import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { sendSuccess } from '../../utils/response.js';
import { NotFoundError, BadRequestError } from '../../utils/appError.js';
import { authenticate } from '../../middlewares/auth.js';
import { requireRole } from '../../middlewares/role.js';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const listBrandsSchema = z.object({
  search: z.string().trim().optional(),
  isActive: z.enum(['true', 'false', 'all']).default('all'),
});

const createBrandSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().optional(),
  logoUrl: z.string().url().optional().or(z.literal('')),
  website: z.string().url().optional().or(z.literal('')),
  isActive: z.boolean().default(true),
});

const updateBrandSchema = createBrandSchema.partial();

const statusSchema = z.object({
  isActive: z.boolean(),
});

// ─── Service ─────────────────────────────────────────────────────────────────

export class AdminBrandService {
  static async listBrands(query: z.infer<typeof listBrandsSchema>) {
    const where: Prisma.BrandWhereInput = {};
    if (query.isActive !== 'all') where.isActive = query.isActive === 'true';
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    return prisma.brand.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  }

  static async getBrand(id: string) {
    const brand = await prisma.brand.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    if (!brand) throw new NotFoundError('Brand not found');
    return brand;
  }

  static async createBrand(data: z.infer<typeof createBrandSchema>) {
    const conflict = await prisma.brand.findUnique({ where: { slug: data.slug } });
    if (conflict) throw new BadRequestError('Brand slug already exists');

    return prisma.brand.create({
      data: {
        ...data,
        logoUrl: data.logoUrl || null,
        website: data.website || null,
      },
    });
  }

  static async updateBrand(id: string, data: z.infer<typeof updateBrandSchema>) {
    const existing = await prisma.brand.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Brand not found');

    if (data.slug && data.slug !== existing.slug) {
      const conflict = await prisma.brand.findFirst({ where: { slug: data.slug, id: { not: id } } });
      if (conflict) throw new BadRequestError('Brand slug already exists');
    }

    return prisma.brand.update({
      where: { id },
      data: {
        ...data,
        ...(data.logoUrl !== undefined ? { logoUrl: data.logoUrl || null } : {}),
        ...(data.website !== undefined ? { website: data.website || null } : {}),
      },
    });
  }

  static async updateStatus(id: string, data: z.infer<typeof statusSchema>) {
    const existing = await prisma.brand.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Brand not found');

    return prisma.brand.update({
      where: { id },
      data: { isActive: data.isActive },
    });
  }

  static async deleteBrand(id: string) {
    const existing = await prisma.brand.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    if (!existing) throw new NotFoundError('Brand not found');

    if (existing._count.products > 0) {
      // Preserve product references by deactivating instead of deleting.
      return prisma.brand.update({ where: { id }, data: { isActive: false } });
    }

    return prisma.brand.delete({ where: { id } });
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const adminBrandsRouter = Router();
adminBrandsRouter.use(authenticate, requireRole(['ADMIN', 'STAFF']));

adminBrandsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listBrandsSchema.parse(req.query);
    const brands = await AdminBrandService.listBrands(query);
    sendSuccess(res, 200, brands);
  } catch (err) {
    next(err);
  }
});

adminBrandsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const brand = await AdminBrandService.getBrand(req.params.id!);
    sendSuccess(res, 200, brand);
  } catch (err) {
    next(err);
  }
});

adminBrandsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createBrandSchema.parse(req.body);
    const brand = await AdminBrandService.createBrand(data);
    sendSuccess(res, 201, brand);
  } catch (err) {
    next(err);
  }
});

adminBrandsRouter.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateBrandSchema.parse(req.body);
    const brand = await AdminBrandService.updateBrand(req.params.id!, data);
    sendSuccess(res, 200, brand);
  } catch (err) {
    next(err);
  }
});

adminBrandsRouter.patch('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = statusSchema.parse(req.body);
    const brand = await AdminBrandService.updateStatus(req.params.id!, data);
    sendSuccess(res, 200, brand);
  } catch (err) {
    next(err);
  }
});

adminBrandsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await AdminBrandService.deleteBrand(req.params.id!);
    sendSuccess(res, 200, { message: 'Brand removed successfully' });
  } catch (err) {
    next(err);
  }
});

// ─── Public Brands Router (No Auth Required) ─────────────────────────────────

export const publicBrandsRouter = Router();

publicBrandsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const brands = await prisma.brand.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
    sendSuccess(res, 200, brands);
  } catch (err) {
    next(err);
  }
});

publicBrandsRouter.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = req.params.slug as string;
    const brand = await prisma.brand.findUnique({
      where: { slug },
      include: {
        products: {
          where: { isActive: true, isArchived: false },
          select: {
            id: true,
            title: true,
            slug: true,
            basePrice: true,
            comparePrice: true,
            stock: true,
            images: { take: 1, orderBy: { sortOrder: 'asc' } },
            category: { select: { name: true, slug: true } }
          }
        }
      }
    });
    if (!brand || !brand.isActive) {
      throw new NotFoundError('Brand not found');
    }
    sendSuccess(res, 200, brand);
  } catch (err) {
    next(err);
  }
});
