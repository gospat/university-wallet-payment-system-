-- ==============================================================
-- 20261016000010_fix_student_category_fk_relationship_guard
-- ==============================================================
-- Forward-only corrective migration.
--
-- Migration 20261016000009 (and every earlier migration) is NOT modified.
-- This migration complements 0009's student_categories.createdById
-- foreign-key step, whose guard tested only the constraint NAME:
--
--     CONSTRAINT_NAME = 'student_categories_createdById_fkey'
--
-- A name-only guard is insufficient. An environment may already hold the
-- required relationship
--
--     student_categories.createdById -> users.id
--       ON DELETE SET NULL ON UPDATE CASCADE
--
-- under a DIFFERENT constraint name, because it was created manually,
-- out-of-band, or by another schema-synchronisation process. MySQL 8/9
-- permits two foreign keys over the same column and reference, so in that
-- situation 0009 can add a redundant SECOND foreign key.
--
-- This migration consequently reasons about the RELATIONSHIP, not the name.
-- It joins information_schema.KEY_COLUMN_USAGE (table/column ->
-- referenced table/column) with information_schema.REFERENTIAL_CONSTRAINTS
-- (UPDATE_RULE / DELETE_RULE) to answer:
--
--     "is student_categories.createdById already correctly related to
--      users.id, regardless of what the constraint is called?"
--
-- Behaviour
--   1. If any foreign key already relates student_categories.createdById to
--      users.id but with referential actions other than
--      ON DELETE SET NULL / ON UPDATE CASCADE, no destructive automatic
--      replacement is performed: the migration aborts with a
--      self-describing error so the mismatch is REPORTED for a deliberate
--      manual decision.
--   2. If no foreign key relates the two columns at all, the canonical
--      constraint is added.
--   3. If the relationship already exists — under ANY name — it is left in
--      place. A constraint-NAME difference alone is not a schema defect and
--      the existing constraint is never dropped merely because of its name.
--      Should 0009 have ALREADY added the canonically-named constraint
--      alongside a pre-existing, differently-named but functionally
--      identical one, the redundant canonical duplicate is removed so that
--      exactly ONE constraint enforces the relationship. Dropping a
--      byte-for-byte redundant duplicate is demonstrably safe: the
--      relationship and its actions remain enforced by the retained
--      constraint, and the pre-existing (differently-named) production
--      constraint is preserved.
--   4. The supporting index is treated as present only when createdById is
--      the LEADING column of an index (SEQ_IN_INDEX = 1) — the position a
--      foreign key actually requires. An unrelated index that merely
--      CONTAINS createdById in a non-leading position does not satisfy the
--      guard.
--
-- The earlier corrections delivered by 0009 are preserved verbatim:
--   * student_categories.createdById foreign key (steps 1-3 below)
--   * import_runs.filePath reconciliation  VARCHAR(512) -> VARCHAR(191)
--   * fees.studentType                 appended with TOP_UP
--   * fee_assignments.targetStudentType appended with TOP_UP
--
-- Safety
--   * forward-only: no existing migration file is altered.
--   * idempotent: safe on a database where every correction is already
--     present, and on one where none is.
--   * every statement is probed through information_schema and executed via
--     SET @ddl / PREPARE / EXECUTE — the only guard that survives Prisma
--     Migrate's naive `;` splitting (no DELIMITER / stored procedures), the
--     same pattern already used by 20261016000008 and 20261016000009.
--     SIGNAL cannot be used here: MySQL rejects it inside the
--     prepared-statement protocol (ERROR 1295), so the "fail safely /
--     report" branch deliberately selects a non-existent column, which
--     aborts the migration with a self-describing error instead of silently
--     proceeding.
--   * touches ONLY student_categories (and its relation to users),
--     import_runs, and the StudentType ENUM column TYPE of fees /
--     fee_assignments. NO payment, receipt, refund, settlement, invoice,
--     general-ledger, balance or webhook table/data is read or modified, and
--     no fee row/column value is changed (enum APPEND is metadata-only).
-- ==============================================================

-- ------------------------------------------------------------------
-- 0. Fail safely when the relationship already exists with WRONG
--    referential actions.
--    If student_categories.createdById is already related to users.id
--    under ANY constraint name, but with actions other than
--    ON DELETE SET NULL / ON UPDATE CASCADE, no destructive automatic
--    replacement is performed. A non-existent column is selected so the
--    migration aborts with a self-describing error and the mismatch is
--    reported rather than silently "fixed".
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) > 0,
    'SELECT `ERROR_student_categories_createdById_FK_actions_mismatch`',
    'SELECT 1')
    FROM information_schema.KEY_COLUMN_USAGE kcu
    JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
      ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
     AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
     AND rc.TABLE_NAME        = kcu.TABLE_NAME
    WHERE kcu.TABLE_SCHEMA = DATABASE()
      AND kcu.TABLE_NAME = 'student_categories'
      AND kcu.COLUMN_NAME = 'createdById'
      AND kcu.REFERENCED_TABLE_NAME = 'users'
      AND kcu.REFERENCED_COLUMN_NAME = 'id'
      AND (rc.DELETE_RULE <> 'SET NULL' OR rc.UPDATE_RULE <> 'CASCADE'));
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 1. Supporting index on student_categories.createdById.
--    The index counts as present ONLY when createdById is the LEADING
--    column (SEQ_IN_INDEX = 1) — the position a foreign key requires. An
--    arbitrary index that merely contains createdById in a non-leading
--    position does NOT satisfy the guard.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'CREATE INDEX `student_categories_createdById_fkey` ON `student_categories`(`createdById`)',
    'SELECT 1')
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'student_categories'
      AND COLUMN_NAME = 'createdById'
      AND SEQ_IN_INDEX = 1);
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 2. Ensure the relationship exists — reasoned about by RELATIONSHIP,
--    not by name. The canonical constraint is added ONLY when no foreign
--    key at all relates student_categories.createdById to users.id, so a
--    pre-existing, correctly-related constraint under a different name is
--    never followed by a redundant second one.
--    (Step 0 guarantees that anything already present here carries the
--     required referential actions.)
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `student_categories` ADD CONSTRAINT `student_categories_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
    'SELECT 1')
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'student_categories'
      AND COLUMN_NAME = 'createdById'
      AND REFERENCED_TABLE_NAME = 'users'
      AND REFERENCED_COLUMN_NAME = 'id');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 3. Remove a redundant canonically-named duplicate.
--    If 0009 already added `student_categories_createdById_fkey` while a
--    pre-existing, differently-named constraint (same column, same
--    reference, same actions) was present, two foreign keys now enforce the
--    identical relationship. Exactly ONE is kept: the PRE-EXISTING
--    (differently-named) constraint is preserved — its name is not a
--    defect — and the redundant canonical duplicate is dropped. This is
--    safe because the retained constraint continues to enforce both the
--    relationship and its referential actions. Idempotent: once the
--    duplicate is gone the guard evaluates false.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(
      (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'student_categories'
           AND COLUMN_NAME = 'createdById'
           AND REFERENCED_TABLE_NAME = 'users'
           AND REFERENCED_COLUMN_NAME = 'id'
           AND CONSTRAINT_NAME <> 'student_categories_createdById_fkey') > 0
      AND (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE()
           AND TABLE_NAME = 'student_categories'
           AND CONSTRAINT_TYPE = 'FOREIGN KEY'
           AND CONSTRAINT_NAME = 'student_categories_createdById_fkey') > 0,
    'ALTER TABLE `student_categories` DROP FOREIGN KEY `student_categories_createdById_fkey`',
    'SELECT 1'));
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 4. import_runs.filePath: align with schema.prisma (VARCHAR(191)).
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
-- 5. fees.studentType: append TOP_UP. Skipped when the column already
--    lists TOP_UP, so it is safe on a database where the enum was widened
--    out-of-band or by `prisma db push`.
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
-- 6. fee_assignments.targetStudentType: append TOP_UP. Skipped when the
--    column already lists TOP_UP.
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
