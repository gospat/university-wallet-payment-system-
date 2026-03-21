import dotenv from 'dotenv';
import app from './app';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().positive().optional(),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_CALLBACK_URL: z.string().url().optional(),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32 bytes hex (64 chars)'),
  CORS_ORIGIN: z.string().optional(),
  METRICS_TOKEN: z.string().min(16).optional(),
});

envSchema.parse(process.env);

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection', err);
  process.exit(1);
});
