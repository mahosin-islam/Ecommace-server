import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/auth.js';
import { requireRole } from '../../middlewares/role.js';
import { prisma } from '../../lib/prisma.js';
import { sendSuccess } from '../../utils/response.js';
import { AppError, BadRequestError } from '../../utils/appError.js';
import { OrderStatus, PaymentStatus, Prisma, StockMovementType } from '@prisma/client';
import { stripeProvider } from '../payment/stripeProvider.js';

// ── Validation Schemas ───────────────────────────────────────────────────────

const listOrdersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.nativeEnum(OrderStatus).optional(),
  paymentStatus: z.nativeEnum(PaymentStatus).optional(),
  search: z.string().trim().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  sortBy: z.enum(['createdAt', 'totalAmount', 'status']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const updateStatusSchema = z.object({
  status: z.nativeEnum(OrderStatus),
  trackingNumber: z.string().max(120).optional(),
  carrier: z.string().max(120).optional(),
  shippingMethod: z.string().max(120).optional(),
  note: z.string().max(1000).optional(),
  adminNotes: z.string().max(1000).optional(),
});

const cancelOrderSchema = z.object({
  reason: z.string().min(1).max(500),
});

const refundOrderSchema = z.object({
  reason: z.string().min(1).max(500),
  restock: z.boolean().default(true),
  providerRefund: z.boolean().default(true),
});

const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['OUT_FOR_DELIVERY', 'DELIVERED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED', 'REFUNDED'],
  RETURNED: ['REFUNDED'],
  CANCELLED: [],
  REFUNDED: [],
};

const CANCELLABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
];

// ── Serialization Helpers ────────────────────────────────────────────────────

function asRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, Prisma.JsonValue>;
}

function readCarrier(address: Prisma.JsonValue | null): string | null {
  const value = asRecord(address).carrier;
  return typeof value === 'string' ? value : null;
}

function withCarrier(
  address: Prisma.JsonValue,
  carrier: string | undefined,
): Prisma.InputJsonValue | undefined {
  if (carrier === undefined) return undefined;
  const next = { ...asRecord(address) };
  if (carrier === '') delete next.carrier;
  else next.carrier = carrier;
  return next as Prisma.InputJsonValue;
}

function appendNote(existing: string | null, addition: string): string {
  return existing ? `${existing}\n${addition}` : addition;
}

function latestPaymentStatus(
  payments: { status: PaymentStatus; createdAt: Date }[],
): PaymentStatus | null {
  if (payments.length === 0) return null;
  return [...payments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!.status;
}

function serializeOrder<
  T extends {
    subtotal: unknown;
    discountAmount: unknown;
    shippingAmount: unknown;
    taxAmount: unknown;
    totalAmount: unknown;
    shippingAddress: Prisma.JsonValue;
    payments: { amount: unknown; status: PaymentStatus; createdAt: Date }[];
    items?: { unitPrice: unknown; subtotal: unknown; taxAmount: unknown; discountAmount: unknown; total: unknown }[];
  },
>(order: T) {
  return {
    ...order,
    subtotal: Number(order.subtotal),
    discountAmount: Number(order.discountAmount),
    shippingAmount: Number(order.shippingAmount),
    taxAmount: Number(order.taxAmount),
    totalAmount: Number(order.totalAmount),
    carrier: readCarrier(order.shippingAddress),
    paymentStatus: latestPaymentStatus(order.payments),
    payments: order.payments.map((payment) => ({
      ...payment,
      amount: Number(payment.amount),
    })),
    items: order.items?.map((item) => ({
      ...item,
      unitPrice: Number(item.unitPrice),
      subtotal: Number(item.subtotal),
      taxAmount: Number(item.taxAmount),
      discountAmount: Number(item.discountAmount),
      total: Number(item.total),
    })),
  };
}

// ── Inventory Helpers ────────────────────────────────────────────────────────

async function restoreInventory(
  tx: Prisma.TransactionClient,
  orderId: string,
  orderNumber: string,
  userId: string,
  reason: string,
) {
  const items = await tx.orderItem.findMany({
    where: { orderId },
    include: { product: true, variant: true },
  });
  const variantProductIds = new Set<string>();

  for (const item of items) {
    if (!item.productId) continue;

    if (item.variantId && item.variant) {
      const variant = await tx.productVariant.findUnique({ where: { id: item.variantId } });
      if (!variant) continue;

      const updated = await tx.productVariant.update({
        where: { id: item.variantId },
        data: { stock: { increment: item.quantity } },
      });

      await tx.inventoryLog.create({
        data: {
          productId: item.productId,
          variantId: item.variantId,
          type: StockMovementType.RETURN_RESTOCK,
          quantityChange: item.quantity,
          previousStock: variant.stock,
          newStock: updated.stock,
          referenceId: orderId,
          note: `Order ${orderNumber}: ${reason}`,
          createdByUserId: userId,
        },
      });
      variantProductIds.add(item.productId);
      continue;
    }

    const product = await tx.product.findUnique({ where: { id: item.productId } });
    if (!product) continue;

    const updated = await tx.product.update({
      where: { id: item.productId },
      data: { stock: { increment: item.quantity } },
    });

    await tx.inventoryLog.create({
      data: {
        productId: item.productId,
        type: StockMovementType.RETURN_RESTOCK,
        quantityChange: item.quantity,
        previousStock: product.stock,
        newStock: updated.stock,
        referenceId: orderId,
        note: `Order ${orderNumber}: ${reason}`,
        createdByUserId: userId,
      },
    });
  }

  for (const productId of variantProductIds) {
    const activeVariants = await tx.productVariant.findMany({
      where: { productId, isActive: true },
      select: { stock: true },
    });
    await tx.product.update({
      where: { id: productId },
      data: { stock: activeVariants.reduce((sum, variant) => sum + variant.stock, 0) },
    });
  }
}

async function releaseCouponUsage(tx: Prisma.TransactionClient, orderId: string) {
  const usages = await tx.couponUsage.findMany({
    where: { orderId },
    select: { couponId: true },
  });
  if (usages.length === 0) return;

  await tx.couponUsage.deleteMany({ where: { orderId } });
  for (const couponId of new Set(usages.map((usage) => usage.couponId))) {
    await tx.coupon.updateMany({
      where: { id: couponId, usageCount: { gt: 0 } },
      data: { usageCount: { decrement: 1 } },
    });
  }
}

// ── Service Class ────────────────────────────────────────────────────────────

export class AdminOrdersService {
  async listOrders(query: z.infer<typeof listOrdersSchema>) {
    const { page, limit, status, paymentStatus, search, startDate, endDate, sortBy, sortOrder } =
      query;
    const skip = (page - 1) * limit;

    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestError('startDate must be before or equal to endDate');
    }

    const where: Prisma.OrderWhereInput = {};
    if (status) where.status = status;
    if (paymentStatus) where.payments = { some: { status: paymentStatus } };
    if (startDate || endDate) {
      where.createdAt = {
        ...(startDate ? { gte: startDate } : {}),
        ...(endDate ? { lte: endDate } : {}),
      };
    }
    if (search) {
      where.OR = [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { customerName: { contains: search, mode: 'insensitive' } },
        { customerEmail: { contains: search, mode: 'insensitive' } },
        { customerPhone: { contains: search, mode: 'insensitive' } },
        { trackingNumber: { contains: search, mode: 'insensitive' } },
        { user: { firstName: { contains: search, mode: 'insensitive' } } },
        { user: { lastName: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.order.findMany({
        where,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          totalAmount: true,
          currency: true,
          customerName: true,
          customerEmail: true,
          shippingAddress: true,
          shippingMethod: true,
          trackingNumber: true,
          createdAt: true,
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
          _count: { select: { items: true } },
          payments: {
            select: { status: true, provider: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
          },
        },
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);
    const orders = rows.map((order) => {
      const location = asRecord(order.shippingAddress);
      return {
        ...order,
        totalAmount: Number(order.totalAmount),
        destination:
          [location.city, location.country].filter((value) => typeof value === 'string').join(', ') ||
          null,
        carrier: readCarrier(order.shippingAddress),
        itemCount: order._count.items,
        paymentStatus: latestPaymentStatus(order.payments),
        paymentProvider: order.payments[0]?.provider ?? null,
      };
    });

    return {
      orders,
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

  async getOrder(id: string) {
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        items: {
          include: {
            product: { select: { id: true, title: true, sku: true } },
            variant: { select: { id: true, sku: true, attributes: true } },
          },
        },
        payments: { orderBy: { createdAt: 'desc' } },
        statusHistory: {
          include: { changedByUser: { select: { firstName: true, lastName: true, email: true } } },
          orderBy: { createdAt: 'asc' },
        },
        couponUsages: { include: { coupon: { select: { id: true, code: true } } } },
        returnRequests: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND');
    return serializeOrder(order);
  }

  async updateStatus(id: string, data: z.infer<typeof updateStatusSchema>, userId: string) {
    if (data.status === OrderStatus.CANCELLED) {
      throw new BadRequestError('Use the cancel endpoint to cancel an order and restore inventory');
    }
    if (data.status === OrderStatus.REFUNDED) {
      throw new BadRequestError('Use the refund endpoint to refund an order and restore inventory');
    }

    await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id } });
      if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND');

      if (order.status === data.status) {
        throw new BadRequestError(`Order is already ${data.status}`);
      }

      const allowed = ALLOWED_TRANSITIONS[order.status];
      if (!allowed.includes(data.status)) {
        throw new BadRequestError(`Invalid status transition: ${order.status} -> ${data.status}`);
      }

      const nextTracking =
        data.trackingNumber !== undefined
          ? data.trackingNumber || null
          : order.trackingNumber;

      if (
        (data.status === OrderStatus.SHIPPED || data.status === OrderStatus.OUT_FOR_DELIVERY) &&
        !nextTracking
      ) {
        throw new BadRequestError('A tracking number is required when shipping an order');
      }

      const shippingAddress = withCarrier(order.shippingAddress, data.carrier);

      await tx.order.update({
        where: { id },
        data: {
          status: data.status,
          ...(data.trackingNumber !== undefined ? { trackingNumber: nextTracking } : {}),
          ...(data.shippingMethod !== undefined
            ? { shippingMethod: data.shippingMethod || null }
            : {}),
          ...(shippingAddress !== undefined ? { shippingAddress } : {}),
          ...(data.adminNotes !== undefined ? { adminNotes: data.adminNotes || null } : {}),
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          fromStatus: order.status,
          toStatus: data.status,
          note: data.note,
          changedByUserId: userId,
        },
      });

      if (data.status === OrderStatus.DELIVERED) {
        await tx.payment.updateMany({
          where: { orderId: id, provider: 'cod', status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.CAPTURED },
        });
      }
    });

    return this.getOrder(id);
  }

  async cancelOrder(id: string, data: z.infer<typeof cancelOrderSchema>, userId: string) {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id },
        include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND');

      if (order.status === OrderStatus.CANCELLED) {
        return { alreadyCancelled: true, orderNumber: order.orderNumber };
      }
      if (!CANCELLABLE_STATUSES.includes(order.status)) {
        throw new BadRequestError(
          `Cannot cancel an order with status ${order.status}. Use the refund flow instead.`,
        );
      }

      const paymentStatus = order.payments[0]?.status;
      if (
        paymentStatus === PaymentStatus.CAPTURED ||
        paymentStatus === PaymentStatus.PARTIALLY_REFUNDED
      ) {
        throw new BadRequestError(
          'Captured payments must be refunded instead of cancelled. Use the refund endpoint.',
        );
      }

      await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.CANCELLED,
          adminNotes: appendNote(order.adminNotes, `Cancelled: ${data.reason}`),
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          fromStatus: order.status,
          toStatus: OrderStatus.CANCELLED,
          note: data.reason,
          changedByUserId: userId,
        },
      });

      await tx.payment.updateMany({
        where: {
          orderId: id,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.AUTHORIZED] },
        },
        data: { status: PaymentStatus.FAILED, errorMessage: 'Order cancelled' },
      });

      await restoreInventory(tx, id, order.orderNumber, userId, 'cancelled');
      await releaseCouponUsage(tx, id);

      return { alreadyCancelled: false, orderNumber: order.orderNumber };
    });

    return {
      message: result.alreadyCancelled
        ? `Order ${result.orderNumber} was already cancelled`
        : 'Order cancelled and inventory restored',
      order: await this.getOrder(id),
    };
  }

  async refundOrder(id: string, data: z.infer<typeof refundOrderSchema>, userId: string) {
    const order = await prisma.order.findUnique({
      where: { id },
      include: { payments: { orderBy: { createdAt: 'desc' } } },
    });
    if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND');

    if (order.status === OrderStatus.REFUNDED) {
      return {
        message: `Order ${order.orderNumber} was already refunded`,
        order: await this.getOrder(id),
      };
    }

    const refundableStatuses: OrderStatus[] = [
      OrderStatus.DELIVERED,
      OrderStatus.RETURNED,
      OrderStatus.CANCELLED,
    ];
    if (!refundableStatuses.includes(order.status)) {
      throw new BadRequestError(
        `Order status ${order.status} is not refundable. Deliver or cancel the order first.`,
      );
    }

    const payment = order.payments.find(
      (item) =>
        item.status === PaymentStatus.CAPTURED ||
        item.status === PaymentStatus.PARTIALLY_REFUNDED,
    );
    if (!payment) {
      throw new BadRequestError('No captured payment is available to refund');
    }

    let providerPayload: Record<string, unknown> | undefined;
    if (data.providerRefund && payment.provider === 'stripe' && payment.transactionId) {
      const refund = await stripeProvider.refundPayment(payment.transactionId);
      providerPayload = refund.rawPayload;
    } else if (data.providerRefund && ['bkash', 'nagad'].includes(payment.provider)) {
      throw new AppError(
        `${payment.provider} refunds are not available yet`,
        503,
        'PROVIDER_UNAVAILABLE',
      );
    }

    await prisma.$transaction(async (tx) => {
      const current = await tx.order.findUnique({ where: { id } });
      if (!current) throw new AppError('Order not found', 404, 'NOT_FOUND');
      if (current.status === OrderStatus.REFUNDED) return;

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.REFUNDED,
          ...(providerPayload ? { rawPayload: providerPayload as Prisma.InputJsonValue } : {}),
        },
      });

      await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.REFUNDED,
          adminNotes: appendNote(current.adminNotes, `Refunded: ${data.reason}`),
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          fromStatus: current.status,
          toStatus: OrderStatus.REFUNDED,
          note: data.reason,
          changedByUserId: userId,
        },
      });

      if (data.restock && current.status !== OrderStatus.CANCELLED) {
        await restoreInventory(tx, id, current.orderNumber, userId, 'refunded');
      }
      await releaseCouponUsage(tx, id);
    });

    return {
      message: 'Order refunded successfully',
      order: await this.getOrder(id),
    };
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export const adminOrdersRouter = Router();
const svc = new AdminOrdersService();
const adminGuard = [authenticate, requireRole(['ADMIN', 'STAFF'])];

adminOrdersRouter.get('/', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listOrdersSchema.parse(req.query);
    const result = await svc.listOrders(query);
    sendSuccess(res, 200, result.orders, result.meta);
  } catch (err) {
    next(err);
  }
});

adminOrdersRouter.get('/:id', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const order = await svc.getOrder(req.params.id!);
    sendSuccess(res, 200, order);
  } catch (err) {
    next(err);
  }
});

adminOrdersRouter.patch('/:id/status', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateStatusSchema.parse(req.body);
    const order = await svc.updateStatus(req.params.id!, data, req.user!.id);
    sendSuccess(res, 200, order);
  } catch (err) {
    next(err);
  }
});

adminOrdersRouter.post('/:id/cancel', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = cancelOrderSchema.parse(req.body);
    const result = await svc.cancelOrder(req.params.id!, data, req.user!.id);
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});

adminOrdersRouter.post('/:id/refund', ...adminGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = refundOrderSchema.parse(req.body);
    const result = await svc.refundOrder(req.params.id!, data, req.user!.id);
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});
