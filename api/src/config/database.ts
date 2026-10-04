import { PrismaClient, type Prisma } from '@prisma/client';

const env = process.env.NODE_ENV ?? 'development';
const explicitDebug = process.env.PRISMA_DEBUG === '1';

const prismaLogLevels: Prisma.LogLevel[] =
  env === 'development' && explicitDebug
    ? ['query', 'info', 'warn', 'error']
    : env === 'development'
    ? ['info', 'warn', 'error']
    : ['warn', 'error'];

const prisma = new PrismaClient({
  log: prismaLogLevels,
});

export default prisma;
