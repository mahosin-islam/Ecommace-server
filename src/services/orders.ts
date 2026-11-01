import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Prisma, OrderStatus, StockMovementType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { NotFoundError, BadRequestError } from '../utils/appError.js';
import { sendSuccess } from '../utils/response.js';
import { authenticate } from '../middlewares/auth.js';

export interface CreateOrderItemInput {
  productId: string;
  variantId?: string;
  quantity: number;
}

export interface CreateOrderInput {
  userId?: string;
  customerEmail: string;
  customerPhone?: string;
  customerName: string;
  shippingAddress: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
  shippingMethod?: string;
  customerNotes?: string;
  paymentMethod: string;
  items: CreateOrderItemInput[];
}

export class OrderService {
  static async checkout(input: CreateOrderInput) {
    if (!input.items || input.items.length === 0) {
      throw new BadRequestError('Order must contain at least one item');
    }

    const order = await prisma.$transaction(async (tx) => {
      let subtotal = new Prisma.Decimal(0);
      const preparedOrderItems: Array<{
        productId: string;
        variantId: string | null;
        productTitle: string;
        variantTitle: string | null;
        sku: string;
        unitPrice: Prisma.Decimal;
        quantity: number;
        subtotal: Prisma.Decimal;
        total: Prisma.Decimal;
      }> = [];

      for (const item of input.items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId }
        });

        if (!product || !product.isActive || product.isArchived) {
          throw new BadRequestError(`Product ${item.productId} is not available for purchase.`);
        }

        if (item.variantId) {
          const variant = await tx.productVariant.findUnique({
            where: { id: item.variantId }
          });

          if (!variant || !variant.isActive || variant.productId !== product.id) {
            throw new BadRequestError(`Variant ${item.variantId} is not valid.`);
          }

          if (variant.stock < item.quantity) {
            throw new BadRequestError(
              `Insufficient stock for "${product.title} (${variant.title})". Requested: ${item.quantity}, Available: ${variant.stock}`
            );
          }

          const updatedVariant = await tx.productVariant.update({
            where: { id: variant.id },
            data: { stock: { decrement: item.quantity } }
          });

          await tx.inventoryLog.create({
            data: {
              productId: product.id,
              variantId: variant.id,
              type: StockMovementType.SALE_ORDER,
              quantityChange: -item.quantity,
              previousStock: variant.stock,
              newStock: updatedVariant.stock,
              note: `Sold via customer checkout`
            }
          });

          const lineTotal = variant.price.mul(item.quantity);
          subtotal = subtotal.add(lineTotal);

          preparedOrderItems.push({
            productId: product.id,
            variantId: variant.id,
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku,
            unitPrice: variant.price,
            quantity: item.quantity,
            subtotal: lineTotal,
            total: lineTotal
          });
        } else {
          if (product.stock < item.quantity) {
            throw new BadRequestError(
              `Insufficient stock for "${product.title}". Requested: ${item.quantity}, Available: ${product.stock}`
            );
          }

          const updatedProduct = await tx.product.update({
            where: { id: product.id },
            data: { stock: { decrement: item.quantity } }
          });

          await tx.inventoryLog.create({
            data: {
              productId: product.id,
              type: StockMovementType.SALE_ORDER,
              quantityChange: -item.quantity,
              previousStock: product.stock,
              newStock: updatedProduct.stock,
              note: `Sold via customer checkout`
            }
          });

          const lineTotal = product.basePrice.mul(item.quantity);
          subtotal = subtotal.add(lineTotal);

          preparedOrderItems.push({
            productId: product.id,
            variantId: null,
            productTitle: product.title,
            variantTitle: null,
            sku: product.sku,
            unitPrice: product.basePrice,
            quantity: item.quantity,
            subtotal: lineTotal,
            total: lineTotal
          });
        }
      }

      const taxRateSetting = await tx.storeSetting.findUnique({ where: { key: 'tax.rate_percent' } });
      const freeShipThresholdSetting = await tx.storeSetting.findUnique({
        where: { key: 'shipping.free_threshold' }
      });
      const flatShippingSetting = await tx.storeSetting.findUnique({
        where: { key: 'shipping.flat_rate' }
      });

      const taxRate = taxRateSetting ? parseFloat(taxRateSetting.value) / 100 : 0.0;
      const freeShipThreshold = freeShipThresholdSetting ? parseFloat(freeShipThresholdSetting.value) : 100;
      const flatRate = flatShippingSetting ? parseFloat(flatShippingSetting.value) : 5.0;

      const taxAmount = subtotal.mul(taxRate).toDecimalPlaces(2);
      const shippingAmount =
        subtotal.toNumber() >= freeShipThreshold
          ? new Prisma.Decimal(0)
          : new Prisma.Decimal(flatRate);

      const totalAmount = subtotal.add(taxAmount).add(shippingAmount);

      const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
      const orderNumber = `ORD-${datePrefix}-${randomSuffix}`;

      const newOrder = await tx.order.create({
        data: {
          orderNumber,
          userId: input.userId ?? null,
          customerEmail: input.customerEmail.toLowerCase(),
          customerPhone: input.customerPhone,
          customerName: input.customerName,
          status: OrderStatus.PENDING,
          subtotal,
          taxAmount,
          shippingAmount,
          totalAmount,
          shippingAddress: input.shippingAddress as any,
          billingAddress: (input.billingAddress as any) ?? (input.shippingAddress as any),
          shippingMethod: input.shippingMethod ?? 'Standard Delivery',
          customerNotes: input.customerNotes,
          items: {
            create: preparedOrderItems
          },
          statusHistory: {
            create: {
              toStatus: OrderStatus.PENDING,
              note: 'Order placed by customer',
              changedByUserId: input.userId ?? null
            }
          },
          payments: {
            create: {
              provider: input.paymentMethod,
              amount: totalAmount,
              status: 'PENDING',
              paymentMethod: input.paymentMethod
            }
          }
        },
        include: {
          items: true,
          payments: true
        }
      });

      if (input.userId) {
        const cart = await tx.cart.findUnique({ where: { userId: input.userId } });
        if (cart) {
          await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        }
      }

      return newOrder;
    });

    return order;
  }

  static async getCustomerOrders(userId: string, page: number = 1, limit: number = 10) {
    const skip = (page - 1) * limit;

    const [total, orders] = await prisma.$transaction([
      prisma.order.count({ where: { userId } }),
      prisma.order.findMany({
        where: { userId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          items: true,
          payments: {
            select: { id: true, provider: true, status: true, amount: true }
          }
        }
      })
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      orders,
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

  static async getOrderById(orderId: string, userId?: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        payments: true,
        statusHistory: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    if (userId && order.userId !== userId) {
      throw new NotFoundError('Order not found');
    }

    return order;
  }
}

export const orderRouter = Router();

orderRouter.post('/checkout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const order = await OrderService.checkout({
      ...req.body,
      userId: req.user?.id
    });
    sendSuccess(res, 201, order);
  } catch (err) {
    next(err);
  }
});

orderRouter.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const { orders, meta } = await OrderService.getCustomerOrders(req.user!.id, page, limit);
    sendSuccess(res, 200, orders, meta);
  } catch (err) {
    next(err);
  }
});

orderRouter.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderId = req.params.id as string;
    const order = await OrderService.getOrderById(orderId, req.user?.id);
    sendSuccess(res, 200, order);
  } catch (err) {
    next(err);
  }
});
