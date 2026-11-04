import { AppError } from '../../utils/appError.js';
import { IPaymentProvider, PaymentResult, VerificationResult } from './paymentProvider.js';

/**
 * bKash provider stub.
 * Full integration requires official bKash Merchant API credentials.
 * Do NOT implement fake bKash integration.
 */
export class BkashProvider implements IPaymentProvider {
  readonly name = 'bkash';

  async createPayment(
    _orderId: string,
    _amount: number,
    _currency: string,
    _meta: Record<string, unknown>,
  ): Promise<PaymentResult> {
    throw new AppError(
      'bKash payment integration is not yet available. Please choose another payment method.',
      503,
      'PROVIDER_UNAVAILABLE',
    );
  }

  async verifyPayment(_transactionId: string): Promise<VerificationResult> {
    throw new AppError(
      'bKash payment integration is not yet available.',
      503,
      'PROVIDER_UNAVAILABLE',
    );
  }
}

/**
 * Nagad provider stub.
 * Full integration requires official Nagad Merchant API credentials.
 * Do NOT implement fake Nagad integration.
 */
export class NagadProvider implements IPaymentProvider {
  readonly name = 'nagad';

  async createPayment(
    _orderId: string,
    _amount: number,
    _currency: string,
    _meta: Record<string, unknown>,
  ): Promise<PaymentResult> {
    throw new AppError(
      'Nagad payment integration is not yet available. Please choose another payment method.',
      503,
      'PROVIDER_UNAVAILABLE',
    );
  }

  async verifyPayment(_transactionId: string): Promise<VerificationResult> {
    throw new AppError(
      'Nagad payment integration is not yet available.',
      503,
      'PROVIDER_UNAVAILABLE',
    );
  }
}

export const bkashProvider = new BkashProvider();
export const nagadProvider = new NagadProvider();
