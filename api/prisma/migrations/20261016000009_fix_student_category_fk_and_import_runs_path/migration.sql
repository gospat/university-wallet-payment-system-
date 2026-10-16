-- ==============================================================
-- 20261016000009_fix_student_category_fk_and_import_runs_path
-- ==============================================================
-- Forward-only schema reconciliation.
--
-- Historical migrations 20261015000007_student_categories and
-- 20261016000008_student_import_queue are NOT modified — they may already
-- have been applied in development/staging environments.
--
-- Independent pre-production review found the physical database produced by
-- applying the existing migration sequence can differ from the final
-- schema.prisma in four places:
--
--   MISMATCH 1 — student_categories.createdById has no foreign key.
--     schema.prisma declares:
--       createdBy User? @relation("StudentCategoryCreator",
--                                 fields: [createdById], references: [id],
--                                 onDelete: SetNull)
--     but migration 0007 created the column WITHOUT the constraint, so the
--     physical database can be inconsistent with the schema. This migration
--     adds:
--       student_categories.createdById -> users(id)
--         ON DELETE SET NULL ON UPDATE CASCADE
--     together with its supporting index — each only when absent.
--
--   MISMATCH 2 — import_runs.filePath is VARCHAR(512).
--     schema.prisma declares `filePath String` (=> VARCHAR(191)); migration
--     0008 created it as VARCHAR(512). This migration narrows it to 191, but
--     ONLY when no stored value would be truncated (see step 3 below).
--
--   MISMATCH 3 — fees.studentType is missing the TOP_UP enum member.
--   MISMATCH 4 — fee_assignments.targetStudentType is missing TOP_UP.
--     TOP_UP was appended to schema.prisma's shared `enum StudentType` in the
--     same change-set that introduced migration 0007. Three columns use that
--     enum; 0007 widened only `users.studentType`, leaving these two columns
--     stale. Appending an ENUM member at the END is metadata-only in
--     MySQL 8 (no row rewrite) and each statement is skipped when the column
--     already carries TOP_UP.
--
-- Safety
--   * forward-only: no existing migration file is altered.
--   * idempotent and safe BOTH when the FK/index/enum members do NOT yet
--     exist and when they ALREADY exist (created out-of-band, or via
--     `prisma db push`).
--   * every ALTER is probed through information_schema and executed via
--     SET @ddl / PREPARE / EXECUTE — the only guard that survives Prisma
--     Migrate's naive `;` splitting (no DELIMITER / stored procedures), and
--     the same pattern already used by 20261016000008.
--   * touches ONLY student_categories (and its relation to users),
--     import_runs, and the StudentType ENUM column TYPE of fees /
--     fee_assignments. NO payment, receipt, refund, settlement, invoice,
--     general-ledger, balance or webhook table/data is read or modified, and
--     no fee row/column value is changed (enum APPEND is metadata-only).
-- ==============================================================

-- ------------------------------------------------------------------
-- 1. Supporting index on student_categories.createdById.
--    Created only when no index currently covers that column, so an
--    environment that already created the FK (and therefore already has
--    MySQL's supporting index) is left untouched. The name matches the
--    constraint, which is exactly what MySQL / `prisma db push` produce,
--    keeping the final physical state drift-free.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'CREATE INDEX `student_categories_createdById_fkey` ON `student_categories`(`createdById`)',
    'SELECT 1')
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'student_categories'
      AND COLUMN_NAME = 'createdById');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 2. The foreign key itself — added only when it does not already exist,
--    so a duplicate-constraint failure is impossible.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `student_categories` ADD CONSTRAINT `student_categories_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
    'SELECT 1')
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'student_categories'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME = 'student_categories_createdById_fkey');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 3. import_runs.filePath: align with schema.prisma (VARCHAR(191)).
--    Narrowed only when the column is currently wider than 191 AND every
--    stored value already fits within 191 characters. If any longer value
--    exists the MODIFY is skipped rather than risking silent truncation of
--    a live file path; the mismatch is then left for a deliberate, manual
--    decision instead of a data-destroying migration.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(
      (SELECT COUNT(*) FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'import_runs'
           AND COLUMN_NAME = 'filePath'
           AND CHARACTER_MAXIMUM_LENGTH <> 191) = 1
      AND (SELECT COALESCE(MAX(CHAR_LENGTH(`filePath`)), 0) FROM `import_runs`) <= 191,
    'ALTER TABLE `import_runs` MODIFY COLUMN `filePath` VARCHAR(191) NOT NULL',
    'SELECT 1'));
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 4. fees.studentType: append TOP_UP (MISMATCH 3). Skipped when the
--    column already lists TOP_UP, so it is safe on a database where the
--    enum was widened out-of-band or by `prisma db push`.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) = 1,
    'ALTER TABLE `fees` MODIFY COLUMN `studentType` ENUM(''UNDERGRADUATE'', ''POSTGRADUATE'', ''PART_TIME'', ''JUPEB'', ''OTHER'', ''TOP_UP'') NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'fees'
      AND COLUMN_NAME = 'studentType'
      AND COLUMN_TYPE NOT LIKE '%TOP_UP%');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 5. fee_assignments.targetStudentType: append TOP_UP (MISMATCH 4).
--    Skipped when the column already lists TOP_UP.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) = 1,
    'ALTER TABLE `fee_assignments` MODIFY COLUMN `targetStudentType` ENUM(''UNDERGRADUATE'', ''POSTGRADUATE'', ''PART_TIME'', ''JUPEB'', ''OTHER'', ''TOP_UP'') NULL',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'fee_assignments'
      AND COLUMN_NAME = 'targetStudentType'
      AND COLUMN_TYPE NOT LIKE '%TOP_UP%');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;
