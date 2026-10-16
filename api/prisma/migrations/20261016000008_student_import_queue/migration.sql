-- ==============================================================
-- 20261016000008_student_import_queue
-- Background, chunked, restart-safe student bulk import.
--
-- Moves the per-row student creation out of the HTTP request and into a
-- BullMQ-driven engine that records live progress in the database:
--   * import_runs  — one row per import batch (counters + strategy)
--   * import_rows  — one row per uploaded CSV/XLSX record (status + payload)
--
-- Safety (this database may ALREADY contain out-of-band copies of both maps
-- because the tables were created before Prisma Migrate was adopted, and
-- `0000_init_baseline` is only a 1-line placeholder):
--   * EVERYTHING here is ADDITIVE and IDEMPOTENT — safe to run repeatedly.
--   * brand-new databases get both tables (with the new columns) in one shot.
--   * pre-existing databases only receive the 4 new columns that are missing,
--     plus the (metadata-only) ENUM widening of import_rows.status.
--   * no existing column/table is dropped, renamed or reordered.
--   * no payment, receipt, settlement, invoice, GL, refund or balance data is
--     touched in any way.
--
-- WHY the guarded `SET @ddl / PREPARE / EXECUTE` form below:
--   Prisma's migration runner is unable to catch SQL errors, and MySQL 8 has
--   no `ADD COLUMN IF NOT EXISTS`. A stored procedure is not usable either
--   because Prisma splits a migration file naively on `;` and therefore does
--   not support `DELIMITER`. Building the DDL into a session variable and
--   executing it only when information_schema reports the column missing is
--   the one guard that survives Prisma's naive `;` splitting — each of the
--   individual statements here is standalone and semicolon-terminated.
-- ==============================================================

-- CreateTable: import_runs (skipped on a database that already has it) --------
CREATE TABLE IF NOT EXISTS `import_runs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `uuid` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `filePath` VARCHAR(512) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `createdById` INTEGER NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `totalRows` INTEGER NOT NULL DEFAULT 0,
    `successCount` INTEGER NOT NULL DEFAULT 0,
    `failCount` INTEGER NOT NULL DEFAULT 0,
    `skippedCount` INTEGER NOT NULL DEFAULT 0,
    `strategy` VARCHAR(16) NOT NULL DEFAULT 'SKIP',

    UNIQUE INDEX `import_runs_uuid_key`(`uuid`),
    INDEX `import_runs_createdById_idx`(`createdById`),
    INDEX `import_runs_startedAt_idx`(`startedAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `import_runs_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: import_rows (skipped on a database that already has it) --------
CREATE TABLE IF NOT EXISTS `import_rows` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `importRunId` INTEGER NOT NULL,
    `rowNumber` INTEGER NOT NULL,
    `firstName` VARCHAR(191) NOT NULL,
    `lastName` VARCHAR(191) NOT NULL,
    `email` VARCHAR(254) NULL,
    `matricNumber` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'SUCCESS', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `errorMessage` TEXT NULL,
    `studentId` INTEGER NULL,
    `passwordSent` BOOLEAN NOT NULL DEFAULT FALSE,
    `payload` JSON NULL,
    `temporaryPassword` VARCHAR(191) NULL,

    UNIQUE INDEX `import_rows_importRunId_rowNumber_key`(`importRunId`, `rowNumber`),
    INDEX `import_rows_importRunId_idx`(`importRunId`),
    INDEX `import_rows_status_idx`(`status`),
    INDEX `import_rows_studentId_idx`(`studentId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `import_rows_importRunId_fkey` FOREIGN KEY (`importRunId`) REFERENCES `import_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `import_rows_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable: import_runs.skippedCount — added only when still missing --------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `import_runs` ADD COLUMN `skippedCount` INTEGER NOT NULL DEFAULT 0',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'import_runs' AND COLUMN_NAME = 'skippedCount');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- AlterTable: import_runs.strategy — added only when still missing ------------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `import_runs` ADD COLUMN `strategy` VARCHAR(16) NOT NULL DEFAULT ''SKIP''',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'import_runs' AND COLUMN_NAME = 'strategy');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- AlterTable: import_rows.payload — added only when still missing -------------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `import_rows` ADD COLUMN `payload` JSON NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'import_rows' AND COLUMN_NAME = 'payload');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- AlterTable: import_rows.temporaryPassword — added only when still missing ---
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `import_rows` ADD COLUMN `temporaryPassword` VARCHAR(191) NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'import_rows' AND COLUMN_NAME = 'temporaryPassword');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- AlterTable: widen import_rows.status enum with SKIPPED.
-- Appending an enum member at the END is metadata-only in MySQL 8 (no row
-- rewrite), so this is idempotent by nature and deliberately left unguarded.
ALTER TABLE `import_rows`
    MODIFY COLUMN `status` ENUM('PENDING', 'SUCCESS', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING';
