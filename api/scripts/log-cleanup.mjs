#!/usr/bin/env node
/**
 * log-cleanup.mjs — Production log / ephemeral-data rotation utility.
 *
 * Deletes rows older than N DAYS (default 30) from the following tables:
 *   - AuditLog      (write-only audit trail; safe to rotate after retention)
 *   - WebhookEvent  (gateway webhook records; processed=true drop first)
 *   - StudentImport (bulk upload metadata + JSON error reports; large blobs)
 *   - Refund        (optional; only if --include-refunds is passed)
 *   - Transaction   (pending / failed older than N days, exclude SUCCESS unless --include-success)
 *
 * Intended to be called from a daily/weekly cron job on your production server
 * so log tables don't fill the disk. Runs a batched DELETE (LIMIT per cycle) to
 * avoid long locks. Prints a summary to stdout; use --dry-run to preview counts.
 *
 * Usage examples:
 *   # Delete everything older than 30 days (default retention)
 *   node api/scripts/log-cleanup.mjs
 *
 *   # Longer 90-day retention
 *   node api/scripts/log-cleanup.mjs --days 90
 *
 *   # Preview what would be deleted WITHOUT deleting anything
 *   node api/scripts/log-cleanup.mjs --dry-run --days 14
 *
 *   # Also vacuum successful transactions older than 365 days
 *   node api/scripts/log-cleanup.mjs --days 365 --include-success-tx
 *
 * Crontab example (run nightly at 2:17 AM server time, stdout/stderr to log):
 *   17 2 * * *  cd /var/www/university-payment && /usr/bin/node api/scripts/log-cleanup.mjs --days 30 >> storage/logs/prune.log 2>&1
 */
import { PrismaClient } from '@prisma/client';
import process from 'node:process';

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = { days: 30, dryRun: false, includeSuccessTx: false, includeRefunds: false, batchSize: 500 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days' && argv[i + 1]) args.days = Math.max(1, Number(argv[++i]));
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--include-success-tx') args.includeSuccessTx = true;
    else if (a === '--include-refunds') args.includeRefunds = true;
    else if (a === '--batch-size' && argv[i + 1]) args.batchSize = Math.max(1, Number(argv[++i]));
    else if (a === '--help' || a === '-h') {
      console.log([
        'Usage: node log-cleanup.mjs [options]',
        '',
        'Options:',
        '  --days N              Retention window in days (default 30). Rows older',
        '                        than (now - N days) are pruned.',
        '  --dry-run             Preview DELETE counts without deleting anything.',
        '  --batch-size N        Rows per DELETE cycle (default 500). Lower this if',
        '                        your MySQL Galera / Aurora cluster hates big writes.',
        '  --include-success-tx  Also prune SUCCESS transactions (and linked',
        '                        receipts/invoices!) older than the window.',
        '  ******************************************************************',
        '  *  --include-success-tx WARNING:                               *',
        '  *  Removes SUCCESS receipts + invoices older than N days.       *',
        '  *  DO NOT use unless you archive them externally first.        *',
        '  ******************************************************************',
        '  --include-refunds     Also prune REJECTED / FINALIZED refund records',
        '                        (REQUESTED/APPROVED are always preserved).',
      ].join('\n'));
      process.exit(0);
    }
  }
  return args;
}

async function countWhere(model, where) {
  try { return await model.count({ where }); } catch { return 0; }
}

async function deleteBatched(model, whereClause, batchSize, label, dryRun) {
  let total = 0;
  for (let cycle = 0; cycle < 1_000_000; cycle++) {
    // Prisma doesn't support DELETE ... LIMIT in a portable way — select IDs first.
    const ids = await model.findMany({ where: whereClause, take: batchSize, select: { id: true } });
    if (!ids.length) break;
    const chunk = ids.map((r) => r.id);
    let deleted = 0;
    if (!dryRun) {
      const res = await model.deleteMany({ where: { id: { in: chunk } } });
      deleted = res.count ?? 0;
    } else {
      deleted = chunk.length;
    }
    total += deleted;
    if (chunk.length < batchSize) break;
  }
  const action = dryRun ? 'WOULD DELETE' : 'DELETED';
  console.log(`  · ${String(label).padEnd(22)} ${action}: ${total.toLocaleString()}`);
  return total;
}

async function main() {
  const opts = parseArgs(process.argv);
  const cutoff = new Date(Date.now() - opts.days * 86_400_000);
  console.log(`[log-cleanup] mode=${opts.dryRun ? 'DRY-RUN' : 'APPLY'}  retention=${opts.days}d  cutoff=${cutoff.toISOString()}  batch=${opts.batchSize}`);
  if (opts.includeSuccessTx) console.log('[log-cleanup] ⚠️  --include-success-tx is ON: successful payments, invoices, and receipts older than the window WILL BE DELETED');

  const totals = {};

  // 1) AuditLogs — write-only trail; rotate freely after retention.
  totals.auditLogs = await deleteBatched(
    prisma.auditLog,
    { createdAt: { lt: cutoff } },
    opts.batchSize,
    'AuditLog',
    opts.dryRun,
  );

  // 1b) AdminNotification — in-app toast/messages; read ones rotated freely.
  totals.adminNotifs = await deleteBatched(
    prisma.adminNotification,
    {
      OR: [
        { readAt: { lt: cutoff } },
        { createdAt: { lt: cutoff }, readAt: null, severity: 'INFO' },
      ],
    },
    opts.batchSize,
    'AdminNotification',
    opts.dryRun,
  );

  // 2) WebhookEvent — processed first (they were consumed), then unprocessed older than window.
  const processedBefore = await countWhere(prisma.webhookEvent, {
    isProcessed: true, createdAt: { lt: cutoff },
  });
  totals.webhookProcessed = await deleteBatched(
    prisma.webhookEvent,
    { isProcessed: true, createdAt: { lt: cutoff } },
    opts.batchSize,
    'WebhookEvent (processed)',
    opts.dryRun,
  );
  totals.webhookStale = await deleteBatched(
    prisma.webhookEvent,
    { isProcessed: false, attempts: { gte: 5 }, createdAt: { lt: cutoff } },
    opts.batchSize,
    'WebhookEvent (stale 5+)',
    opts.dryRun,
  );

  // 3) StudentImport batches (these carry potentially big errorReport JSON blobs).
  totals.studentImports = await deleteBatched(
    prisma.studentImport,
    { createdAt: { lt: cutoff } },
    opts.batchSize,
    'StudentImport batch',
    opts.dryRun,
  );

  // 4) FeeAssignment direct-bill rows marked INACTIVE (dead history) older than window.
  totals.inactiveAssignments = await deleteBatched(
    prisma.feeAssignment,
    { isActive: false, assignedAt: { lt: cutoff } },
    opts.batchSize,
    'FeeAssignment (inactive)',
    opts.dryRun,
  );

  // 5) PENDING / FAILED transactions + unpaid invoices (nothing was collected, safe to sweep).
  const ephemeralTxStatus = ['PENDING', 'FAILED', 'EXPIRED', 'ABANDONED'];
  totals.nonSuccessTx = await deleteBatched(
    prisma.transaction,
    { status: { in: ephemeralTxStatus }, createdAt: { lt: cutoff } },
    opts.batchSize,
    'Tx (non-SUCCESS)',
    opts.dryRun,
  );
  totals.unpaidInvoices = await deleteBatched(
    prisma.invoice,
    { status: { in: ['UNPAID', 'CANCELLED'] }, createdAt: { lt: cutoff } },
    opts.batchSize,
    'Invoice (UNPAID/XCELD)',
    opts.dryRun,
  );

  // 6) Optional: finalized refunds older than the window.
  if (opts.includeRefunds) {
    totals.finalizedRefunds = await deleteBatched(
      prisma.refund,
      { status: { in: ['REJECTED', 'PAID'] }, createdAt: { lt: cutoff } },
      opts.batchSize,
      'Refund (finalized)',
      opts.dryRun,
    );
  }

  // 7) DANGER ZONE — SUCCESS tx + linked receipts/invoices.
  if (opts.includeSuccessTx) {
    // receipts first (they reference transactionId + invoiceId + studentId FKs)
    totals.receiptsOld = await deleteBatched(
      prisma.receipt,
      { paidAt: { lt: cutoff }, isVoided: false },
      opts.batchSize,
      'Receipt (paid old)',
      opts.dryRun,
    );
    // then voided receipts
    totals.receiptsVoided = await deleteBatched(
      prisma.receipt,
      { isVoided: true, voidedAt: { lt: cutoff } },
      opts.batchSize,
      'Receipt (voided old)',
      opts.dryRun,
    );
    // SUCCESS transactions
    totals.successTx = await deleteBatched(
      prisma.transaction,
      { status: 'SUCCESS', createdAt: { lt: cutoff } },
      opts.batchSize,
      'Tx (SUCCESS old)',
      opts.dryRun,
    );
    // PAID invoices (status becomes PAID/UNDERPAID once cash received)
    totals.paidInvoices = await deleteBatched(
      prisma.invoice,
      { status: { in: ['PAID', 'UNDERPAID', 'OVERPAID'] }, paidAt: { lt: cutoff } },
      opts.batchSize,
      'Invoice (PAID old)',
      opts.dryRun,
    );
  }

  const grandTotal = Object.values(totals).reduce((a, b) => a + (Number(b) || 0), 0);
  console.log(`[log-cleanup] done.  grand total ${opts.dryRun ? 'affected' : 'removed'}: ${grandTotal.toLocaleString()} rows`);
}

main()
  .catch((e) => {
    console.error('[log-cleanup] FATAL:', e);
    process.exit(1);
  })
  .finally(async () => { await prisma.$disconnect(); });
