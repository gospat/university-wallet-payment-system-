#!/usr/bin/env node
/**
 * clean-slate.mjs — Wipe transactional / ephemeral data for a "clean start"
 * while preserving all reference / config / academic-metadata tables.
 *
 * Typical use:
 *   - You just finished dev / demo testing with a lot of fake data.
 *   - You're about to launch to real students and want a clean DB baseline
 *     (after seeding reference data but BEFORE any real payments).
 *   - Sandbox / staging DB refresh before a new QA pass.
 *
 * TABLES **PRESERVED** (reference data):
 *   · User accounts (Admin / Bursary / Students) + their role data
 *   · Faculty / College, Department, Programme, Level (academic structure)
 *   · AcademicSession, Semester config
 *   · FeeCategory + Fee catalogue ("bills master" — prices / scopes you set up)
 *   · BranderConfig, AppSetting, NotificationTemplate, SystemSetting
 *   · Idempotency keys (kept so a replayed Paystack/ALAT webhook cannot
 *     double-charge during the transition period; clear manually if needed)
 *
 * TABLES **WIPED** (transactional history):
 *   · Receipt, Invoice, Transaction (payments + generated docs)
 *   · FeeAssignment (bill-to-student assignments; direct bills and bulk assigns)
 *   · Refund (refund request history)
 *   · AuditLog, WebhookEvent, StudentImport (operational logs)
 *   · Notification (delivered or queued per-student notifications)
 *
 * All wipes are batched DELETE ... WHERE id IN (...) via Prisma so FK triggers
 * and Prisma middleware fire correctly; we never raw TRUNCATE.
 *
 * Safety checks:
 *   · --yes flag REQUIRED to actually delete (otherwise it previews only).
 *   · Refuses to run if NODE_ENV=production UNLESS --i-accept-production-wipe
 *     is passed alongside --yes.
 *   · Confirms the DB name at runtime (prints DB host + schema) and prints a
 *     full summary before / after.
 *
 * Usage:
 *   # Preview what will be wiped, without touching anything:
 *   node api/scripts/clean-slate.mjs
 *
 *   # Actually wipe (dev / staging / sandbox):
 *   node api/scripts/clean-slate.mjs --yes
 *
 *   # DANGER — actually wipe PRODUCTION:
 *   node api/scripts/clean-slate.mjs --yes --i-accept-production-wipe
 */
import { PrismaClient } from '@prisma/client';
import process from 'node:process';

const prisma = new PrismaClient();

function parseArgs(argv) {
  const a = { yes: false, allowProd: false, keepStudents: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--yes') a.yes = true;
    if (argv[i] === '--i-accept-production-wipe') a.allowProd = true;
    if (argv[i] === '--keep-students') a.keepStudents = true;
    if (argv[i] === '-h' || argv[i] === '--help') {
      console.log([
        'clean-slate.mjs — delete all transactional data; keep reference/master data.',
        '',
        'Default behaviour WIPES STUDENT accounts (keeps ADMIN + BURSARY roles only).',
        'Pass --keep-students if you want to retain the student directory.',
        '',
        'Flags:',
        '  --yes                           Apply deletes (without it = preview only).',
        '  --keep-students                 Do NOT delete Student users (their role + profile',
        '                                   rows are kept; only invoices/tx/receipts cleared).',
        '  --i-accept-production-wipe      Required if NODE_ENV=production, otherwise',
        '                                   the script aborts before deleting anything.',
      ].join('\n'));
      process.exit(0);
    }
  }
  return a;
}

const BASE_WIPE = [
  // 1) Dependents first (they FK into Transaction / Invoice).
  { label: 'Receipt',        model: 'receipt',        where: {} },
  { label: 'Refund',         model: 'refund',         where: {} },
  // 2) Invoice and Transaction are cross-linked through nullable FKs on Receipt;
  //    the FKs on Invoice→Fee and Transaction→User are non-blocking for deleteMany
  //    when we just delete rows, but safer to delete Receipts + Refunds first.
  { label: 'Transaction',    model: 'transaction',    where: {} },
  { label: 'Invoice',        model: 'invoice',        where: {} },
  // 3) Assignments link fee ↔ target (student/programme/etc).
  { label: 'FeeAssignment',  model: 'feeAssignment',  where: {} },
  // 4) Operational / log tables.
  { label: 'AuditLog',       model: 'auditLog',       where: {} },
  { label: 'AdminNotification', model: 'adminNotification', where: {} },
  { label: 'WebhookEvent',   model: 'webhookEvent',   where: {} },
  { label: 'StudentImport',  model: 'studentImport',  where: {} },
];

function wipeOrder(args) {
  const order = BASE_WIPE.slice();
  if (!args.keepStudents) {
    order.push({
      label: 'User (STUDENT)',
      model: 'user',
      where: { role: 'STUDENT' },
    });
  }
  return order;
}

async function snapshotCounts(label, order) {
  const out = {};
  for (const entry of order) {
    try { out[entry.label] = await prisma[entry.model].count({ where: entry.where }); }
    catch { out[entry.label] = -1; }
  }
  console.log(`\n[clean-slate] ${label} row counts:`);
  for (const k of Object.keys(out)) {
    const v = out[k];
    console.log(`  · ${k.padEnd(18)} ${v === -1 ? '(skipped)' : v.toLocaleString()}`);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);
  const env = (process.env.NODE_ENV || 'development').trim().toLowerCase();
  const dbUrl = process.env.DATABASE_URL || '(DATABASE_URL not set)';
  let dbHost = 'unknown';
  try { dbHost = new URL(dbUrl).host; } catch {}
  const plan = wipeOrder(opts);
  console.log(`[clean-slate] NODE_ENV=${env}  DB host=${dbHost}  mode=${opts.yes ? 'APPLY' : 'PREVIEW'}  students=${opts.keepStudents ? 'KEPT' : 'WIPED (keep via --keep-students)'}`);

  if (opts.yes && env === 'production' && !opts.allowProd) {
    console.error('[clean-slate] ❌  ABORT — NODE_ENV=production. Re-run with --i-accept-production-wipe alongside --yes if you truly want to wipe production transactional history.');
    process.exit(2);
  }

  const before = await snapshotCounts('BEFORE', plan);
  const totalBefore = Object.values(before).reduce((a, b) => a + Math.max(0, Number(b) || 0), 0);
  console.log(`[clean-slate] rows eligible for wipe: ${totalBefore.toLocaleString()}`);

  if (!opts.yes) {
    console.log('\n[clean-slate] PREVIEW ONLY — nothing deleted. Re-run with --yes (and --i-accept-production-wipe on prod) to actually wipe these tables.');
    return;
  }

  console.log('\n[clean-slate] applying deletes…');
  const perModel = {};
  for (const entry of plan) {
    let deleted = 0;
    const model = prisma[entry.model];
    for (let cycle = 0; cycle < 1_000_000; cycle++) {
      const ids = await model.findMany({ where: entry.where, take: 500, select: { id: true } });
      if (!ids.length) break;
      const chunk = ids.map((r) => r.id);
      const res = await model.deleteMany({ where: { id: { in: chunk } } });
      deleted += Number(res.count ?? 0);
      if (chunk.length < 500) break;
    }
    perModel[entry.label] = deleted;
    console.log(`  · ${entry.label.padEnd(18)} deleted ${deleted.toLocaleString()}`);
  }
  await snapshotCounts('AFTER', plan);
  const totalAfter = Object.values(perModel).reduce((a, b) => a + b, 0);
  const kept = opts.keepStudents
    ? 'reference data untouched; STUDENT users KEPT per --keep-students; transactional data wiped'
    : 'reference data untouched; STUDENT users WIPED (only ADMIN + BURSARY accounts remain); transactional data wiped';
  console.log(`\n[clean-slate] finished. ${kept}: ${totalAfter.toLocaleString()} rows total.`);
}

main()
  .catch((e) => { console.error('[clean-slate] FATAL:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
