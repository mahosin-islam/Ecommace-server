import { prisma } from '../../lib/prisma.js';
import { IPaymentProvider, PaymentResult, VerificationResult } from './paymentProvider.js';

/**
 * Cash on Delivery provider.
 * Creates a PENDING payment record immediately on order placement.
 * Payment is captured when the order is marked DELIVERED.
 */
export class CodProvider implements IPaymentProvider {
  readonly name = 'cod';

  async createPayment(
    orderId: string,
    amount: number,
    currency: string,
    _meta: Record<string, unknown>,
  ): Promise<PaymentResult> {
    const existing = await prisma.payment.findFirst({
      where: { orderId, provider: 'cod' },
      orderBy: { createdAt: 'desc' },
    });

    if (existing?.transactionId) {
      if (existing.status === 'FAILED') {
        const reset = await prisma.payment.update({
          where: { id: existing.id },
          data: { status: 'PENDING', amount, currency, errorMessage: null },
        });
        return { transactionId: reset.transactionId!, status: 'PENDING' };
      }

      const statusMap: Record<string, PaymentResult['status']> = {
        PENDING: 'PENDING',
        AUTHORIZED: 'AUTHORIZED',
        CAPTURED: 'CAPTURED',
        FAILED: 'FAILED',
        REFUNDED: 'CAPTURED',
        PARTIALLY_REFUNDED: 'CAPTURED',
      };

      return {
        transactionId: existing.transactionId,
        status: statusMap[existing.status] ?? 'PENDING',
      };
    }

    const transactionId = existing?.transactionId ?? `cod_${orderId}_${Date.now()}`;

    if (existing) {
      const updated = await prisma.payment.update({
        where: { id: existing.id },
        data: {
          transactionId,
          amount,
          currency,
          status: 'PENDING',
          paymentMethod: 'cod',
          rawPayload: { note: 'Cash on Delivery — collected at delivery' },
        },
      });
      return { transactionId: updated.transactionId!, status: 'PENDING' };
    }

    await prisma.payment.create({
      data: {
        orderId,
        provider: 'cod',
        transactionId,
        amount,
        currency,
        status: 'PENDING',
        paymentMethod: 'cod',
        rawPayload: { note: 'Cash on Delivery — collected at delivery' },
      },
    });

    return { transactionId, status: 'PENDING' };
  }

  async verifyPayment(transactionId: string): Promise<VerificationResult> {
    const payment = await prisma.payment.findFirst({ where: { transactionId } });
    if (!payment) throw new Error(`COD payment ${transactionId} not found`);

    return {
      transactionId,
      status: payment.status as VerificationResult['status'],
      amount: Number(payment.amount),
    };
  }
}

export const codProvider = new CodProvider();
