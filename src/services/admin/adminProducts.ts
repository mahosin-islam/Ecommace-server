import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { sendSuccess } from '../../utils/response.js';
import { NotFoundError, BadRequestError } from '../../utils/appError.js';
import { authenticate } from '../../middlewares/auth.js';
import { requireRole } from '../../middlewares/role.js';

// ─── Validation Schemas ───────────────────────────────────────────────────────

const listProductsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().optional(),
  categoryId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  status: z
    .enum(['active', 'inactive', 'archived', 'low_stock', 'out_of_stock', 'all'])
    .default('all'),
  sortBy: z.enum(['createdAt', 'basePrice', 'title', 'stock']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const statsSchema = z.object({
  categoryId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  search: z.string().trim().optional(),
});

const bulkStatusSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'At least one product ID is required'),
  isActive: z.boolean(),
});

const exportSchema = z.object({
  search: z.string().trim().optional(),
  categoryId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  status: z
    .enum(['active', 'inactive', 'archived', 'low_stock', 'out_of_stock', 'all'])
    .default('all'),
  sortBy: z.enum(['createdAt', 'basePrice', 'title', 'stock']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const seoSchema = z
  .object({
    title: z.string().max(70).optional(),
    description: z.string().max(160).optional(),
    keywords: z.array(z.string().min(1)).max(20).optional(),
    canonicalUrl: z.string().url().optional(),
  })
  .strict();

const imageSchema = z.object({
  url: z.string().url(),
  altText: z.string().max(255).optional(),
  sortOrder: z.number().int().nonnegative().default(0),
  isThumbnail: z.boolean().default(false),
  variantSku: z.string().min(1).optional(),
});

const variantSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(120),
  sku: z.string().min(2).max(100),
  barcode: z.string().max(100).optional(),
  price: z.number().positive(),
  comparePrice: z.number().positive().optional(),
  costPrice: z.number().positive().optional(),
  stock: z.number().int().nonnegative().default(0),
  lowStockThreshold: z.number().int().nonnegative().default(5),
  attributes: z.record(z.string()),
  sortOrder: z.number().int().nonnegative().default(0),
  isActive: z.boolean().default(true),
});

const baseProductSchema = z.object({
  title: z.string().min(2).max(200),
  slug: z
    .string()
    .min(2)
    .max(200)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().min(10),
  shortDescription: z.string().max(300).optional(),
  sku: z.string().min(2).max(100),
  barcode: z.string().max(100).optional(),
  basePrice: z.number().positive(),
  comparePrice: z.number().positive().optional(),
  costPrice: z.number().positive().optional(),
  stock: z.number().int().nonnegative().default(0),
  lowStockThreshold: z.number().int().nonnegative().default(5),
  hasVariants: z.boolean().default(false),
  isFeatured: z.boolean().default(false),
  isActive: z.boolean().default(true),
  categoryId: z.string().uuid(),
  brandId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
  seo: seoSchema.optional(),
  images: z.array(imageSchema).optional(),
  variants: z.array(variantSchema).optional(),
});

const createProductSchema = baseProductSchema.superRefine((data, ctx) => {
  validatePricePair(data.basePrice, data.comparePrice, ctx, ['comparePrice']);
  if (data.hasVariants && (!data.variants || data.variants.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['variants'],
      message: 'At least one variant is required when hasVariants is true',
    });
  }
  data.variants?.forEach((variant, index) => {
    validatePricePair(variant.price, variant.comparePrice, ctx, ['variants', index, 'comparePrice']);
  });
});

const updateProductSchema = baseProductSchema.partial().extend({
  images: z.array(imageSchema).optional(),
  variants: z.array(variantSchema).optional(),
});

const updateStatusSchema = z.object({
  isActive: z.boolean(),
});

type ProductInput = z.infer<typeof createProductSchema>;
type ProductUpdateInput = z.infer<typeof updateProductSchema>;

function validatePricePair(
  price: number,
  comparePrice: number | undefined,
  ctx: z.RefinementCtx,
  path: (string | number)[],
) {
  if (comparePrice !== undefined && comparePrice < price) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'comparePrice must be greater than or equal to price',
    });
  }
}

function buildMetadata(
  metadata: Record<string, unknown> | undefined,
  seo: z.infer<typeof seoSchema> | undefined,
  base?: Prisma.JsonValue | null,
): Prisma.InputJsonValue | undefined {
  if (metadata === undefined && seo === undefined) return undefined;

  const baseObject =
    base && typeof base === 'object' && !Array.isArray(base)
      ? (base as Record<string, unknown>)
      : {};

  const merged: Record<string, unknown> = { ...baseObject, ...(metadata ?? {}) };
  if (seo !== undefined) merged.seo = seo;
  return merged as Prisma.InputJsonValue;
}

function normalizeImages(images: z.infer<typeof imageSchema>[]) {
  let thumbnailAssigned = false;
  return images.map((image, index) => {
    const isThumbnail = !thumbnailAssigned && (image.isThumbnail || index === 0);
    if (isThumbnail) thumbnailAssigned = true;
    return {
      url: image.url,
      altText: image.altText ?? null,
      sortOrder: image.sortOrder,
      isThumbnail,
      variantSku: image.variantSku,
    };
  });
}

function assertUniqueVariantSkus(variants: z.infer<typeof variantSchema>[]) {
  const seen = new Set<string>();
  for (const variant of variants) {
    if (seen.has(variant.sku)) {
      throw new BadRequestError(`Duplicate variant SKU in payload: ${variant.sku}`);
    }
    seen.add(variant.sku);
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class AdminProductService {
  static async listProducts(query: z.infer<typeof listProductsSchema>) {
    const { page, limit, search, categoryId, brandId, status, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = {};

    if (status === 'active') {
      where.isActive = true;
      where.isArchived = false;
    } else if (status === 'inactive') {
      where.isActive = false;
      where.isArchived = false;
    } else if (status === 'archived') {
      where.isArchived = true;
    } else if (status === 'low_stock') {
      where.isArchived = false;
      where.stock = { gt: 0, lte: prisma.product.fields.lowStockThreshold };
    } else if (status === 'out_of_stock') {
      where.isArchived = false;
      where.stock = { lte: 0 };
    } else {
      where.isArchived = false;
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (categoryId) where.categoryId = categoryId;
    if (brandId) where.brandId = brandId;

    const [total, products] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          category: { select: { id: true, name: true, slug: true } },
          brand: { select: { id: true, name: true } },
          images: { take: 1, orderBy: { sortOrder: 'asc' } },
          _count: { select: { variants: true, reviews: true } },
        },
      }),
    ]);

    return {
      products: products.map((p) => ({
        ...p,
        basePrice: Number(p.basePrice),
        comparePrice: p.comparePrice ? Number(p.comparePrice) : null,
        costPrice: p.costPrice ? Number(p.costPrice) : null,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async getProduct(id: string) {
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        brand: { select: { id: true, name: true, slug: true, logoUrl: true } },
        images: { orderBy: { sortOrder: 'asc' } },
        variants: { orderBy: { sortOrder: 'asc' } },
        inventoryLogs: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: { createdByUser: { select: { firstName: true, lastName: true, email: true } } },
        },
        _count: { select: { reviews: true, orderItems: true } },
      },
    });
    if (!product) throw new NotFoundError('Product not found');
    return this.serializeProduct(product);
  }

  static async createProduct(data: ProductInput, adminId: string) {
    await this.assertCategoryAndBrand(data.categoryId, data.brandId);
    await this.assertProductSlugAndSkuUnique(data.slug, data.sku, data.variants ?? []);

    const { images, variants, seo, metadata, ...productData } = data;
    const variantStock = (variants ?? []).reduce((sum, variant) => sum + variant.stock, 0);
    const stock = data.hasVariants ? variantStock : data.stock;

    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          ...productData,
          stock,
          metadata: buildMetadata(metadata, seo),
          images: images ? { create: [] } : undefined,
        },
      });

      const createdVariants = [];
      for (const variant of variants ?? []) {
        const { id: _id, ...variantData } = variant;
        const row = await tx.productVariant.create({
          data: { ...variantData, productId: created.id },
        });
        createdVariants.push(row);

        if (row.stock > 0) {
          await tx.inventoryLog.create({
            data: {
              productId: created.id,
              variantId: row.id,
              type: 'PURCHASE_RECEIPT',
              quantityChange: row.stock,
              previousStock: 0,
              newStock: row.stock,
              note: 'Initial variant stock on product creation',
              createdByUserId: adminId,
            },
          });
        }
      }

      if (images && images.length > 0) {
        await this.replaceImages(tx, created.id, images, createdVariants);
      }

      if (!data.hasVariants && stock > 0) {
        await tx.inventoryLog.create({
          data: {
            productId: created.id,
            type: 'PURCHASE_RECEIPT',
            quantityChange: stock,
            previousStock: 0,
            newStock: stock,
            note: 'Initial stock on product creation',
            createdByUserId: adminId,
          },
        });
      }

      return tx.product.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          category: { select: { id: true, name: true } },
          brand: { select: { id: true, name: true } },
          images: { orderBy: { sortOrder: 'asc' } },
          variants: { orderBy: { sortOrder: 'asc' } },
        },
      });
    });

    return this.serializeProduct(product);
  }

  static async updateProduct(id: string, data: ProductUpdateInput, adminId: string) {
    const existing = await prisma.product.findUnique({
      where: { id },
      include: { variants: true },
    });
    if (!existing) throw new NotFoundError('Product not found');

    if (data.categoryId || data.brandId !== undefined) {
      await this.assertCategoryAndBrand(
        data.categoryId ?? existing.categoryId,
        data.brandId === undefined ? existing.brandId ?? undefined : data.brandId,
      );
    }

    await this.assertProductSlugAndSkuUnique(
      data.slug ?? existing.slug,
      data.sku ?? existing.sku,
      data.variants ?? [],
      id,
      data.variants?.flatMap((variant) => (variant.id ? [variant.id] : [])) ?? [],
    );

    const nextBasePrice = data.basePrice ?? Number(existing.basePrice);
    const nextComparePrice =
      data.comparePrice !== undefined
        ? data.comparePrice
        : existing.comparePrice
          ? Number(existing.comparePrice)
          : undefined;
    if (nextComparePrice !== undefined && nextComparePrice < nextBasePrice) {
      throw new BadRequestError('comparePrice must be greater than or equal to basePrice');
    }

    const hasVariants =
      data.hasVariants ?? (data.variants !== undefined ? data.variants.length > 0 : existing.hasVariants);

    if (hasVariants) {
      const activeProvided = (data.variants ?? []).filter((variant) => variant.isActive).length;
      const activeExisting = existing.variants.filter(
        (variant) => variant.isActive && !data.variants?.some((v) => v.id === variant.id),
      ).length;
      if (activeProvided + activeExisting === 0) {
        throw new BadRequestError('At least one active variant is required when hasVariants is true');
      }
    }

    const { images, variants, seo, metadata, ...productData } = data;

    const updated = await prisma.$transaction(async (tx) => {
      if (variants) assertUniqueVariantSkus(variants);

      let stock = data.stock;

      if (variants) {
        const existingIds = new Set(existing.variants.map((variant) => variant.id));
        const retainedIds = new Set<string>();

        for (const variant of variants) {
          const { id: variantId, ...variantData } = variant;
          let row;

          if (variantId) {
            if (!existingIds.has(variantId)) {
              throw new BadRequestError(`Variant ${variantId} does not belong to this product`);
            }
            const previous = existing.variants.find((item) => item.id === variantId)!;
            row = await tx.productVariant.update({
              where: { id: variantId },
              data: variantData,
            });
            retainedIds.add(variantId);

            if (previous.stock !== row.stock) {
              await tx.inventoryLog.create({
                data: {
                  productId: id,
                  variantId: row.id,
                  type: 'MANUAL_ADJUSTMENT',
                  quantityChange: row.stock - previous.stock,
                  previousStock: previous.stock,
                  newStock: row.stock,
                  note: 'Variant stock updated from product editor',
                  createdByUserId: adminId,
                },
              });
            }
          } else {
            row = await tx.productVariant.create({
              data: { ...variantData, productId: id },
            });
            if (row.stock > 0) {
              await tx.inventoryLog.create({
                data: {
                  productId: id,
                  variantId: row.id,
                  type: 'PURCHASE_RECEIPT',
                  quantityChange: row.stock,
                  previousStock: 0,
                  newStock: row.stock,
                  note: 'New variant stock from product editor',
                  createdByUserId: adminId,
                },
              });
            }
          }
        }

        for (const previous of existing.variants) {
          if (previous.isActive && !retainedIds.has(previous.id)) {
            await tx.productVariant.update({
              where: { id: previous.id },
              data: { isActive: false },
            });
          }
        }

        const activeVariants = await tx.productVariant.findMany({
          where: { productId: id, isActive: true },
          select: { stock: true },
        });
        stock = activeVariants.reduce((sum, variant) => sum + variant.stock, 0);
      } else if (data.stock !== undefined && data.stock !== existing.stock) {
        await tx.inventoryLog.create({
          data: {
            productId: id,
            type: 'MANUAL_ADJUSTMENT',
            quantityChange: data.stock - existing.stock,
            previousStock: existing.stock,
            newStock: data.stock,
            note: 'Product stock updated from product editor',
            createdByUserId: adminId,
          },
        });
      }

      const updatedProduct = await tx.product.update({
        where: { id },
        data: {
          ...productData,
          ...(stock !== undefined ? { stock } : {}),
          hasVariants,
          metadata: buildMetadata(metadata, seo, existing.metadata),
        },
      });

      if (images) {
        const allVariants = await tx.productVariant.findMany({ where: { productId: id } });
        await this.replaceImages(tx, id, images, allVariants);
      }

      return tx.product.findUniqueOrThrow({
        where: { id: updatedProduct.id },
        include: {
          category: { select: { id: true, name: true } },
          brand: { select: { id: true, name: true } },
          images: { orderBy: { sortOrder: 'asc' } },
          variants: { orderBy: { sortOrder: 'asc' } },
        },
      });
    });

    return this.serializeProduct(updated);
  }

  static async updateStatus(id: string, isActive: boolean) {
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Product not found');
    if (existing.isArchived) {
      throw new BadRequestError('Archived products cannot be activated. Restore them first.');
    }

    return prisma.product.update({ where: { id }, data: { isActive } });
  }

  static async restoreProduct(id: string) {
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Product not found');

    return prisma.product.update({
      where: { id },
      data: { isArchived: false, isActive: false },
    });
  }

  static async softDelete(id: string) {
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Product not found');
    if (existing.isArchived) return existing;

    return prisma.product.update({
      where: { id },
      data: { isArchived: true, isActive: false },
    });
  }

  static async getProductStats(query: z.infer<typeof statsSchema>) {
    const { categoryId, brandId, search } = query;

    const where: Prisma.ProductWhereInput = {};

    if (categoryId) where.categoryId = categoryId;
    if (brandId) where.brandId = brandId;

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, active, lowStock, outOfStock, archived] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.count({ where: { ...where, isActive: true, isArchived: false } }),
      prisma.product.count({
        where: {
          ...where,
          isActive: true,
          isArchived: false,
          stock: { gt: 0, lte: prisma.product.fields.lowStockThreshold },
        },
      }),
      prisma.product.count({
        where: { ...where, isActive: true, isArchived: false, stock: { lte: 0 } },
      }),
      prisma.product.count({ where: { ...where, isArchived: true } }),
    ]);

    return {
      total,
      active,
      lowStock,
      outOfStock,
      archived,
    };
  }

  static async bulkUpdateStatus(ids: string[], isActive: boolean) {
    const existing = await prisma.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, isArchived: true },
    });

    if (existing.length === 0) {
      throw new NotFoundError('No products found');
    }

    const archivedIds = existing
      .filter((p) => p.isArchived)
      .map((p) => p.id);
    if (archivedIds.length > 0 && isActive) {
      throw new BadRequestError(
        `Cannot activate archived products: ${archivedIds.join(', ')}. Restore them first.`,
      );
    }

    return prisma.product.updateMany({
      where: {
        id: { in: ids },
        isArchived: false,
      },
      data: { isActive },
    });
  }

  static async exportProducts(query: z.infer<typeof exportSchema>) {
    const { search, categoryId, brandId, status, sortBy, sortOrder } = query;

    const where: Prisma.ProductWhereInput = {};

    if (status === 'active') {
      where.isActive = true;
      where.isArchived = false;
    } else if (status === 'inactive') {
      where.isActive = false;
      where.isArchived = false;
    } else if (status === 'archived') {
      where.isArchived = true;
    } else if (status === 'low_stock') {
      where.isArchived = false;
      where.stock = { gt: 0, lte: prisma.product.fields.lowStockThreshold };
    } else if (status === 'out_of_stock') {
      where.isArchived = false;
      where.stock = { lte: 0 };
    } else {
      where.isArchived = false;
    }

    if (categoryId) where.categoryId = categoryId;
    if (brandId) where.brandId = brandId;

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
      ];
    }

    return prisma.product.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      include: {
        category: { select: { name: true } },
        brand: { select: { name: true } },
      },
    });
  }

  private static async replaceImages(
    tx: Prisma.TransactionClient,
    productId: string,
    images: z.infer<typeof imageSchema>[],
    variants: { id: string; sku: string }[],
  ) {
    const normalized = normalizeImages(images);
    const variantIdBySku = new Map(variants.map((variant) => [variant.sku, variant.id]));

    for (const image of normalized) {
      if (image.variantSku && !variantIdBySku.has(image.variantSku)) {
        throw new BadRequestError(`Image references an unknown variant SKU: ${image.variantSku}`);
      }
    }

    await tx.productImage.deleteMany({ where: { productId } });
    for (const image of normalized) {
      await tx.productImage.create({
        data: {
          productId,
          url: image.url,
          altText: image.altText,
          sortOrder: image.sortOrder,
          isThumbnail: image.isThumbnail,
          variantId: image.variantSku ? variantIdBySku.get(image.variantSku) : undefined,
        },
      });
    }
  }

  private static async assertCategoryAndBrand(categoryId: string, brandId?: string | null) {
    const category = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) throw new BadRequestError('Category not found');

    if (brandId) {
      const brand = await prisma.brand.findUnique({ where: { id: brandId } });
      if (!brand) throw new BadRequestError('Brand not found');
    }
  }

  private static async assertProductSlugAndSkuUnique(
    slug: string,
    sku: string,
    variants: z.infer<typeof variantSchema>[],
    excludeProductId?: string,
    allowedVariantIds?: string[],
  ) {
    const slugConflict = await prisma.product.findFirst({
      where: { slug, ...(excludeProductId ? { id: { not: excludeProductId } } : {}) },
    });
    if (slugConflict) throw new BadRequestError('Product slug already exists');

    const productSkuConflict = await prisma.product.findFirst({
      where: { sku, ...(excludeProductId ? { id: { not: excludeProductId } } : {}) },
    });
    if (productSkuConflict) throw new BadRequestError('Product SKU already exists');

    const productSkuVariantConflict = await prisma.productVariant.findUnique({ where: { sku } });
    if (productSkuVariantConflict) {
      throw new BadRequestError('Product SKU is already used by a product variant');
    }

    if (variants.length > 0) {
      assertUniqueVariantSkus(variants);

      const applicableVariantIds = allowedVariantIds ?? [];
      const conflictingVariant = await prisma.productVariant.findFirst({
        where: {
          sku: { in: variants.map((variant) => variant.sku) },
          ...(applicableVariantIds.length > 0 ? { id: { notIn: applicableVariantIds } } : {}),
        },
      });
      if (conflictingVariant) {
        throw new BadRequestError(`Variant SKU already exists: ${conflictingVariant.sku}`);
      }

      const conflictingProduct = await prisma.product.findFirst({
        where: { sku: { in: variants.map((variant) => variant.sku) } },
      });
      if (conflictingProduct) {
        throw new BadRequestError(`Variant SKU conflicts with product SKU: ${conflictingProduct.sku}`);
      }
    }
  }

  private static serializeProduct(product: Record<string, unknown>) {
    const row = product as {
      basePrice: unknown;
      comparePrice: unknown;
      costPrice: unknown;
      variants?: { price: unknown; comparePrice: unknown; costPrice: unknown }[];
    };
    return {
      ...row,
      basePrice: Number(row.basePrice),
      comparePrice: row.comparePrice ? Number(row.comparePrice) : null,
      costPrice: row.costPrice ? Number(row.costPrice) : null,
      variants: row.variants?.map((variant) => ({
        ...variant,
        price: Number(variant.price),
        comparePrice: variant.comparePrice ? Number(variant.comparePrice) : null,
        costPrice: variant.costPrice ? Number(variant.costPrice) : null,
      })),
    };
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const adminProductsRouter = Router();
adminProductsRouter.use(authenticate, requireRole(['ADMIN', 'STAFF']));

adminProductsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listProductsSchema.parse(req.query);
    const result = await AdminProductService.listProducts(query);
    res.json({ success: true, data: result.products, meta: result.meta });
  } catch (err) {
    next(err);
  }
});

adminProductsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await AdminProductService.getProduct(req.params.id!);
    sendSuccess(res, 200, product);
  } catch (err) {
    next(err);
  }
});

adminProductsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createProductSchema.parse(req.body);
    const product = await AdminProductService.createProduct(data, req.user!.id);
    sendSuccess(res, 201, product);
  } catch (err) {
    next(err);
  }
});

adminProductsRouter.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateProductSchema.parse(req.body);
    const product = await AdminProductService.updateProduct(req.params.id!, data, req.user!.id);
    sendSuccess(res, 200, product);
  } catch (err) {
    next(err);
  }
});

adminProductsRouter.patch('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { isActive } = updateStatusSchema.parse(req.body);
    const product = await AdminProductService.updateStatus(req.params.id!, isActive);
    sendSuccess(res, 200, product);
  } catch (err) {
    next(err);
  }
});

adminProductsRouter.patch('/:id/restore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await AdminProductService.restoreProduct(req.params.id!);
    sendSuccess(res, 200, product);
  } catch (err) {
    next(err);
  }
});

adminProductsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await AdminProductService.softDelete(req.params.id!);
    sendSuccess(res, 200, { message: 'Product archived successfully' });
  } catch (err) {
    next(err);
  }
});

adminProductsRouter.get('/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = statsSchema.parse(req.query);
    const stats = await AdminProductService.getProductStats(query);
    sendSuccess(res, 200, stats);
  } catch (err) {
    next(err);
  }
});

adminProductsRouter.patch('/bulk-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = bulkStatusSchema.parse(req.body);
    const result = await AdminProductService.bulkUpdateStatus(data.ids, data.isActive);
    sendSuccess(res, 200, {
      message: `Products ${data.isActive ? 'activated' : 'deactivated'} successfully`,
      updated: result.count,
    });
  } catch (err) {
    next(err);
  }
});

adminProductsRouter.get('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = exportSchema.parse(req.query);
    const products = await AdminProductService.exportProducts(query);

    const headers = [
      'ID',
      'Title',
      'Slug',
      'SKU',
      'Category',
      'Brand',
      'Base Price',
      'Compare Price',
      'Cost Price',
      'Stock',
      'Low Stock Threshold',
      'Status',
      'Created At',
    ];

    const rows = products.map((p) => [
      p.id,
      p.title,
      p.slug,
      p.sku,
      p.category?.name || '',
      p.brand?.name || '',
      p.basePrice,
      p.comparePrice ?? '',
      p.costPrice ?? '',
      p.stock,
      p.lowStockThreshold,
      p.isActive ? (p.stock <= p.lowStockThreshold ? 'Low Stock' : 'Active') : 'Inactive',
      p.createdAt,
    ]);

    const csv = [headers, ...rows]
      .map((row) =>
        row
          .map((cell) => {
            const str = String(cell ?? '');
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          })
          .join(','),
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
});
