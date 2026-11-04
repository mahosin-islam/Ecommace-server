import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/auth.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/appError.js';
import { codProvider } from './codProvider.js';
import { stripeProvider } from './stripeProvider.js';
import { bkashProvider, nagadProvider } from './mobileProviders.js';
import { IPaymentProvider } from './paymentProvider.js';

// ── Provider Registry ────────────────────────────────────────────────────────

const providers: Record<string, IPaymentProvider> = {
  cod: codProvider,
  stripe: stripeProvider,
  bkash: bkashProvider,
  nagad: nagadProvider,
};

// ── Validation Schemas ───────────────────────────────────────────────────────

const createIntentSchema = z.object({
  orderId: z.string().uuid(),
  provider: z.enum(['cod', 'stripe', 'bkash', 'nagad']).default('stripe'),
});

// ── Router ───────────────────────────────────────────────────────────────────

export const paymentRouter = Router();

// POST /api/v1/payments/create-intent
// Authenticated customer creates a payment for their order
paymentRouter.post('/create-intent', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderId, provider: providerName } = createIntentSchema.parse(req.body);
    const userId = (req as Request & { user?: { id: string } }).user!.id;

    // Verify order belongs to this user
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND');
    if (order.userId !== userId) throw new AppError('Access denied', 403, 'FORBIDDEN');
    if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
      throw new AppError('This order can no longer be paid', 400, 'INVALID_ORDER_STATUS');
    }

    const provider = providers[providerName];
    const result = await provider.createPayment(
      orderId,
      Number(order.totalAmount),
      order.currency,
      { orderNumber: order.orderNumber },
    );

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/payments/webhook/stripe
// Raw body required — registered BEFORE express.json() in app.ts
paymentRouter.post('/webhook/stripe', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const signature = req.headers['stripe-signature'] as string;
    if (!signature) throw new AppError('Missing stripe-signature header', 400, 'INVALID_REQUEST');

    const event = stripeProvider.constructEvent(req.body as Buffer, signature);
    await stripeProvider.handleWebhookEvent(event);

    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/payments/status/:orderId
// Get current payment status for an order (authenticated)
paymentRouter.get('/status/:orderId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as Request & { user?: { id: string } }).user!.id;
    const { orderId } = req.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND');
    if (order.userId !== userId) throw new AppError('Access denied', 403, 'FORBIDDEN');

    const payments = await prisma.payment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        provider: true,
        transactionId: true,
        amount: true,
        currency: true,
        status: true,
        paymentMethod: true,
        createdAt: true,
      },
    });

    res.json({
      success: true,
      data: { orderId, paymentStatus: payments[0]?.status ?? null, payments },
    });
  } catch (err) {
    next(err);
  }
});
