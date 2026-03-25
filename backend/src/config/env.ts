import { z } from 'zod';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.string().default('3001').transform(Number),

  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .url('DATABASE_URL must be a valid PostgreSQL connection string'),

  REDIS_URL: z
    .string({ required_error: 'REDIS_URL is required' })
    .default('redis://localhost:6379'),

  JWT_SECRET: z
    .string({ required_error: 'JWT_SECRET is required' })
    .min(32, 'JWT_SECRET must be at least 32 characters'),

  JWT_REFRESH_SECRET: z
    .string({ required_error: 'JWT_REFRESH_SECRET is required' })
    .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),

  VAPID_PUBLIC_KEY: z
    .string({ required_error: 'VAPID_PUBLIC_KEY is required' })
    .min(1),

  VAPID_PRIVATE_KEY: z
    .string({ required_error: 'VAPID_PRIVATE_KEY is required' })
    .min(1),

  VAPID_EMAIL: z
    .string({ required_error: 'VAPID_EMAIL is required' })
    .email('VAPID_EMAIL must be a valid email address'),

  GEMINI_API_KEY: z
    .string({ required_error: 'GEMINI_API_KEY is required' })
    .min(1),

  GEMINI_MODEL: z
    .string()
    .default('gemini-1.5-flash'),

  APP_URL: z
    .string({ required_error: 'APP_URL is required' })
    .url('APP_URL must be a valid URL')
    .default('http://localhost:3000'),

  FRONTEND_URL: z
    .string()
    .url()
    .default('http://localhost:3000'),

  // Optional comma-separated origins, e.g.
  // FRONTEND_URLS=http://localhost:3000,http://192.168.1.168:3000
  FRONTEND_URLS: z.string().optional(),

  ENCRYPTION_KEY: z
    .string({ required_error: 'ENCRYPTION_KEY is required' })
    .length(64, 'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)'),

  // GDT Intermediary — optional until partner provides credentials
  GDT_INTERMEDIARY_BASE_URL: z.string().optional(),
  GDT_INTERMEDIARY_TOKEN_URL: z.string().optional(),
  GDT_INTERMEDIARY_CLIENT_ID: z.string().optional(),
  GDT_INTERMEDIARY_CLIENT_SECRET: z.string().optional(),
  GDT_INTERMEDIARY_SCOPE: z.string().default('invoice:read'),

  // Telegram bot — optional
  TELEGRAM_BOT_TOKEN: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `\n[CONFIG] Invalid environment variables:\n${errors}\n\nPlease check your .env file.`
    );
  }
  return result.data;
}

export const env: Env = validateEnv();
