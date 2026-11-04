import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { sendSuccess } from '../utils/response.js';
import { BadRequestError } from '../utils/appError.js';
import { authenticate } from '../middlewares/auth.js';
import { requireRole } from '../middlewares/role.js';

type TrajectoryPeriod = 'weekly' | 'monthly' | 'yearly';

interface DateRange {
  start?: Date;
  end?: Date;
}

interface TrajectoryBucket {
  key: string;
  label: string;
  revenue: number;
  orders: number;
}

const dashboardQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  period: z.enum(['weekly', 'monthly', 'yearly']).default('monthly'),
});

const exportQuerySchema = dashboardQuerySchema.extend({
  status: z
    .enum([
      'PENDING',
      'CONFIRMED',
      'PROCESSING',
      'SHIPPED',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'CANCELLED',
      'RETURNED',
      'REFUNDED',
    ])
    .optional(),
});

function resolveDateRange(startDate?: string, endDate?: string): DateRange {
  const start = startDate ? new Date(startDate) : undefined;
  const end = endDate ? new Date(endDate) : undefined;

  if (start && Number.isNaN(start.getTime())) {
    throw new BadRequestError('startDate must be a valid ISO date');
  }
  if (end && Number.isNaN(end.getTime())) {
    throw new BadRequestError('endDate must be a valid ISO date');
  }
  if (start && end && start > end) {
    throw new BadRequestError('startDate must be before or equal to endDate');
  }

  return { start, end };
}

function buildCreatedAtFilter(range: DateRange): Prisma.DateTimeFilter | undefined {
  if (!range.start && !range.end) return undefined;
  return {
    ...(range.start ? { gte: range.start } : {}),
    ...(range.end ? { lte: range.end } : {}),
  };
}

function orderRangeWhere(range: DateRange): Prisma.OrderWhereInput {
  const createdAt = buildCreatedAtFilter(range);
  return createdAt ? { createdAt } : {};
}

function monthNames(): string[] {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
}

function startOfWeek(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function bucketKey(date: Date, period: TrajectoryPeriod): string {
  if (period === 'yearly') return String(date.getFullYear());
  if (period === 'monthly') {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
  const week = startOfWeek(date);
  return `${week.getFullYear()}-${String(week.getMonth() + 1).padStart(2, '0')}-${String(
    week.getDate(),
  ).padStart(2, '0')}`;
}

function bucketLabel(key: string, period: TrajectoryPeriod): string {
  const names = monthNames();
  if (period === 'yearly') return key;
  if (period === 'monthly') {
    const [year, month] = key.split('-').map(Number);
    return `${names[month - 1]} ${year}`;
  }
  const [year, month, day] = key.split('-').map(Number);
  return `${names[month - 1]} ${day}, ${year}`;
}

function buildBuckets(period: TrajectoryPeriod, range: DateRange): {
  buckets: Map<string, TrajectoryBucket>;
  queryStart: Date;
  queryEnd: Date;
} {
  const buckets = new Map<string, TrajectoryBucket>();
  const now = new Date();
  const end = range.end ?? now;

  if (range.start) {
    const cursor = new Date(range.start);
    if (period === 'weekly') {
      cursor.setTime(startOfWeek(cursor).getTime());
    } else if (period === 'monthly') {
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
    } else {
      cursor.setMonth(0, 1);
      cursor.setHours(0, 0, 0, 0);
    }

    while (cursor <= end) {
      const key = bucketKey(cursor, period);
      buckets.set(key, { key, label: bucketLabel(key, period), revenue: 0, orders: 0 });
      if (period === 'weekly') cursor.setDate(cursor.getDate() + 7);
      else if (period === 'monthly') cursor.setMonth(cursor.getMonth() + 1);
      else cursor.setFullYear(cursor.getFullYear() + 1);
    }

    return { buckets, queryStart: range.start, queryEnd: end };
  }

  const count = period === 'weekly' ? 12 : period === 'yearly' ? 5 : 6;

  if (period === 'weekly') {
    const first = startOfWeek(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    first.setDate(first.getDate() - (count - 1) * 7);
    for (let i = 0; i < count; i++) {
      const cursor = new Date(first);
      cursor.setDate(first.getDate() + i * 7);
      const key = bucketKey(cursor, period);
      buckets.set(key, { key, label: bucketLabel(key, period), revenue: 0, orders: 0 });
    }
    return { buckets, queryStart: first, queryEnd: end };
  }

  if (period === 'yearly') {
    const firstYear = now.getFullYear() - (count - 1);
    for (let i = 0; i < count; i++) {
      const year = firstYear + i;
      const key = String(year);
      buckets.set(key, { key, label: key, revenue: 0, orders: 0 });
    }
    return { buckets, queryStart: new Date(firstYear, 0, 1), queryEnd: end };
  }

  const firstMonth = new Date(now.getFullYear(), now.getMonth() - (count - 1), 1);
  for (let i = 0; i < count; i++) {
    const cursor = new Date(firstMonth.getFullYear(), firstMonth.getMonth() + i, 1);
    const key = bucketKey(cursor, period);
    buckets.set(key, { key, label: bucketLabel(key, period), revenue: 0, orders: 0 });
  }
  return { buckets, queryStart: firstMonth, queryEnd: end };
}

function extractLocation(address: Prisma.JsonValue | null): string {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return '';
  const record = address as Record<string, unknown>;
  const value = record.city ?? record.country;
  return typeof value === 'string' ? value : '';
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export class AdminDashboardService {
  static async getDashboardStats(filters: z.infer<typeof dashboardQuerySchema>) {
    const range = resolveDateRange(filters.startDate, filters.endDate);
    const rangeWhere = orderRangeWhere(range);

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalOrdersCount,
      pendingOrdersCount,
      revenueAggregation,
      todayRevenueAggregation,
      todayOrdersCount,
      activeProductsCount,
      productsAddedThisWeekCount,
      activeCategoriesCount,
      totalCustomersCount,
      recentProducts,
      recentOrders,
      lowStockProducts,
      allProductsStockAggregation,
      lowStockCount,
      criticalStockCount,
      ordersForTrajectory,
    ] = await Promise.all([
      prisma.order.count({ where: rangeWhere }),
      prisma.order.count({
        where: { ...rangeWhere, status: { in: ['PENDING', 'CONFIRMED', 'PROCESSING'] } },
      }),
      prisma.order.aggregate({
        _sum: { totalAmount: true },
        where: { ...rangeWhere, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
      }),
      prisma.order.aggregate({
        _sum: { totalAmount: true },
        where: {
          createdAt: { gte: startOfToday },
          status: { notIn: ['CANCELLED', 'REFUNDED'] },
        },
      }),
      prisma.order.count({ where: { createdAt: { gte: startOfToday } } }),
      prisma.product.count({ where: { isActive: true, isArchived: false } }),
      prisma.product.count({ where: { createdAt: { gte: sevenDaysAgo }, isArchived: false } }),
      prisma.category.count({ where: { isActive: true } }),
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.product.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        where: { isArchived: false },
        include: {
          category: { select: { id: true, name: true, slug: true } },
          images: { take: 1, orderBy: { sortOrder: 'asc' } },
        },
      }),
      prisma.order.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          items: { take: 3 },
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      }),
      prisma.product.findMany({
        take: 5,
        where: { stock: { lte: 10 }, isArchived: false },
        orderBy: { stock: 'asc' },
        include: {
          category: { select: { name: true } },
          variants: { take: 2 },
        },
      }),
      prisma.product.aggregate({ _sum: { stock: true } }),
      prisma.product.count({ where: { stock: { gt: 0, lte: 5 }, isArchived: false } }),
      prisma.product.count({ where: { stock: { lte: 0 }, isArchived: false } }),
      this.getSalesTrajectory(filters.period, range),
    ]);

    const totalRevenue = Number(revenueAggregation._sum.totalAmount || 0);
    const todayRevenue = Number(todayRevenueAggregation._sum.totalAmount || 0);
    const totalInventoryStock = Number(allProductsStockAggregation._sum.stock || 0);
    const aov = totalOrdersCount > 0 ? totalRevenue / totalOrdersCount : 0;

    return {
      range: {
        startDate: range.start?.toISOString() ?? null,
        endDate: range.end?.toISOString() ?? null,
        period: filters.period,
      },
      kpi: {
        totalRevenue,
        todayRevenue,
        todayOrdersCount,
        totalOrders: totalOrdersCount,
        pendingOrders: pendingOrdersCount,
        activeCatalog: activeProductsCount,
        newProductsThisWeek: productsAddedThisWeekCount,
        activeCategories: activeCategoriesCount,
        totalClients: totalCustomersCount,
        aov,
        totalInventoryStock,
        lowStockItems: lowStockCount,
        criticalStockUnits: criticalStockCount,
      },
      salesTrajectory: ordersForTrajectory,
      lowStockAlerts: lowStockProducts.map((p) => ({
        id: p.id,
        title: p.title,
        sku: p.sku,
        stock: p.stock,
        categoryName: p.category?.name || 'General',
        variantInfo:
          p.variants.length > 0 ? p.variants.map((v) => v.title).join(', ') : 'Standard Unit',
      })),
      recentProducts: recentProducts.map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        sku: p.sku,
        basePrice: Number(p.basePrice),
        stock: p.stock,
        category: p.category
          ? { id: p.category.id, name: p.category.name, slug: p.category.slug }
          : null,
        imageUrl: p.images[0]?.url || null,
        isActive: p.isActive,
        createdAt: p.createdAt,
      })),
      recentOrders: recentOrders.map((o) => {
        const clientName =
          o.customerName ||
          [o.user?.firstName, o.user?.lastName].filter(Boolean).join(' ') ||
          o.user?.email ||
          'Guest Client';

        return {
          id: o.id,
          orderNumber: o.orderNumber,
          totalAmount: Number(o.totalAmount),
          status: o.status,
          itemCount: o.items.reduce((sum, item) => sum + item.quantity, 0),
          clientName,
          clientEmail: o.customerEmail || o.user?.email || '',
          location: extractLocation(o.shippingAddress) || 'Atelier Direct',
          createdAt: o.createdAt,
        };
      }),
    };
  }

  static async getSalesTrajectory(period: TrajectoryPeriod, range: DateRange) {
    const { buckets, queryStart, queryEnd } = buildBuckets(period, range);

    const orders = await prisma.order.findMany({
      where: {
        createdAt: { gte: queryStart, lte: queryEnd },
        status: { notIn: ['CANCELLED', 'REFUNDED'] },
      },
      select: { createdAt: true, totalAmount: true },
    });

    for (const order of orders) {
      const key = bucketKey(order.createdAt, period);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.revenue += Number(order.totalAmount);
        bucket.orders += 1;
      }
    }

    return Array.from(buckets.values()).map((bucket) => ({
      label: bucket.label,
      revenue: Math.round(bucket.revenue * 100) / 100,
      orders: bucket.orders,
    }));
  }

  static async getFinancialReportCsv(filters: z.infer<typeof exportQuerySchema>) {
    const range = resolveDateRange(filters.startDate, filters.endDate);
    const where: Prisma.OrderWhereInput = {
      ...orderRangeWhere(range),
      ...(filters.status ? { status: filters.status } : {}),
    };

    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        items: { select: { quantity: true } },
        payments: { select: { status: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    const header = [
      'Order Number',
      'Created At',
      'Status',
      'Payment Status',
      'Customer Name',
      'Customer Email',
      'Item Units',
      'Subtotal',
      'Discount',
      'Shipping',
      'Tax',
      'Total',
      'Currency',
    ];

    const rows = orders.map((order) => [
      order.orderNumber,
      order.createdAt.toISOString(),
      order.status,
      order.payments[0]?.status ?? '',
      order.customerName,
      order.customerEmail,
      order.items.reduce((sum, item) => sum + item.quantity, 0),
      Number(order.subtotal),
      Number(order.discountAmount),
      Number(order.shippingAmount),
      Number(order.taxAmount),
      Number(order.totalAmount),
      order.currency,
    ]);

    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');

    return {
      csv,
      filename: `financial-report-${new Date().toISOString().slice(0, 10)}.csv`,
      count: orders.length,
    };
  }
}

export const adminDashboardRouter = Router();

adminDashboardRouter.get(
  '/dashboard/stats',
  authenticate,
  requireRole(['ADMIN', 'STAFF']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = dashboardQuerySchema.parse(req.query);
      const stats = await AdminDashboardService.getDashboardStats(query);
      sendSuccess(res, 200, stats);
    } catch (err) {
      next(err);
    }
  },
);

adminDashboardRouter.get(
  '/dashboard/export',
  authenticate,
  requireRole(['ADMIN', 'STAFF']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = exportQuerySchema.parse(req.query);
      const report = await AdminDashboardService.getFinancialReportCsv(query);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
      res.status(200).send(report.csv);
    } catch (err) {
      next(err);
    }
  },
);
