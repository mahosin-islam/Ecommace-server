import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { BadRequestError } from './appError.js';

let oauthClient: OAuth2Client | null = null;

export function getGoogleOAuthClient(): OAuth2Client {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new BadRequestError('Google OAuth credentials are not configured on this server');
  }

  if (!oauthClient) {
    oauthClient = new OAuth2Client(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_CALLBACK_URL
    );
  }

  return oauthClient;
}

export interface GoogleStatePayload {
  nonce: string;
  timestamp: number;
  redirectTo?: string;
}

/**
 * Generates a cryptographically secure, HMAC-signed OAuth state parameter
 * alongside a random nonce for double-submit cookie verification.
 */
export function generateGoogleState(redirectTo?: string): { state: string; nonce: string } {
  const nonce = crypto.randomBytes(32).toString('hex');
  const payload: GoogleStatePayload = {
    nonce,
    timestamp: Date.now(),
    redirectTo: redirectTo?.startsWith('/') ? redirectTo : undefined
  };

  const serialized = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(serialized)
    .digest('base64url');

  return {
    state: `${serialized}.${signature}`,
    nonce
  };
}

/**
 * Validates the HMAC signature and timestamp of the OAuth state parameter.
 * If expectedNonce is provided from an HTTP-only cookie, it verifies matching nonces.
 */
export function verifyGoogleState(state: string, expectedNonce?: string): GoogleStatePayload {
  if (!state || typeof state !== 'string' || !state.includes('.')) {
    throw new BadRequestError('Invalid or missing OAuth state parameter');
  }

  const [serialized, signature] = state.split('.');
  if (!serialized || !signature) {
    throw new BadRequestError('Malformed OAuth state format');
  }

  const expectedSignature = crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(serialized)
    .digest('base64url');

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new BadRequestError('Invalid OAuth state signature (potential CSRF tampering)');
  }

  let payload: GoogleStatePayload;
  try {
    payload = JSON.parse(Buffer.from(serialized, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestError('Failed to parse OAuth state payload');
  }

  // 10 minutes maximum age
  const MAX_AGE_MS = 10 * 60 * 1000;
  if (Date.now() - payload.timestamp > MAX_AGE_MS) {
    throw new BadRequestError('OAuth state has expired. Please initiate sign-in again.');
  }

  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new BadRequestError('OAuth state nonce mismatch (potential CSRF attack)');
  }

  return payload;
}
