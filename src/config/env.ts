import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Load .env file
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5000),
  // DIRECT_URL is only needed for pooled Neon connections, not local PostgreSQL.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('http://localhost:3000')
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid or missing environment variables:');
  parsedEnv.error.issues.forEach((issue) => {
    console.error(` - ${issue.path.join('.')}: ${issue.message}`);
  });
  console.error('\nPlease verify your backend/.env configuration.');
  // In development, provide fallback defaults to allow offline/setup tasks to load
  if (process.env.NODE_ENV !== 'production' && !process.env.DATABASE_URL) {
    console.warn('⚠️ Falling back to placeholder configuration for bootstrapping.');
  }
}

export const env = parsedEnv.success
  ? parsedEnv.data
  : {
      NODE_ENV: (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development',
      PORT: Number(process.env.PORT) || 5000,
      DATABASE_URL:
        process.env.DATABASE_URL ||
        'postgresql://postgres:postgres@localhost:5432/ecommarce?schema=public',
      JWT_SECRET: process.env.JWT_SECRET || 'dev_secret_key_minimum_16_characters_placeholder',
      JWT_REFRESH_SECRET:
        process.env.JWT_REFRESH_SECRET || 'dev_refresh_key_minimum_16_characters_placeholder',
      JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '15m',
      JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
      CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000'
    };
