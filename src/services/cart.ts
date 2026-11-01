import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { NotFoundError, BadRequestError } from '../utils/appError.js';
import { sendSuccess } from '../utils/response.js';
import { authenticate } from '../middlewares/auth.js';

export const addToCartSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  quantity: z.number().int().positive().default(1)
});

export const updateCartItemSchema = z.object({
  quantity: z.number().int().positive()
});

export class CartService {
  static async getOrCreateCart(userId: string) {
    let cart = await prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          orderBy: { createdAt: 'desc' },
          include: {
            product: {
              select: {
                id: true,
                title: true,
                slug: true,
                basePrice: true,
                stock: true,
                images: {
                  take: 1,
                  orderBy: { sortOrder: 'asc' },
                  select: { url: true }
                }
              }
            },
            variant: {
              select: {
                id: true,
                title: true,
                sku: true,
                price: true,
                stock: true
              }
            }
          }
        }
      }
    });

    if (!cart) {
      cart = await prisma.cart.create({
        data: { userId },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  title: true,
                  slug: true,
                  basePrice: true,
                  stock: true,
                  images: {
                    take: 1,
                    orderBy: { sortOrder: 'asc' },
                    select: { url: true }
                  }
                }
              },
              variant: {
                select: {
                  id: true,
                  title: true,
                  sku: true,
                  price: true,
                  stock: true
                }
              }
            }
          }
        }
      });
    }

    let subtotal = new Prisma.Decimal(0);
    let totalItems = 0;

    const formattedItems = cart.items.map((item) => {
      const price = item.variant ? item.variant.price : item.product.basePrice;
      const availableStock = item.variant ? item.variant.stock : item.product.stock;
      const lineTotal = price.mul(item.quantity);

      subtotal = subtotal.add(lineTotal);
      totalItems += item.quantity;

      return {
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        productTitle: item.product.title,
        productSlug: item.product.slug,
        variantTitle: item.variant?.title ?? null,
        imageUrl: item.product.images[0]?.url ?? null,
        unitPrice: price.toFixed(2),
        quantity: item.quantity,
        totalPrice: lineTotal.toFixed(2),
        availableStock,
        isOutOfStock: availableStock < item.quantity
      };
    });

    return {
      id: cart.id,
      items: formattedItems,
      subtotal: subtotal.toFixed(2),
      itemCount: totalItems
    };
  }

  static async addItem(userId: string, productId: string, variantId?: string, quantity: number = 1) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { variants: true }
    });

    if (!product || !product.isActive || product.isArchived) {
      throw new NotFoundError('Product not found or unavailable');
    }

    if (variantId) {
      const variant = product.variants.find((v) => v.id === variantId);
      if (!variant || !variant.isActive) {
        throw new NotFoundError('Product variant not found');
      }
      if (variant.stock < quantity) {
        throw new BadRequestError(`Insufficient stock. Only ${variant.stock} available.`);
      }
    } else {
      if (product.stock < quantity) {
        throw new BadRequestError(`Insufficient stock. Only ${product.stock} available.`);
      }
    }

    let cart = await prisma.cart.findUnique({ where: { userId } });
    if (!cart) {
      cart = await prisma.cart.create({ data: { userId } });
    }

    const existingItem = await prisma.cartItem.findUnique({
      where: {
        cartId_productId_variantId: {
          cartId: cart.id,
          productId,
          variantId: variantId || (null as any)
        }
      }
    });

    if (existingItem) {
      const newQuantity = existingItem.quantity + quantity;
      await prisma.cartItem.update({
        where: { id: existingItem.id },
        data: { quantity: newQuantity }
      });
    } else {
      await prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productId,
          variantId: variantId ?? null,
          quantity
        }
      });
    }

    return this.getOrCreateCart(userId);
  }

  static async updateQuantity(userId: string, cartItemId: string, quantity: number) {
    const item = await prisma.cartItem.findUnique({
      where: { id: cartItemId },
      include: {
        cart: true,
        product: true,
        variant: true
      }
    });

    if (!item || item.cart.userId !== userId) {
      throw new NotFoundError('Cart item not found');
    }

    const availableStock = item.variant ? item.variant.stock : item.product.stock;
    if (availableStock < quantity) {
      throw new BadRequestError(`Only ${availableStock} units available in stock.`);
    }

    await prisma.cartItem.update({
      where: { id: cartItemId },
      data: { quantity }
    });

    return this.getOrCreateCart(userId);
  }

  static async removeItem(userId: string, cartItemId: string) {
    const item = await prisma.cartItem.findUnique({
      where: { id: cartItemId },
      include: { cart: true }
    });

    if (!item || item.cart.userId !== userId) {
      throw new NotFoundError('Cart item not found');
    }

    await prisma.cartItem.delete({
      where: { id: cartItemId }
    });

    return this.getOrCreateCart(userId);
  }

  static async clearCart(userId: string) {
    const cart = await prisma.cart.findUnique({ where: { userId } });
    if (cart) {
      await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    }
    return { message: 'Cart cleared successfully' };
  }
}

export const cartRouter = Router();

cartRouter.use(authenticate);

cartRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cart = await CartService.getOrCreateCart(req.user!.id);
    sendSuccess(res, 200, cart);
  } catch (err) {
    next(err);
  }
});

cartRouter.post('/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { productId, variantId, quantity } = addToCartSchema.parse(req.body);
    const cart = await CartService.addItem(req.user!.id, productId, variantId, quantity);
    sendSuccess(res, 200, cart);
  } catch (err) {
    next(err);
  }
});

cartRouter.put('/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { quantity } = updateCartItemSchema.parse(req.body);
    const cartItemId = req.params.id as string;
    const cart = await CartService.updateQuantity(req.user!.id, cartItemId, quantity);
    sendSuccess(res, 200, cart);
  } catch (err) {
    next(err);
  }
});

cartRouter.delete('/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cartItemId = req.params.id as string;
    const cart = await CartService.removeItem(req.user!.id, cartItemId);
    sendSuccess(res, 200, cart);
  } catch (err) {
    next(err);
  }
});

cartRouter.delete('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await CartService.clearCart(req.user!.id);
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});
