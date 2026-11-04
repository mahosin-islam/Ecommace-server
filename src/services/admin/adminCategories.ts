import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { sendSuccess } from '../../utils/response.js';
import { NotFoundError, BadRequestError } from '../../utils/appError.js';
import { authenticate } from '../../middlewares/auth.js';
import { requireRole } from '../../middlewares/role.js';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const listCategoriesSchema = z.object({
  search: z.string().trim().optional(),
  isActive: z.enum(['true', 'false', 'all']).default('all'),
  parentId: z.string().uuid().optional(),
});

const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().optional(),
  imageUrl: z.string().url().optional().or(z.literal('')),
  parentId: z.string().uuid().optional(),
  sortOrder: z.number().int().nonnegative().default(0),
  isActive: z.boolean().default(true),
});

const updateCategorySchema = createCategorySchema.partial();

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

// ─── Service ─────────────────────────────────────────────────────────────────

export class AdminCategoryService {
  static async listCategories(query: z.infer<typeof listCategoriesSchema>) {
    const where: Record<string, unknown> = {};
    if (query.isActive !== 'all') where['isActive'] = query.isActive === 'true';
    if (query.parentId) where['parentId'] = query.parentId;
    if (query.search) {
      where['OR'] = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    return prisma.category.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        parent: { select: { id: true, name: true } },
        _count: { select: { products: true, children: true } },
      },
    });
  }

  static async getCategory(id: string) {
    const category = await prisma.category.findUnique({
      where: { id },
      include: {
        parent: { select: { id: true, name: true, slug: true } },
        children: {
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
            _count: { select: { products: true } },
          },
          orderBy: { sortOrder: 'asc' },
        },
        _count: { select: { products: true } },
      },
    });
    if (!category) throw new NotFoundError('Category not found');
    return category;
  }

  static async createCategory(data: z.infer<typeof createCategorySchema>) {
    const slugConflict = await prisma.category.findUnique({ where: { slug: data.slug } });
    if (slugConflict) throw new BadRequestError('Category slug already exists');

    if (data.parentId) {
      const parent = await prisma.category.findUnique({ where: { id: data.parentId } });
      if (!parent) throw new BadRequestError('Parent category not found');
    }

    return prisma.category.create({
      data: { ...data, imageUrl: data.imageUrl || null },
    });
  }

  static async updateCategory(id: string, data: z.infer<typeof updateCategorySchema>) {
    const existing = await prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Category not found');

    if (data.slug && data.slug !== existing.slug) {
      const conflict = await prisma.category.findFirst({
        where: { slug: data.slug, id: { not: id } },
      });
      if (conflict) throw new BadRequestError('Category slug already exists');
    }

    if (data.parentId !== undefined && data.parentId !== null) {
      await this.assertValidParent(id, data.parentId);
    }

    return prisma.category.update({
      where: { id },
      data: {
        ...data,
        ...(data.imageUrl !== undefined ? { imageUrl: data.imageUrl || null } : {}),
      },
    });
  }

  static async updateStatus(id: string, data: z.infer<typeof statusSchema>) {
    const existing = await prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Category not found');

    return prisma.category.update({
      where: { id },
      data: { isActive: data.isActive },
    });
  }

  static async reorderCategories(data: z.infer<typeof reorderSchema>) {
    const ids = data.items.map((item) => item.id);
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
      throw new BadRequestError('Duplicate category ids in reorder payload');
    }

    const existing = await prisma.category.count({ where: { id: { in: ids } } });
    if (existing !== ids.length) {
      throw new BadRequestError('One or more categories do not exist');
    }

    await prisma.$transaction(
      data.items.map((item) =>
        prisma.category.update({
          where: { id: item.id },
          data: { sortOrder: item.sortOrder },
        }),
      ),
    );

    return this.listCategories({ isActive: 'all' });
  }

  static async deleteCategory(id: string) {
    const existing = await prisma.category.findUnique({
      where: { id },
      include: { _count: { select: { products: true, children: true } } },
    });
    if (!existing) throw new NotFoundError('Category not found');

    if (existing._count.products > 0) {
      throw new BadRequestError(
        `Cannot delete: ${existing._count.products} product(s) are assigned to this category`,
      );
    }
    if (existing._count.children > 0) {
      throw new BadRequestError(
        `Cannot delete: ${existing._count.children} sub-categor(ies) exist under this category`,
      );
    }

    return prisma.category.delete({ where: { id } });
  }

  private static async assertValidParent(id: string, parentId: string) {
    if (parentId === id) {
      throw new BadRequestError('A category cannot be its own parent');
    }

    const parent = await prisma.category.findUnique({ where: { id: parentId } });
    if (!parent) throw new BadRequestError('Parent category not found');

    let cursor: string | null = parent.parentId;
    const visited = new Set<string>();

    while (cursor) {
      if (cursor === id) {
        throw new BadRequestError('Cannot assign a descendant as the parent category');
      }
      if (visited.has(cursor)) break;
      visited.add(cursor);

      const ancestor = await prisma.category.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = ancestor?.parentId ?? null;
    }
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const adminCategoriesRouter = Router();
adminCategoriesRouter.use(authenticate, requireRole(['ADMIN', 'STAFF']));

adminCategoriesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listCategoriesSchema.parse(req.query);
    const categories = await AdminCategoryService.listCategories(query);
    sendSuccess(res, 200, categories);
  } catch (err) {
    next(err);
  }
});

adminCategoriesRouter.patch('/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = reorderSchema.parse(req.body);
    const categories = await AdminCategoryService.reorderCategories(data);
    sendSuccess(res, 200, categories);
  } catch (err) {
    next(err);
  }
});

adminCategoriesRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const category = await AdminCategoryService.getCategory(req.params.id!);
    sendSuccess(res, 200, category);
  } catch (err) {
    next(err);
  }
});

adminCategoriesRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createCategorySchema.parse(req.body);
    const category = await AdminCategoryService.createCategory(data);
    sendSuccess(res, 201, category);
  } catch (err) {
    next(err);
  }
});

adminCategoriesRouter.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateCategorySchema.parse(req.body);
    const category = await AdminCategoryService.updateCategory(req.params.id!, data);
    sendSuccess(res, 200, category);
  } catch (err) {
    next(err);
  }
});

adminCategoriesRouter.patch('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = statusSchema.parse(req.body);
    const category = await AdminCategoryService.updateStatus(req.params.id!, data);
    sendSuccess(res, 200, category);
  } catch (err) {
    next(err);
  }
});

adminCategoriesRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await AdminCategoryService.deleteCategory(req.params.id!);
    sendSuccess(res, 200, { message: 'Category deleted successfully' });
  } catch (err) {
    next(err);
  }
});
