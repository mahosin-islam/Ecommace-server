// ── Payment Provider Interface ────────────────────────────────────────────────
// All payment providers must implement this interface.
// This allows switching between COD, Stripe, bKash, Nagad, etc.

export interface PaymentResult {
  transactionId: string;
  status: 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED';
  /** Provider-specific client secret or token (e.g. Stripe PaymentIntent clientSecret) */
  clientSecret?: string;
  /** Raw provider response for audit logging */
  rawPayload?: Record<string, unknown>;
}

export interface VerificationResult {
  transactionId: string;
  status: 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'REFUNDED';
  amount?: number;
  currency?: string;
  rawPayload?: Record<string, unknown>;
}

export interface RefundResult {
  refundId: string;
  status: 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'PENDING';
  amount: number;
  currency?: string;
  rawPayload?: Record<string, unknown>;
}

export interface IPaymentProvider {
  /** Machine-readable provider name (e.g. 'cod', 'stripe', 'bkash') */
  readonly name: string;

  /**
   * Initiate a payment for an order.
   * For COD this creates a pending payment record.
   * For Stripe this creates a PaymentIntent and returns clientSecret.
   */
  createPayment(
    orderId: string,
    amount: number,
    currency: string,
    meta: Record<string, unknown>,
  ): Promise<PaymentResult>;

  /**
   * Verify/confirm a payment by its provider transaction ID.
   */
  verifyPayment(transactionId: string): Promise<VerificationResult>;

  /**
   * Refund a captured payment. Providers that do not support API refunds may omit this.
   */
  refundPayment?(transactionId: string, amount?: number): Promise<RefundResult>;
}
