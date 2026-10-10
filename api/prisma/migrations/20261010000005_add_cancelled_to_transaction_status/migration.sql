-- Migration 0005: Add CANCELLED to TransactionStatus enum (forward-only, non-destructive)
-- This is a non-financial terminal state for abandoned/voided payment attempts.
-- NO data is updated: existing rows with PENDING/PROCESSING/SUCCESS/FAILED/UNDERPAID/OVERPAID/REVERSED are untouched.
-- DO NOT edit after push; Prisma tracks applied migrations by file name in _prisma_migrations.

ALTER TABLE `transactions`
  MODIFY COLUMN `status` ENUM('PENDING','PROCESSING','SUCCESS','FAILED','UNDERPAID','OVERPAID','CANCELLED','REVERSED')
    NOT NULL
    DEFAULT 'PENDING';
