import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { env } from './env.js';

export const db = new PrismaClient();
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const keyScope = `vincent:${env.GOOGLE_SPREADSHEET_ID}:`;
