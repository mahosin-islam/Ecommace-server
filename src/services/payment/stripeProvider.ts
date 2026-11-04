import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/appError.js';
import { IPaymentProvider, PaymentResult, RefundResult, VerificationResult } from './paymentProvider.js';

function getStripeClient(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError('Stripe is not configured. Set STRIPE_SECRET_KEY in environment.', 503, 'PROVIDER_UNAVAILABLE');
  }
  return new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2026-10-28.endive' });
}

function mapIntentStatus(status: Stripe.PaymentIntent.Status): PaymentResult['status'] {
  if (status === 'succeeded') return 'CAPTURED';
  if (status === 'canceled') return 'FAILED';
  if (status === 'requires_payment_method') return 'PENDING';
  return 'AUTHORIZED';
}

export class StripeProvider implements IPaymentProvider {
  readonly name = 'stripe';

  async createPayment(
    orderId: string,
    amount: number,
    currency: string,
    meta: Record<string, unknown>,
  ): Promise<PaymentResult> {
    const stripe = getStripeClient();

    const existing = await prisma.payment.findFirst({
      where: { orderId, provider: 'stripe' },
      orderBy: { createdAt: 'desc' },
    });

    if (existing?.transactionId) {
      const existingIntent = await stripe.paymentIntents
        .retrieve(existing.transactionId)
        .catch(() => null);

      if (existingIntent && existingIntent.status !== 'canceled') {
        const status = mapIntentStatus(existingIntent.status);
        await prisma.payment.update({
          where: { id: existing.id },
          data: {
            amount,
            currency,
            status:
              existing.status === 'REFUNDED' || existing.status === 'PARTIALLY_REFUNDED'
                ? existing.status
                : status,
            rawPayload: existingIntent as unknown as Prisma.InputJsonValue,
            errorMessage: null,
          },
        });

        return {
          transactionId: existingIntent.id,
          status,
          clientSecret: existingIntent.client_secret ?? undefined,
          rawPayload: existingIntent as unknown as Record<string, unknown>,
        };
      }
    }

    const amountInCents = Math.round(amount * 100);
    const intent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: currency.toLowerCase(),
      metadata: { orderId, ...(meta as Record<string, string>) },
    });

    if (existing) {
      await prisma.payment.update({
        where: { id: existing.id },
        data: {
          transactionId: intent.id,
          amount,
          currency,
          status: 'PENDING',
          paymentMethod: 'stripe',
          rawPayload: intent as unknown as Prisma.InputJsonValue,
          errorMessage: null,
        },
      });
    } else {
      await prisma.payment.create({
        data: {
          orderId,
          provider: 'stripe',
          transactionId: intent.id,
          amount,
          currency,
          status: 'PENDING',
          paymentMethod: 'stripe',
          rawPayload: intent as unknown as Prisma.InputJsonValue,
        },
      });
    }

    return {
      transactionId: intent.id,
      status: 'PENDING',
      clientSecret: intent.client_secret ?? undefined,
      rawPayload: intent as unknown as Record<string, unknown>,
    };
  }

  async verifyPayment(transactionId: string): Promise<VerificationResult> {
    const stripe = getStripeClient();
    const intent = await stripe.paymentIntents.retrieve(transactionId);

    const statusMap: Record<string, VerificationResult['status']> = {
      requires_payment_method: 'FAILED',
      requires_confirmation: 'AUTHORIZED',
      requires_action: 'AUTHORIZED',
      processing: 'AUTHORIZED',
      succeeded: 'CAPTURED',
      canceled: 'FAILED',
    };

    return {
      transactionId,
      status: statusMap[intent.status] ?? 'FAILED',
      amount: intent.amount / 100,
      currency: intent.currency,
      rawPayload: intent as unknown as Record<string, unknown>,
    };
  }

  async refundPayment(transactionId: string, amount?: number): Promise<RefundResult> {
    const stripe = getStripeClient();
    const refund = await stripe.refunds.create({
      payment_intent: transactionId,
      ...(amount !== undefined ? { amount: Math.round(amount * 100) } : {}),
    });

    return {
      refundId: refund.id,
      status: refund.status === 'succeeded' ? 'REFUNDED' : 'PENDING',
      amount: refund.amount / 100,
      currency: refund.currency,
      rawPayload: refund as unknown as Record<string, unknown>,
    };
  }

  /**
   * Handle Stripe webhook events.
   * Call this from the webhook endpoint after verifying the signature.
   */
  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object as Stripe.PaymentIntent;
      await prisma.payment.updateMany({
        where: {
          transactionId: intent.id,
          status: { notIn: ['REFUNDED', 'PARTIALLY_REFUNDED'] },
        },
        data: {
          status: 'CAPTURED',
          rawPayload: intent as unknown as Prisma.InputJsonValue,
          errorMessage: null,
        },
      });
      return;
    }

    if (event.type === 'payment_intent.payment_failed') {
      const intent = event.data.object as Stripe.PaymentIntent;
      await prisma.payment.updateMany({
        where: {
          transactionId: intent.id,
          status: { notIn: ['REFUNDED', 'PARTIALLY_REFUNDED', 'CAPTURED'] },
        },
        data: {
          status: 'FAILED',
          errorMessage: intent.last_payment_error?.message ?? 'Payment failed',
          rawPayload: intent as unknown as Prisma.InputJsonValue,
        },
      });
      return;
    }

    if (event.type === 'payment_intent.canceled') {
      const intent = event.data.object as Stripe.PaymentIntent;
      await prisma.payment.updateMany({
        where: {
          transactionId: intent.id,
          status: { notIn: ['REFUNDED', 'PARTIALLY_REFUNDED', 'CAPTURED'] },
        },
        data: {
          status: 'FAILED',
          errorMessage: 'Payment intent cancelled',
          rawPayload: intent as unknown as Prisma.InputJsonValue,
        },
      });
      return;
    }

    if (event.type === 'charge.refunded') {
      const charge = event.data.object as Stripe.Charge;
      const transactionId =
        typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : charge.payment_intent?.id;

      if (transactionId) {
        await prisma.payment.updateMany({
          where: { transactionId },
          data: {
            status:
              charge.amount_refunded < charge.amount ? 'PARTIALLY_REFUNDED' : 'REFUNDED',
            rawPayload: charge as unknown as Prisma.InputJsonValue,
          },
        });
      }
    }
  }

  /**
   * Verify a Stripe webhook signature and return the event.
   */
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    if (!env.STRIPE_WEBHOOK_SECRET) {
      throw new AppError('Stripe webhook secret not configured.', 503, 'PROVIDER_UNAVAILABLE');
    }
    const stripe = getStripeClient();
    return stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  }
}

export const stripeProvider = new StripeProvider();
