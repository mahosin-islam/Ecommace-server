import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { DiscountType, Prisma } from '@prisma/client';
import { authenticate } from '../middlewares/auth.js';
import { prisma } from '../lib/prisma.js';
import { sendSuccess } from '../utils/response.js';
import { BadRequestError } from '../utils/appError.js';

type CouponDb = Pick<Prisma.TransactionClient, 'coupon' | 'couponUsage'>;

export interface CouponEvaluation {
  couponId: string;
  code: string;
  discountType: DiscountType;
  discountValue: number;
  discountAmount: number;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export async function evaluateCoupon(
  db: CouponDb,
  rawCode: string,
  subtotal: number,
  userId?: string | null,
): Promise<CouponEvaluation> {
  const code = normalizeCode(rawCode);
  const coupon = await db.coupon.findUnique({ where: { code } });

  if (!coupon || !coupon.isActive) {
    throw new BadRequestError('Coupon code is invalid or inactive');
  }

  const now = new Date();
  if (coupon.startDate > now) {
    throw new BadRequestError('Coupon is not active yet');
  }
  if (coupon.endDate < now) {
    throw new BadRequestError('Coupon has expired');
  }
  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    throw new BadRequestError('Coupon usage limit has been reached');
  }

  const minimum = coupon.minOrderAmount ? Number(coupon.minOrderAmount) : 0;
  if (subtotal < minimum) {
    throw new BadRequestError(`Coupon requires a minimum order of ${minimum.toFixed(2)}`);
  }

  if (userId) {
    const userUsages = await db.couponUsage.count({
      where: { couponId: coupon.id, userId },
    });
    if (userUsages >= coupon.perUserLimit) {
      throw new BadRequestError('You have reached the usage limit for this coupon');
    }
  }

  const value = Number(coupon.discountValue);
  let discount =
    coupon.discountType === DiscountType.PERCENTAGE ? (subtotal * value) / 100 : value;

  if (coupon.maxDiscountAmount) {
    discount = Math.min(discount, Number(coupon.maxDiscountAmount));
  }
  discount = Math.min(discount, subtotal);
  discount = Math.round(discount * 100) / 100;

  if (discount <= 0) {
    throw new BadRequestError('Coupon does not apply to this order');
  }

  return {
    couponId: coupon.id,
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue: value,
    discountAmount: discount,
  };
}

const validateCouponSchema = z.object({
  code: z.string().min(1).max(50),
  subtotal: z.number().nonnegative(),
});

export const couponRouter = Router();

couponRouter.post('/validate', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, subtotal } = validateCouponSchema.parse(req.body);
    const evaluation = await evaluateCoupon(prisma, code, subtotal, req.user!.id);
    sendSuccess(res, 200, {
      ...evaluation,
      subtotal,
      totalAfterDiscount: Math.round((subtotal - evaluation.discountAmount) * 100) / 100,
    });
  } catch (err) {
    next(err);
  }
});
