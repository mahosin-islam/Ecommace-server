import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/auth.js';
import { requireRole } from '../../middlewares/role.js';
import { prisma } from '../../lib/prisma.js';
import { sendSuccess } from '../../utils/response.js';
import { AppError, BadRequestError } from '../../utils/appError.js';
import { DiscountType, Prisma } from '@prisma/client';

// ── Validation Schemas ───────────────────────────────────────────────────────

const listCouponsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  isActive: z.enum(['all', 'true', 'false']).default('all'),
});

const couponBaseSchema = z.object({
  code: z
    .string()
    .min(3)
    .max(50)
    .transform((value) => value.trim().toUpperCase()),
  description: z.string().max(500).optional(),
  discountType: z.nativeEnum(DiscountType),
  discountValue: z.number().positive(),
  minOrderAmount: z.number().nonnegative().optional(),
  maxDiscountAmount: z.number().positive().optional(),
  usageLimit: z.number().int().positive().optional(),
  perUserLimit: z.number().int().positive().default(1),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  isActive: z.boolean().default(true),
});

const createCouponSchema = couponBaseSchema.superRefine((data, ctx) => {
  if (new Date(data.endDate) <= new Date(data.startDate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endDate'],
      message: 'endDate must be after startDate',
    });
  }
  if (data.discountType === DiscountType.PERCENTAGE && data.discountValue > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['discountValue'],
      message: 'Percentage discount cannot exceed 100',
    });
  }
});

const updateCouponSchema = couponBaseSchema.partial();

const statusSchema = z.object({
  isActive: z.boolean(),
});

// ── Serialization / Status Helpers ───────────────────────────────────────────

type CouponStatus = 'active' | 'scheduled' | 'expired' | 'exhausted' | 'inactive';

function couponStatus(coupon: {
  isActive: boolean;
  startDate: Date;
  endDate: Date;
  usageLimit: number | null;
  usageCount: number;
}): CouponStatus {
  const now = new Date();
  if (!coupon.isActive) return 'inactive';
  if (coupon.endDate < now) return 'expired';
  if (coupon.startDate > now) return 'scheduled';
  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) return 'exhausted';
  return 'active';
}

function serializeCoupon(coupon: {
  discountValue: unknown;
  minOrderAmount: unknown;
  maxDiscountAmount: unknown;
  isActive: boolean;
  startDate: Date;
  endDate: Date;
  usageLimit: number | null;
  usageCount: number;
}) {
  return {
    ...coupon,
    discountValue: Number(coupon.discountValue),
    minOrderAmount: coupon.minOrderAmount ? Number(coupon.minOrderAmount) : null,
    maxDiscountAmount: coupon.maxDiscountAmount ? Number(coupon.maxDiscountAmount) : null,
    remainingUses:
      coupon.usageLimit !== null ? Math.max(coupon.usageLimit - coupon.usageCount, 0) : null,
    status: couponStatus(coupon),
  };
}

// ── Service Class ────────────────────────────────────────────────────────────

export class AdminCouponsService {
  async listCoupons(query: z.infer<typeof listCouponsSchema>) {
    const { page, limit, search, isActive } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.CouponWhereInput = {
      ...(isActive !== 'all' ? { isActive: isActive === 'true' } : {}),
      ...(search
        ? {
            OR: [
              { code: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [coupons, total] = await Promise.all([
      prisma.coupon.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { _count: { select: { usages: true } } },
      }),
      prisma.coupon.count({ where }),
    ]);

    const usageTotals =
      coupons.length > 0
        ? await prisma.couponUsage.groupBy({
            by: ['couponId'],
            _sum: { discountApplied: true },
            where: { couponId: { in: coupons.map((coupon) => coupon.id) } },
          })
        : [];
    const totalByCoupon = new Map(
      usageTotals.map((row) => [row.couponId, Number(row._sum.discountApplied ?? 0)]),
    );

    const totalPages = Math.ceil(total / limit);
    return {
      coupons: coupons.map((coupon) => ({
        ...serializeCoupon(coupon),
        totalDiscountGiven: totalByCoupon.get(coupon.id) ?? 0,
      })),
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

  async getCoupon(id: string) {
    const coupon = await prisma.coupon.findUnique({
      where: { id },
      include: {
        usages: {
          take: 25,
          orderBy: { usedAt: 'desc' },
          include: {
            order: { select: { id: true, orderNumber: true, totalAmount: true, status: true } },
          },
        },
        _count: { select: { usages: true } },
      },
    });
    if (!coupon) throw new AppError('Coupon not found', 404, 'NOT_FOUND');

    const aggregate = await prisma.couponUsage.aggregate({
      _sum: { discountApplied: true },
      where: { couponId: id },
    });

    const userIds = coupon.usages.flatMap((usage) => (usage.userId ? [usage.userId] : []));
    const users =
      userIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true, firstName: true, lastName: true },
          })
        : [];
    const userById = new Map(users.map((user) => [user.id, user]));

    return {
      ...serializeCoupon(coupon),
      totalDiscountGiven: Number(aggregate._sum.discountApplied ?? 0),
      usages: coupon.usages.map((usage) => ({
        ...usage,
        discountApplied: Number(usage.discountApplied),
        order: { ...usage.order, totalAmount: Number(usage.order.totalAmount) },
        user: usage.userId ? (userById.get(usage.userId) ?? null) : null,
      })),
    };
  }

  async createCoupon(data: z.infer<typeof createCouponSchema>) {
    const existing = await prisma.coupon.findUnique({ where: { code: data.code } });
    if (existing) throw new AppError('Coupon code already exists', 409, 'DUPLICATE_CODE');

    const coupon = await prisma.coupon.create({
      data: {
        ...data,
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
      },
    });

    return serializeCoupon(coupon);
  }

  async updateCoupon(id: string, data: z.infer<typeof updateCouponSchema>) {
    const existing = await prisma.coupon.findUnique({ where: { id } });
    if (!existing) throw new AppError('Coupon not found', 404, 'NOT_FOUND');

    if (data.code && data.code !== existing.code) {
      const codeConflict = await prisma.coupon.findUnique({ where: { code: data.code } });
      if (codeConflict) throw new AppError('Coupon code already in use', 409, 'DUPLICATE_CODE');
    }

    const startDate = data.startDate ? new Date(data.startDate) : existing.startDate;
    const endDate = data.endDate ? new Date(data.endDate) : existing.endDate;
    if (endDate <= startDate) {
      throw new BadRequestError('endDate must be after startDate');
    }

    const discountType = data.discountType ?? existing.discountType;
    const discountValue = data.discountValue ?? Number(existing.discountValue);
    if (discountType === DiscountType.PERCENTAGE && discountValue > 100) {
      throw new BadRequestError('Percentage discount cannot exceed 100');
    }

    if (data.usageLimit !== undefined && data.usageLimit < existing.usageCount) {
      throw new BadRequestError(
        `usageLimit cannot be lower than the ${existing.usageCount} existing usages`,
      );
    }

    const updated = await prisma.coupon.update({
      where: { id },
      data: {
        ...data,
        ...(data.startDate ? { startDate } : {}),
        ...(data.endDate ? { endDate } : {}),
      },
    });

    return serializeCoupon(updated);
  }

  async updateStatus(id: string, isActive: boolean) {
    const existing = await prisma.coupon.findUnique({ where: { id } });
    if (!existing) throw new AppError('Coupon not found', 404, 'NOT_FOUND');
    if (existing.isActive === isActive) {
      throw new BadRequestError(`Coupon is already ${isActive ? 'active' : 'inactive'}`);
    }

    const updated = await prisma.coupon.update({
      where: { id },
      data: { isActive },
    });
    return serializeCoupon(updated);
  }

  async deleteCoupon(id: string) {
    const coupon = await prisma.coupon.findUnique({ where: { id } });
    if (!coupon) throw new AppError('Coupon not found', 404, 'NOT_FOUND');

    if (coupon.usageCount > 0) {
      const updated = await prisma.coupon.update({
        where: { id },
        data: { isActive: false },
      });
      return {
        message: 'Coupon deactivated because it has existing usages',
        data: serializeCoupon(updated),
      };
    }

    await prisma.coupon.delete({ where: { id } });
    return { message: 'Coupon deleted', data: null };
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export const adminCouponsRouter = Router();
const svc = new AdminCouponsService();
const adminGuard = [authenticate, requireRole(['ADMIN', 'STAFF'])];

adminCouponsRouter.get('/', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listCouponsSchema.parse(req.query);
    const result = await svc.listCoupons(query);
    sendSuccess(res, 200, result.coupons, result.meta);
  } catch (err) {
    next(err);
  }
});

adminCouponsRouter.get('/:id', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const coupon = await svc.getCoupon(req.params.id!);
    sendSuccess(res, 200, coupon);
  } catch (err) {
    next(err);
  }
});

adminCouponsRouter.post('/', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createCouponSchema.parse(req.body);
    const coupon = await svc.createCoupon(data);
    sendSuccess(res, 201, coupon);
  } catch (err) {
    next(err);
  }
});

adminCouponsRouter.put('/:id', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateCouponSchema.parse(req.body);
    const coupon = await svc.updateCoupon(req.params.id!, data);
    sendSuccess(res, 200, coupon);
  } catch (err) {
    next(err);
  }
});

adminCouponsRouter.patch('/:id/status', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { isActive } = statusSchema.parse(req.body);
    const coupon = await svc.updateStatus(req.params.id!, isActive);
    sendSuccess(res, 200, coupon);
  } catch (err) {
    next(err);
  }
});

adminCouponsRouter.delete('/:id', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.deleteCoupon(req.params.id!);
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});
