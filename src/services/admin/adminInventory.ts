import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma, StockMovementType } from '@prisma/client';
import { authenticate } from '../../middlewares/auth.js';
import { requireRole } from '../../middlewares/role.js';
import { prisma } from '../../lib/prisma.js';
import { sendSuccess } from '../../utils/response.js';
import { AppError, BadRequestError } from '../../utils/appError.js';

// ── Validation Schemas ───────────────────────────────────────────────────────

const stockStatusSchema = z.enum(['ALL', 'OK', 'LOW', 'CRITICAL']);

const adjustStockSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  type: z.nativeEnum(StockMovementType),
  quantityChange: z
    .number()
    .int()
    .refine((n) => n !== 0, { message: 'quantityChange must be non-zero' }),
  note: z.string().max(500).optional(),
  referenceId: z.string().max(100).optional(),
});

const listInventorySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  stockStatus: stockStatusSchema.default('ALL'),
  status: z.enum(['all', 'active', 'inactive']).default('all'),
  categoryId: z.string().uuid().optional(),
  sortBy: z.enum(['stock', 'title', 'updatedAt']).default('stock'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

const listLogsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  productId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  type: z.nativeEnum(StockMovementType).optional(),
  search: z.string().trim().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

interface InventoryRow {
  unitId: string;
  productId: string;
  variantId: string | null;
  productTitle: string;
  variantTitle: string | null;
  sku: string;
  stock: number;
  lowStockThreshold: number;
  isActive: boolean;
  updatedAt: Date;
  categoryName: string | null;
  brandName: string | null;
}

// ── Query Helpers ────────────────────────────────────────────────────────────

function inventoryUnitSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      p.id AS "unitId",
      p.id AS "productId",
      NULL::text AS "variantId",
      p.title AS "productTitle",
      NULL::text AS "variantTitle",
      p.sku AS "sku",
      p.stock AS "stock",
      p."lowStockThreshold" AS "lowStockThreshold",
      p."isActive" AS "isActive",
      p."updatedAt" AS "updatedAt",
      c.name AS "categoryName",
      b.name AS "brandName",
      p."categoryId" AS "categoryId"
    FROM products p
    LEFT JOIN categories c ON c.id = p."categoryId"
    LEFT JOIN brands b ON b.id = p."brandId"
    WHERE p."isArchived" = false
      AND p."hasVariants" = false
    UNION ALL
    SELECT
      v.id AS "unitId",
      p.id AS "productId",
      v.id AS "variantId",
      p.title AS "productTitle",
      v.title AS "variantTitle",
      v.sku AS "sku",
      v.stock AS "stock",
      v."lowStockThreshold" AS "lowStockThreshold",
      (v."isActive" AND p."isActive") AS "isActive",
      v."updatedAt" AS "updatedAt",
      c.name AS "categoryName",
      b.name AS "brandName",
      p."categoryId" AS "categoryId"
    FROM product_variants v
    INNER JOIN products p ON p.id = v."productId"
    LEFT JOIN categories c ON c.id = p."categoryId"
    LEFT JOIN brands b ON b.id = p."brandId"
    WHERE p."isArchived" = false
      AND p."hasVariants" = true
      AND v."isActive" = true
  `;
}

function inventoryWhere(query: z.infer<typeof listInventorySchema>): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  const search = query.search ? `%${query.search}%` : null;

  if (search) {
    conditions.push(Prisma.sql`(
      u."productTitle" ILIKE ${search}
      OR u."variantTitle" ILIKE ${search}
      OR u."sku" ILIKE ${search}
      OR u."categoryName" ILIKE ${search}
      OR u."brandName" ILIKE ${search}
    )`);
  }

  if (query.stockStatus === 'CRITICAL') {
    conditions.push(Prisma.sql`u."stock" <= 0`);
  } else if (query.stockStatus === 'LOW') {
    conditions.push(Prisma.sql`u."stock" > 0 AND u."stock" <= u."lowStockThreshold"`);
  } else if (query.stockStatus === 'OK') {
    conditions.push(Prisma.sql`u."stock" > u."lowStockThreshold"`);
  }

  if (query.status === 'active') conditions.push(Prisma.sql`u."isActive" = true`);
  if (query.status === 'inactive') conditions.push(Prisma.sql`u."isActive" = false`);
  if (query.categoryId) conditions.push(Prisma.sql`u."categoryId" = ${query.categoryId}`);

  if (conditions.length === 0) return Prisma.empty;
  return Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
}

function inventoryOrder(query: z.infer<typeof listInventorySchema>): Prisma.Sql {
  const direction = query.sortOrder === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  if (query.sortBy === 'title') {
    return Prisma.sql`ORDER BY u."productTitle" ${direction}, u."variantTitle" ${direction}`;
  }
  if (query.sortBy === 'updatedAt') {
    return Prisma.sql`ORDER BY u."updatedAt" ${direction}, u."productTitle" ASC`;
  }
  return Prisma.sql`ORDER BY u."stock" ${direction}, u."productTitle" ASC`;
}

function stockStatus(stock: number, threshold: number): 'OK' | 'LOW' | 'CRITICAL' {
  if (stock <= 0) return 'CRITICAL';
  if (stock <= threshold) return 'LOW';
  return 'OK';
}

// ── Service Class ────────────────────────────────────────────────────────────

export class AdminInventoryService {
  async listInventory(query: z.infer<typeof listInventorySchema>) {
    const { page, limit } = query;
    const skip = (page - 1) * limit;
    const where = inventoryWhere(query);
    const order = inventoryOrder(query);

    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw<InventoryRow[]>(Prisma.sql`
        SELECT * FROM (${inventoryUnitSql()}) u
        ${where}
        ${order}
        LIMIT ${limit} OFFSET ${skip}
      `),
      prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
        SELECT COUNT(*)::int AS "total"
        FROM (${inventoryUnitSql()}) u
        ${where}
      `),
    ]);

    const total = countRows[0]?.total ?? 0;
    const totalPages = Math.ceil(total / limit);

    const units = rows.map((row) => ({
      ...row,
      title: row.variantTitle ? `${row.productTitle} — ${row.variantTitle}` : row.productTitle,
      stockStatus: stockStatus(row.stock, row.lowStockThreshold),
    }));

    return {
      units,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  async adjustStock(data: z.infer<typeof adjustStockSchema>, userId: string) {
    const { productId, variantId, type, quantityChange, note, referenceId } = data;

    return prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product) throw new AppError('Product not found', 404, 'NOT_FOUND');
      if (product.isArchived) {
        throw new BadRequestError('Archived products cannot be stock-adjusted');
      }

      if (variantId) {
        const variant = await tx.productVariant.findUnique({ where: { id: variantId } });
        if (!variant || variant.productId !== productId) {
          throw new AppError('Variant not found for this product', 404, 'NOT_FOUND');
        }
        if (!variant.isActive) {
          throw new BadRequestError('Inactive variants cannot be stock-adjusted');
        }

        const previousStock = variant.stock;
        const newStock = previousStock + quantityChange;
        if (newStock < 0) {
          throw new AppError('Stock cannot go below 0', 400, 'INSUFFICIENT_STOCK');
        }

        const updatedVariant = await tx.productVariant.update({
          where: { id: variantId },
          data: { stock: newStock },
        });

        const log = await tx.inventoryLog.create({
          data: {
            productId,
            variantId,
            type,
            quantityChange,
            previousStock,
            newStock,
            referenceId,
            note,
            createdByUserId: userId,
          },
        });

        const activeVariants = await tx.productVariant.findMany({
          where: { productId, isActive: true },
          select: { stock: true },
        });
        const aggregateStock = activeVariants.reduce((sum, item) => sum + item.stock, 0);

        await tx.product.update({
          where: { id: productId },
          data: { stock: aggregateStock },
        });

        return { updatedVariant, log, productStock: aggregateStock };
      }

      if (product.hasVariants) {
        throw new BadRequestError(
          'This product uses variants. Adjust a specific variant instead of the aggregate product stock.',
        );
      }

      const previousStock = product.stock;
      const newStock = previousStock + quantityChange;
      if (newStock < 0) {
        throw new AppError('Stock cannot go below 0', 400, 'INSUFFICIENT_STOCK');
      }

      const updatedProduct = await tx.product.update({
        where: { id: productId },
        data: { stock: newStock },
      });

      const log = await tx.inventoryLog.create({
        data: {
          productId,
          type,
          quantityChange,
          previousStock,
          newStock,
          referenceId,
          note,
          createdByUserId: userId,
        },
      });

      return { updatedProduct, log, productStock: newStock };
    });
  }

  async listLogs(query: z.infer<typeof listLogsSchema>) {
    const { page, limit, productId, variantId, type, search, startDate, endDate } = query;
    const skip = (page - 1) * limit;

    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    if (start && end && start > end) {
      throw new BadRequestError('startDate must be before or equal to endDate');
    }

    const where: Prisma.InventoryLogWhereInput = {
      ...(productId ? { productId } : {}),
      ...(variantId ? { variantId } : {}),
      ...(type ? { type } : {}),
      ...(start || end
        ? {
            createdAt: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { product: { title: { contains: search, mode: 'insensitive' } } },
              { product: { sku: { contains: search, mode: 'insensitive' } } },
              { variant: { sku: { contains: search, mode: 'insensitive' } } },
              { note: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [logs, total] = await Promise.all([
      prisma.inventoryLog.findMany({
        where,
        include: {
          product: { select: { id: true, title: true, sku: true } },
          variant: { select: { id: true, sku: true, title: true, attributes: true } },
          createdByUser: { select: { firstName: true, lastName: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.inventoryLog.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);
    return {
      logs,
      meta: { page, limit, total, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
    };
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export const adminInventoryRouter = Router();
const svc = new AdminInventoryService();
const adminGuard = [authenticate, requireRole(['ADMIN', 'STAFF'])];

adminInventoryRouter.get('/', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listInventorySchema.parse(req.query);
    const result = await svc.listInventory(query);
    sendSuccess(res, 200, result.units, result.meta);
  } catch (err) {
    next(err);
  }
});

adminInventoryRouter.post('/adjust', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = adjustStockSchema.parse(req.body);
    const result = await svc.adjustStock(data, req.user!.id);
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});

adminInventoryRouter.get('/logs', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listLogsSchema.parse(req.query);
    const result = await svc.listLogs(query);
    sendSuccess(res, 200, result.logs, result.meta);
  } catch (err) {
    next(err);
  }
});
