import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authenticate } from '../../middlewares/auth.js';
import { requireRole } from '../../middlewares/role.js';
import { prisma } from '../../lib/prisma.js';
import { sendSuccess } from '../../utils/response.js';
import { AppError, BadRequestError } from '../../utils/appError.js';

// ── Validation Schemas ───────────────────────────────────────────────────────

const listCustomersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  isActive: z.enum(['all', 'true', 'false']).default('all'),
  sortBy: z.enum(['createdAt', 'name', 'email', 'lastLoginAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const customerOrdersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const updateStatusSchema = z.object({
  isActive: z.boolean(),
});

// ── Serialization Helpers ────────────────────────────────────────────────────

function latestPaymentStatus(
  payments: { status: string; createdAt: Date }[],
): string | null {
  if (payments.length === 0) return null;
  return [...payments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!.status;
}

// ── Service Class ────────────────────────────────────────────────────────────

export class AdminCustomersService {
  async listCustomers(query: z.infer<typeof listCustomersSchema>) {
    const { page, limit, search, isActive, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = {
      role: 'CUSTOMER',
      ...(isActive !== 'all' ? { isActive: isActive === 'true' } : {}),
    };

    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const orderBy: Prisma.UserOrderByWithRelationInput[] =
      sortBy === 'name'
        ? [{ firstName: sortOrder }, { lastName: sortOrder }]
        : [{ [sortBy]: sortOrder }];

    const [customers, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          isActive: true,
          isEmailVerified: true,
          authProvider: true,
          lastLoginAt: true,
          createdAt: true,
          _count: { select: { orders: true, reviews: true } },
          orders: {
            select: { totalAmount: true, createdAt: true },
            where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
            orderBy: { createdAt: 'desc' },
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);
    const result = customers.map(({ orders, ...customer }) => ({
      ...customer,
      totalSpent: orders.reduce((sum, order) => sum + Number(order.totalAmount), 0),
      lastOrderAt: orders[0]?.createdAt ?? null,
    }));

    return {
      customers: result,
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

  async getCustomer(id: string, ordersQuery: z.infer<typeof customerOrdersSchema>) {
    const customer = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        isEmailVerified: true,
        authProvider: true,
        lastLoginAt: true,
        createdAt: true,
        addresses: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] },
        _count: { select: { orders: true, reviews: true, returnRequests: true } },
      },
    });

    if (!customer) throw new AppError('Customer not found', 404, 'NOT_FOUND');
    if (customer.role !== 'CUSTOMER') {
      throw new AppError('This account is not a customer account', 403, 'FORBIDDEN');
    }

    const { page, limit } = ordersQuery;
    const skip = (page - 1) * limit;

    const [orders, totalOrders, spendAggregate, statusGroups, lastOrder, reviews, reviewAggregate] =
      await Promise.all([
        prisma.order.findMany({
          where: { userId: id },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            totalAmount: true,
            currency: true,
            createdAt: true,
            _count: { select: { items: true } },
            payments: {
              select: { status: true, createdAt: true },
              orderBy: { createdAt: 'desc' },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.order.count({ where: { userId: id } }),
        prisma.order.aggregate({
          _sum: { totalAmount: true },
          _avg: { totalAmount: true },
          where: {
            userId: id,
            status: { notIn: ['CANCELLED', 'REFUNDED'] },
          },
        }),
        prisma.order.groupBy({
          by: ['status'],
          _count: { _all: true },
          where: { userId: id },
        }),
        prisma.order.findFirst({
          where: { userId: id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        prisma.review.findMany({
          where: { userId: id },
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            product: { select: { id: true, title: true, slug: true } },
          },
        }),
        prisma.review.aggregate({
          _avg: { rating: true },
          _count: { _all: true },
          where: { userId: id },
        }),
      ]);

    const totalPages = Math.ceil(totalOrders / limit);
    const ordersWithPaymentStatus = orders.map(({ payments, ...order }) => ({
      ...order,
      totalAmount: Number(order.totalAmount),
      itemCount: order._count.items,
      paymentStatus: latestPaymentStatus(payments),
    }));

    return {
      customer,
      stats: {
        totalOrders,
        totalSpent: Number(spendAggregate._sum.totalAmount ?? 0),
        averageOrderValue: Number(spendAggregate._avg.totalAmount ?? 0),
        lastOrderAt: lastOrder?.createdAt ?? null,
        ordersByStatus: Object.fromEntries(
          statusGroups.map((group) => [group.status, group._count._all]),
        ),
        reviewCount: reviewAggregate._count._all,
        averageReviewRating: reviewAggregate._avg.rating
          ? Math.round(reviewAggregate._avg.rating * 10) / 10
          : null,
      },
      orders: ordersWithPaymentStatus,
      ordersMeta: {
        page,
        limit,
        total: totalOrders,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
      reviews,
    };
  }

  async updateStatus(id: string, data: z.infer<typeof updateStatusSchema>) {
    const customer = await prisma.user.findUnique({ where: { id } });
    if (!customer) throw new AppError('Customer not found', 404, 'NOT_FOUND');
    if (customer.role !== 'CUSTOMER') {
      throw new BadRequestError('Only customer accounts can be suspended or reactivated here');
    }
    if (!data.isActive && !customer.isActive) {
      throw new BadRequestError('Customer account is already suspended');
    }
    if (data.isActive && customer.isActive) {
      throw new BadRequestError('Customer account is already active');
    }

    return prisma.user.update({
      where: { id },
      data: { isActive: data.isActive },
      select: { id: true, email: true, firstName: true, lastName: true, isActive: true },
    });
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export const adminCustomersRouter = Router();
const svc = new AdminCustomersService();
const adminGuard = [authenticate, requireRole(['ADMIN', 'STAFF'])];

adminCustomersRouter.get('/', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listCustomersSchema.parse(req.query);
    const result = await svc.listCustomers(query);
    sendSuccess(res, 200, result.customers, result.meta);
  } catch (err) {
    next(err);
  }
});

adminCustomersRouter.get('/:id', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ordersQuery = customerOrdersSchema.parse(req.query);
    const result = await svc.getCustomer(req.params.id!, ordersQuery);
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});

adminCustomersRouter.patch(
  '/:id/status',
  ...adminGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = updateStatusSchema.parse(req.body);
      const result = await svc.updateStatus(req.params.id!, data);
      sendSuccess(res, 200, result);
    } catch (err) {
      next(err);
    }
  },
);
