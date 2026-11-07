import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// npm workspace scripts run from apps/api. Keep a single root .env for
// development while respecting environment variables injected by Docker.
config({path:resolve(dirname(fileURLToPath(import.meta.url)),'../../../.env')});
config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  GOOGLE_SPREADSHEET_ID: z.string().min(1),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email(),
  GOOGLE_PRIVATE_KEY: z.string().min(10),
  SESSION_SECRET: z.string().min(32),
  INITIAL_ADMIN_PASSWORD: z.string().optional(),
  INITIAL_ADMIN_LOGIN: z.string().optional(),
  COLLECTIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  COOKIE_SECURE: z.enum(['true','false']).optional(),
  SHEET_POLL_SECONDS: z.coerce.number().min(30).default(60),
  PDF_FONT_PATH: z.string().optional(),
  PDF_FONT_BOLD_PATH: z.string().optional(),
});

export const env = schema.parse(process.env);
export const cookieSecure = env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production';
