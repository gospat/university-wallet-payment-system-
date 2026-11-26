-- ==============================================================
-- 20261019000013_add_mfa
-- ==============================================================
-- TOTP multi-factor authentication: additive, backward-compatible DDL only.
--
-- Adds to the existing `users` table:
--   * mfaEnabled     TINYINT(1) NOT NULL DEFAULT 0   — factor is active?
--   * mfaSecret      TEXT NULL                       — AES-256-CBC encrypted TOTP secret
--   * mfaEnrolledAt  DATETIME(3) NULL                — confirmation timestamp
-- and one brand-new table `mfa_recovery_codes` (single-use bcrypt-hashed codes).
--
-- Safety
--   * Fully ADDITIVE — no column is dropped, renamed or retyped; no existing
--     value is rewritten. Every existing row immediately becomes a valid,
--     MFA-disabled user (mfaEnabled = 0, mfaSecret = NULL).
--   * Touches ONLY `users` and the new `mfa_recovery_codes`. No payment,
--     transaction, receipt, invoice, refund, settlement, ledger, reconciliation
--     or webhook table is read or modified, and no historical data is altered.
--   * Idempotent: safe when the change is fully present, partially present
--     (created out-of-band or by `prisma db push`) or entirely absent.
--   * MySQL has no `ADD COLUMN IF NOT EXISTS`; every ALTER is probed through
--     information_schema and executed via SET @ddl / PREPARE / EXECUTE — the
--     established guard of this repo (see 20261016000011). SIGNAL is
--     deliberately NOT used (MySQL rejects it in the prepared-statement
--     protocol, ERROR 1295).
--   * Prisma Migrate splits this file on `;`, so every statement below is
--     standalone and semicolon-terminated (no `;` inside comments/strings).
-- ==============================================================

-- ------------------------------------------------------------------
-- 1. users.mfaEnabled — added only when the column is still missing.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `users` ADD COLUMN `mfaEnabled` TINYINT(1) NOT NULL DEFAULT 0',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
      AND COLUMN_NAME = 'mfaEnabled');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 2. users.mfaSecret — nullable encrypted TOTP secret.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `users` ADD COLUMN `mfaSecret` TEXT NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
      AND COLUMN_NAME = 'mfaSecret');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 3. users.mfaEnrolledAt — nullable confirmation timestamp.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `users` ADD COLUMN `mfaEnrolledAt` DATETIME(3) NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
      AND COLUMN_NAME = 'mfaEnrolledAt');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 4. mfa_recovery_codes — one row per single-use recovery code. The FK on
--    `userId` is ON DELETE CASCADE (deleting a user removes their codes).
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `mfa_recovery_codes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `codeHash` VARCHAR(255) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `mfa_recovery_codes_userId_usedAt_idx`(`userId`, `usedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 5. mfa_recovery_codes.userId -> users.id (ON DELETE CASCADE) — added only
--    when the constraint is still missing.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `mfa_recovery_codes` ADD CONSTRAINT `mfa_recovery_codes_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
    'SELECT 1')
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'mfa_recovery_codes'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME = 'mfa_recovery_codes_userId_fkey');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;
