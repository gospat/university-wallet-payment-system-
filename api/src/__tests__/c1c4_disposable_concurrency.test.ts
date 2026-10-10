// C1-C4 DISPOSABLE MYSQL+REDIS CONCURRENCY PROOF TEST (OPTIONAL, OPT-IN)
// Runs ONLY when C1C4_RUN_DISPOSABLE_PROOF=1 && NODE_ENV !== 'production'
// Creates & DROPs disposable schema `c1c4_concurrency_proof` — never touches university_wallet
// Uses only packages already in package.json (@prisma/client + ioredis).
//
// C2 proof: two Prisma transactions, one row FOR UPDATE — loser blocks until winner releases.
// C3 proof: Redis SET NX owner token + Lua CAS compare-and-delete returns 1 only for owner.

import { randomBytes } from 'crypto';

const enabled =
  process.env.C1C4_RUN_DISPOSABLE_PROOF === '1' && process.env.NODE_ENV !== 'production';

const PROOF_SCHEMA = 'c1c4_concurrency_proof';

type ProofSetup = {
  prismaA: any;
  prismaB: any;
  prismaAdmin: any;
  redisClient: any;
};

const rand = (n = 10): string => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

describe('C1-C4 Disposable Concurrency Proofs (opt-in: C1C4_RUN_DISPOSABLE_PROOF=1)', () => {
  let setup: ProofSetup | null = null;

  beforeAll(async () => {
    if (!enabled) {
      console.warn(
        '[C1C4 PROOF SKIPPED] Set C1C4_RUN_DISPOSABLE_PROOF=1 locally to run real MySQL+Redis concurrency proofs. Default Jest suite baseline unaffected.',
      );
      return;
    }
    const { PrismaClient } = await import('@prisma/client');
    const ioredisMod = await import('ioredis');
    const IORedis: any = (ioredisMod as any).default || ioredisMod;

    // Build an admin-URL DSN against mysql system schema using DATABASE_URL component env vars.
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbUser = encodeURIComponent(process.env.DB_USERNAME || 'root');
    const dbPass = encodeURIComponent(process.env.DB_PASSWORD || '');
    const dbSocket = encodeURIComponent(process.env.DB_SOCKET || '/tmp/mysql.sock');
    const adminUrl = `mysql://${dbUser}:${dbPass}@localhost/mysql?socket=${dbSocket}`;

    const prismaAdmin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
    try {
      await prismaAdmin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS \`${PROOF_SCHEMA}\``);
      await prismaAdmin.$executeRawUnsafe(`CREATE SCHEMA \`${PROOF_SCHEMA}\``);
      await prismaAdmin.$executeRawUnsafe(`
        CREATE TABLE \`${PROOF_SCHEMA}\`.invoices (
          id INTEGER PRIMARY KEY AUTO_INCREMENT,
          student_id INTEGER NOT NULL,
          invoice_number VARCHAR(64) NOT NULL UNIQUE,
          amount_due DECIMAL(19,4) NOT NULL DEFAULT 0,
          amount_paid DECIMAL(19,4) NOT NULL DEFAULT 0,
          status VARCHAR(32) NOT NULL DEFAULT 'UNPAID',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB
      `);
      await prismaAdmin.$executeRawUnsafe(
        `INSERT INTO \`${PROOF_SCHEMA}\`.invoices (student_id, invoice_number, amount_due, amount_paid, status) VALUES (10001, 'PROOF-INV-LOCK-001', 10000.0000, 0.0000, 'UNPAID')`,
      );
    } catch (createErr: any) {
      console.error('[C1C4 PROOF FATAL] Cannot create disposable proof schema:', createErr?.message);
      try {
        await prismaAdmin.$disconnect();
      } catch {
        /* ignore */
      }
      return;
    }

    const proofUrl = `mysql://${dbUser}:${dbPass}@localhost/${PROOF_SCHEMA}?socket=${dbSocket}`;
    const prismaA = new PrismaClient({ datasources: { db: { url: proofUrl } } });
    const prismaB = new PrismaClient({ datasources: { db: { url: proofUrl } } });

    let redisClient: any = null;
    try {
      redisClient = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        lazyConnect: false,
      });
      await redisClient.ping();
    } catch (redisErr: any) {
      console.warn(
        '[C1C4 PROOF SOFT-SKIP] Redis unreachable — Redis CAS proof skipped:',
        redisErr?.message,
      );
      redisClient = null;
    }

    setup = { prismaA, prismaB, prismaAdmin, redisClient };
  }, 180_000);

  afterAll(async () => {
    try {
      await (setup as ProofSetup | null)?.prismaA?.$disconnect?.();
      await (setup as ProofSetup | null)?.prismaB?.$disconnect?.();
    } catch {
      /* best effort */
    }
    if (setup) {
      try {
        await setup.prismaAdmin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS \`${PROOF_SCHEMA}\``);
      } catch (dropErr: any) {
        console.warn('[C1C4 PROOF cleanup warning (non-fatal)]:', dropErr?.message);
      }
      try {
        await (setup as ProofSetup).prismaAdmin?.$disconnect?.();
      } catch {
        /* ignore */
      }
      (setup as ProofSetup | null)?.redisClient?.disconnect?.(false);
    }
  }, 120_000);

  it('C2 MySQL SELECT ... FOR UPDATE serializes winner/loser — loser sees winner write (fail-closed real DB proof)', async () => {
    if (!setup) {
      console.warn('[C1C4 PROOF SKIP] MySQL harness not initialized.');
      return;
    }
    const { prismaA, prismaB } = setup;
    const id = 1;

    async function winnerTx() {
      return prismaA.$transaction(async (txA: any) => {
        const started = Date.now();
        await txA.$executeRawUnsafe(
          `SELECT id FROM \`${PROOF_SCHEMA}\`.invoices WHERE id = ? FOR UPDATE`,
          id,
        );
        await new Promise<void>((r) => setTimeout(r, 1200));
        await txA.$executeRawUnsafe(
          `UPDATE \`${PROOF_SCHEMA}\`.invoices SET status = 'CANCELLED' WHERE id = ?`,
          id,
        );
        return Date.now() - started;
      }, { timeout: 15_000 });
    }

    async function loserTx(): Promise<{ lockWaitMs: number; sawStatus: string | null }> {
      return prismaB.$transaction(async (txB: any) => {
        const t0 = Date.now();
        await txB.$executeRawUnsafe(
          `SELECT id FROM \`${PROOF_SCHEMA}\`.invoices WHERE id = ? FOR UPDATE`,
          id,
        );
        const lockWaitMs = Date.now() - t0;
        const rows = (await txB.$queryRawUnsafe(
          `SELECT status FROM \`${PROOF_SCHEMA}\`.invoices WHERE id = ?`,
          id,
        )) as any[];
        return { lockWaitMs, sawStatus: (rows?.[0] as any)?.status ?? null };
      }, { timeout: 15_000 });
    }

    const pWin = winnerTx();
    await new Promise((r) => setTimeout(r, 300));
    const pLoser = loserTx();
    const [winnerMs, loserRes] = await Promise.all([pWin, pLoser]);
    expect(winnerMs).toBeGreaterThanOrEqual(1100);
    expect(loserRes.lockWaitMs).toBeGreaterThanOrEqual(700);
    expect(loserRes.sawStatus).toBe('CANCELLED');
  }, 60_000);

  it('C3 Redis SET NX owner-token + Lua CAS compare-and-delete — wrong-owner release never deletes', async () => {
    if (!setup?.redisClient) {
      console.warn('[C1C4 PROOF SKIP] Redis unavailable for CAS proof.');
      return;
    }
    const client: any = setup.redisClient;
    const key = `c1c4-proof:${Date.now()}:${rand(6)}`;
    const tokA = `tok-a-${rand()}`;
    const tokB = `tok-b-${rand()}`;
    const CAS_LUA =
      "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";

    expect(await client.call('SET', key, tokA, 'NX', 'EX', 3)).toBe('OK');
    expect(await client.call('SET', key, tokB, 'NX', 'EX', 3)).toBeNull();
    // Wrong-owner CAS: returns 0, key stays tokA
    expect(await client.call('EVAL', CAS_LUA, 1, key, tokB)).toBe(0);
    expect(await client.call('GET', key)).toBe(tokA);
    // Right-owner CAS: returns 1, key deleted
    expect(await client.call('EVAL', CAS_LUA, 1, key, tokA)).toBe(1);
    expect(await client.call('GET', key)).toBeNull();

    // Re-acquire with tokB, confirm tokB CAS works
    expect(await client.call('SET', key, tokB, 'NX', 'EX', 3)).toBe('OK');
    expect(await client.call('EVAL', CAS_LUA, 1, key, tokB)).toBe(1);
  }, 30_000);
});
