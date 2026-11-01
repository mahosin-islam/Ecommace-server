import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../utils/appError.js';
import { sendSuccess } from '../utils/response.js';

export const productQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(12),
  search: z.string().optional(),
  category: z.string().optional(),
  brand: z.string().optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().positive().optional(),
  sortBy: z.enum(['createdAt', 'basePrice', 'title']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  featured: z
    .string()
    .transform((val) => val === 'true')
    .optional()
});

export const createProductSchema = z.object({
  title: z.string().min(2, 'Title must be at least 2 characters'),
  slug: z.string().min(2),
  description: z.string().min(10, 'Description must be at least 10 characters'),
  shortDescription: z.string().optional(),
  sku: z.string().min(2),
  barcode: z.string().optional(),
  basePrice: z.number().positive(),
  comparePrice: z.number().positive().optional(),
  costPrice: z.number().positive().optional(),
  stock: z.number().int().nonnegative().default(0),
  lowStockThreshold: z.number().int().nonnegative().default(5),
  hasVariants: z.boolean().default(false),
  isFeatured: z.boolean().default(false),
  categoryId: z.string().uuid(),
  brandId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
  images: z
    .array(
      z.object({
        url: z.string().url(),
        altText: z.string().optional(),
        sortOrder: z.number().int().default(0),
        isThumbnail: z.boolean().default(false)
      })
    )
    .optional(),
  variants: z
    .array(
      z.object({
        title: z.string().min(1),
        sku: z.string().min(1),
        price: z.number().positive(),
        comparePrice: z.number().positive().optional(),
        stock: z.number().int().nonnegative().default(0),
        attributes: z.record(z.unknown())
      })
    )
    .optional()
});

export interface ProductQueryFilters {
  page: number;
  limit: number;
  search?: string;
  category?: string;
  brand?: string;
  minPrice?: number;
  maxPrice?: number;
  sortBy: 'createdAt' | 'basePrice' | 'title';
  sortOrder: 'asc' | 'desc';
  featured?: boolean;
}

export class ProductService {
  static async getProducts(filters: ProductQueryFilters) {
    const {
      page,
      limit,
      search,
      category,
      brand,
      minPrice,
      maxPrice,
      sortBy,
      sortOrder,
      featured
    } = filters;

    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = {
      isActive: true,
      isArchived: false,
      ...(featured !== undefined ? { isFeatured: featured } : {}),
      ...(category
        ? {
            category: {
              slug: category
            }
          }
        : {}),
      ...(brand
        ? {
            brand: {
              slug: brand
            }
          }
        : {}),
      ...(minPrice !== undefined || maxPrice !== undefined
        ? {
            basePrice: {
              ...(minPrice !== undefined ? { gte: minPrice } : {}),
              ...(maxPrice !== undefined ? { lte: maxPrice } : {})
            }
          }
        : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } }
            ]
          }
        : {})
    };

    const [total, products] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          category: {
            select: { id: true, name: true, slug: true }
          },
          brand: {
            select: { id: true, name: true, slug: true }
          },
          images: {
            orderBy: { sortOrder: 'asc' },
            take: 2,
            select: { id: true, url: true, altText: true, isThumbnail: true }
          },
          variants: {
            where: { isActive: true },
            select: { id: true, title: true, sku: true, price: true, stock: true }
          }
        }
      })
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      products,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      }
    };
  }

  static async getProductBySlug(slug: string) {
    const product = await prisma.product.findUnique({
      where: { slug },
      include: {
        category: {
          select: { id: true, name: true, slug: true }
        },
        brand: {
          select: { id: true, name: true, slug: true, logoUrl: true }
        },
        images: {
          orderBy: { sortOrder: 'asc' }
        },
        variants: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' }
        },
        reviews: {
          where: { isApproved: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            user: {
              select: { firstName: true, lastName: true }
            }
          }
        }
      }
    });

    if (!product || !product.isActive || product.isArchived) {
      throw new NotFoundError('Product not found');
    }

    return product;
  }
}

export const productRouter = Router();

productRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = productQuerySchema.parse(req.query) as unknown as ProductQueryFilters;
    const { products, meta } = await ProductService.getProducts(filters);
    sendSuccess(res, 200, products, meta);
  } catch (err) {
    next(err);
  }
});

productRouter.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = req.params.slug as string;
    const product = await ProductService.getProductBySlug(slug);
    sendSuccess(res, 200, product);
  } catch (err) {
    next(err);
  }
});
