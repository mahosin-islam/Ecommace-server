import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../utils/appError.js';
import { sendSuccess } from '../utils/response.js';

export class CategoryService {
  static async getCategories() {
    const categories = await prisma.category.findMany({
      where: {
        parentId: null,
        isActive: true
      },
      orderBy: { sortOrder: 'asc' },
      include: {
        children: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          include: {
            children: {
              where: { isActive: true },
              orderBy: { sortOrder: 'asc' }
            }
          }
        }
      }
    });

    return categories;
  }

  static async getCategoryBySlug(slug: string) {
    const category = await prisma.category.findUnique({
      where: { slug },
      include: {
        parent: {
          select: { id: true, name: true, slug: true }
        },
        children: {
          where: { isActive: true },
          select: { id: true, name: true, slug: true, imageUrl: true }
        }
      }
    });

    if (!category || !category.isActive) {
      throw new NotFoundError('Category not found');
    }

    return category;
  }
}

export const categoryRouter = Router();

categoryRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const categories = await CategoryService.getCategories();
    sendSuccess(res, 200, categories);
  } catch (err) {
    next(err);
  }
});

categoryRouter.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = req.params.slug as string;
    const category = await CategoryService.getCategoryBySlug(slug);
    sendSuccess(res, 200, category);
  } catch (err) {
    next(err);
  }
});
