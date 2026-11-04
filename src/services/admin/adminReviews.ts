import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authenticate } from '../../middlewares/auth.js';
import { requireRole } from '../../middlewares/role.js';
import { prisma } from '../../lib/prisma.js';
import { sendSuccess } from '../../utils/response.js';
import { AppError, BadRequestError } from '../../utils/appError.js';

// ── Validation Schemas ───────────────────────────────────────────────────────

const listReviewsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['all', 'approved', 'pending']).default('all'),
  productId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  verified: z.enum(['all', 'true', 'false']).default('all'),
  search: z.string().trim().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  sortBy: z.enum(['createdAt', 'rating']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const approveSchema = z.object({
  isApproved: z.boolean(),
});

// ── Service Class ────────────────────────────────────────────────────────────

export class AdminReviewsService {
  async listReviews(query: z.infer<typeof listReviewsSchema>) {
    const {
      page,
      limit,
      status,
      productId,
      userId,
      rating,
      verified,
      search,
      startDate,
      endDate,
      sortBy,
      sortOrder,
    } = query;
    const skip = (page - 1) * limit;

    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestError('startDate must be before or equal to endDate');
    }

    const where: Prisma.ReviewWhereInput = {};
    if (status === 'approved') where.isApproved = true;
    if (status === 'pending') where.isApproved = false;
    if (productId) where.productId = productId;
    if (userId) where.userId = userId;
    if (rating) where.rating = rating;
    if (verified !== 'all') where.isVerifiedPurchase = verified === 'true';
    if (startDate || endDate) {
      where.createdAt = {
        ...(startDate ? { gte: startDate } : {}),
        ...(endDate ? { lte: endDate } : {}),
      };
    }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { comment: { contains: search, mode: 'insensitive' } },
        { product: { title: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { user: { firstName: { contains: search, mode: 'insensitive' } } },
        { user: { lastName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        include: {
          product: { select: { id: true, title: true, slug: true, sku: true } },
          user: {
            select: { id: true, firstName: true, lastName: true, email: true, isActive: true },
          },
        },
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: limit,
      }),
      prisma.review.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);
    return {
      reviews,
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

  async getStats() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [approvalGroups, ratingGroups, aggregate, recentCount] = await Promise.all([
      prisma.review.groupBy({
        by: ['isApproved'],
        _count: { _all: true },
      }),
      prisma.review.groupBy({
        by: ['rating'],
        _count: { _all: true },
      }),
      prisma.review.aggregate({
        _avg: { rating: true },
        _count: { _all: true },
      }),
      prisma.review.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    ]);

    const approved = approvalGroups.find((group) => group.isApproved)?._count._all ?? 0;
    const pending = approvalGroups.find((group) => !group.isApproved)?._count._all ?? 0;

    return {
      total: aggregate._count._all,
      approved,
      pending,
      newThisWeek: recentCount,
      averageRating: aggregate._avg.rating
        ? Math.round(aggregate._avg.rating * 10) / 10
        : null,
      ratingBreakdown: Object.fromEntries(
        [5, 4, 3, 2, 1].map((rating) => [
          rating,
          ratingGroups.find((group) => group.rating === rating)?._count._all ?? 0,
        ]),
      ),
    };
  }

  async approveReview(id: string, data: z.infer<typeof approveSchema>) {
    const review = await prisma.review.findUnique({ where: { id } });
    if (!review) throw new AppError('Review not found', 404, 'NOT_FOUND');

    if (review.isApproved === data.isApproved) {
      return review;
    }

    return prisma.review.update({
      where: { id },
      data: { isApproved: data.isApproved },
      include: {
        product: { select: { id: true, title: true, slug: true, sku: true } },
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
  }

  async deleteReview(id: string) {
    const review = await prisma.review.findUnique({ where: { id } });
    if (!review) throw new AppError('Review not found', 404, 'NOT_FOUND');

    await prisma.review.delete({ where: { id } });
    return { message: 'Review deleted successfully' };
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export const adminReviewsRouter = Router();
const svc = new AdminReviewsService();
const adminGuard = [authenticate, requireRole(['ADMIN', 'STAFF'])];

adminReviewsRouter.get('/stats', ...adminGuard, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await svc.getStats();
    sendSuccess(res, 200, stats);
  } catch (err) {
    next(err);
  }
});

adminReviewsRouter.get('/', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listReviewsSchema.parse(req.query);
    const result = await svc.listReviews(query);
    sendSuccess(res, 200, result.reviews, result.meta);
  } catch (err) {
    next(err);
  }
});

adminReviewsRouter.patch('/:id/approve', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = approveSchema.parse(req.body);
    const review = await svc.approveReview(req.params.id!, data);
    sendSuccess(res, 200, review);
  } catch (err) {
    next(err);
  }
});

adminReviewsRouter.delete('/:id', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.deleteReview(req.params.id!);
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});
