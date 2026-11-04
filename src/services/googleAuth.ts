import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import {
  getGoogleOAuthClient,
  generateGoogleState,
  verifyGoogleState,
  GoogleStatePayload
} from '../utils/google.js';
import { AppError, ConflictError, UnauthorizedError, BadRequestError } from '../utils/appError.js';
import { logger } from '../utils/logger.js';

export interface GoogleAuthResult {
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: 'CUSTOMER' | 'STAFF' | 'ADMIN';
    phone: string | null;
  };
  redirectTo?: string;
}

export class GoogleAuthService {
  /**
   * Generates the Google OAuth authorization URL and state nonce.
   */
  static getAuthorizationUrl(redirectTo?: string): { authUrl: string; nonce: string; state: string } {
    const client = getGoogleOAuthClient();
    const { state, nonce } = generateGoogleState(redirectTo);

    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      scope: ['openid', 'email', 'profile'],
      state,
      prompt: 'select_account'
    });

    return { authUrl, nonce, state };
  }

  /**
   * Handles the OAuth callback from Google.
   * Exchanges code, verifies token, finds or creates user adhering to security rules,
   * and issues JWT session tokens.
   */
  static async handleCallback(
    code: string,
    state: string,
    cookieNonce?: string
  ): Promise<GoogleAuthResult> {
    if (!code) {
      throw new BadRequestError('Missing authorization code from Google');
    }

    // 1. Verify CSRF State
    const statePayload: GoogleStatePayload = verifyGoogleState(state, cookieNonce);

    // 2. Exchange authorization code for tokens
    const client = getGoogleOAuthClient();
    let tokens;
    try {
      const response = await client.getToken(code);
      tokens = response.tokens;
    } catch (err: any) {
      logger.error('Failed to exchange authorization code with Google:', err?.message || err);
      throw new BadRequestError('Failed to exchange authorization code with Google');
    }

    if (!tokens.id_token) {
      throw new BadRequestError('Google did not return an ID token');
    }

    // 3. Verify ID Token and resolve user session
    return this.verifyAndAuthenticateIdToken(tokens.id_token, statePayload.redirectTo);
  }

  /**
   * Verifies a Google ID token (from OAuth 2.0 or One Tap) and resolves/creates the user session.
   * Enforces all account rules (Cases A, B, C, D) and issues JWT access/refresh tokens.
   */
  static async verifyAndAuthenticateIdToken(
    idToken: string,
    redirectTo?: string
  ): Promise<GoogleAuthResult> {
    if (!idToken) {
      throw new BadRequestError('Missing Google ID token');
    }

    const client = getGoogleOAuthClient();

    // 1. Verify ID Token (validates signature, audience, issuer, expiration)
    let payload;
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: env.GOOGLE_CLIENT_ID
      });
      payload = ticket.getPayload();
    } catch (err: any) {
      logger.error('Failed to verify Google ID token:', err?.message || err);
      throw new UnauthorizedError('Invalid Google identity token');
    }

    if (!payload) {
      throw new UnauthorizedError('Empty Google identity token payload');
    }

    const {
      sub: googleId,
      email,
      email_verified: emailVerified,
      given_name: firstName,
      family_name: lastName
    } = payload;

    if (!googleId || !email) {
      throw new BadRequestError('Incomplete profile data received from Google');
    }

    // 2. Require verified email
    if (!emailVerified) {
      throw new UnauthorizedError('Google account email is not verified');
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 3. Query existing accounts to determine the appropriate case
    const userByGoogleId = await prisma.user.findUnique({
      where: { googleId }
    });

    const userByEmail = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    let targetUser;

    // ─── Case D: Google ID already associated with another account ─────────
    if (userByGoogleId && userByEmail && userByGoogleId.id !== userByEmail.id) {
      logger.warn(
        `Case D Conflict: Google ID ${googleId} matched user ${userByGoogleId.id}, but email ${normalizedEmail} matched ${userByEmail.id}`
      );
      throw new ConflictError('Google identity is already associated with another account');
    }

    // ─── Case B: Existing user with matching Google ID ─────────────────────
    if (userByGoogleId) {
      if (!userByGoogleId.isActive) {
        throw new UnauthorizedError('Account is inactive or disabled');
      }

      // Update last login timestamp without altering role or core data
      targetUser = await prisma.user.update({
        where: { id: userByGoogleId.id },
        data: { lastLoginAt: new Date() }
      });
    }
    // ─── Case C: Existing account with same email but no matching Google ID ─
    else if (userByEmail) {
      logger.info(
        `Case C: User ${userByEmail.id} exists for ${normalizedEmail} without Google ID. Rejecting auto-link.`
      );
      throw new AppError(
        'An account with this email address already exists using password login. Please log in with your email and password.',
        409,
        'GOOGLE_ACCOUNT_LINK_REQUIRED'
      );
    }
    // ─── Case A: New Google user ──────────────────────────────────────────
    else {
      targetUser = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email: normalizedEmail,
            googleId,
            authProvider: 'google',
            passwordHash: null,
            firstName: firstName || null,
            lastName: lastName || null,
            role: 'CUSTOMER', // Strict: new Google users are always CUSTOMER
            isActive: true,
            isEmailVerified: true,
            lastLoginAt: new Date()
          }
        });

        // Initialize personal cart and wishlist atomically
        await tx.cart.create({
          data: { userId: newUser.id }
        });

        await tx.wishlist.create({
          data: { userId: newUser.id }
        });

        return newUser;
      });

      logger.info(`Case A: Created new Google customer ${targetUser.id} (${normalizedEmail})`);
    }

    return {
      user: {
        id: targetUser.id,
        email: targetUser.email,
        firstName: targetUser.firstName,
        lastName: targetUser.lastName,
        role: targetUser.role,
        phone: targetUser.phone
      },
      redirectTo
    };
  }
}
