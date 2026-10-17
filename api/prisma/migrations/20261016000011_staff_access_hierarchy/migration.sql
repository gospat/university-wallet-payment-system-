-- ==============================================================
-- 20261016000011_staff_access_hierarchy
-- ==============================================================
-- Hierarchical staff access: a Super-Admin FLAG on role=ADMIN plus a
-- normalized, relational individual-permission overlay (design D1 + D2).
--
-- Forward-only and purely ADDITIVE:
--   * users.isSuperAdmin gets a new NOT NULL DEFAULT 0 column, so every
--     existing row starts as a normal (non-super) user.
--   * two brand-new tables (user_permission_profiles, user_permissions) back
--     the individual-access overlay. Nothing existing is altered.
--   * BACK-COMPAT: every pre-existing ADMIN is flagged isSuperAdmin = 1 exactly
--     once (guarded by a Counter sentinel), preserving the current behaviour in
--     which every ADMIN is an unrestricted super administrator.
--
-- Safety
--   * no existing migration file is altered (forward-only).
--   * nothing is DROPPED or RENAMED and no existing column/value is changed.
--   * NO payment, receipt, refund, settlement, invoice, general-ledger,
--     balance, fee or webhook table/data is read or modified.
--   * idempotent: safe when the change is fully present, partially present
--     (created out-of-band or by `prisma db push`) or entirely absent.
--   * MySQL has no `ADD COLUMN IF NOT EXISTS`; every ALTER is probed through
--     information_schema and executed via SET @ddl / PREPARE / EXECUTE — the
--     established guard of this repo (see 20261016000008/0009/0010) and the
--     only pattern that survives Prisma Migrate's naive `;` splitting.
--     SIGNAL is deliberately NOT used: MySQL rejects it inside the
--     prepared-statement protocol (ERROR 1295) — already proven in this repo.
--   * Prisma Migrate splits this file on `;`, therefore every statement below
--     is standalone and semicolon-terminated (no `;` inside comments/strings).
-- ==============================================================

-- ------------------------------------------------------------------
-- 1. users.isSuperAdmin — added only when the column is still missing.
--    NOT NULL with a DEFAULT, so the ALTER instantiates every existing row as 0
--    (a normal ADMIN) in one online-safe step with no row rewrite of data.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `users` ADD COLUMN `isSuperAdmin` TINYINT(1) NOT NULL DEFAULT 0',
    'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
      AND COLUMN_NAME = 'isSuperAdmin');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 2. user_permission_profiles — one row per user that holds an individual
--    access overlay. `userId` is UNIQUE (at most one profile per user). The FK
--    on `userId` is ON DELETE CASCADE (deleting a user removes the overlay);
--    `updatedById` records the last editor and is ON DELETE SET NULL so an
--    author's deletion never deletes the target's access row.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_permission_profiles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `accessMode` ENUM('INHERIT', 'CUSTOM') NOT NULL DEFAULT 'INHERIT',
    `updatedById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `user_permission_profiles_userId_key`(`userId`),
    INDEX `user_permission_profiles_accessMode_idx`(`accessMode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 3. user_permissions — the selected permission keys of a CUSTOM profile,
--    normalized one row per (profile, permission). The composite UNIQUE
--    prevents duplicates. Both FKs are ON DELETE CASCADE.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_permissions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `profileId` INTEGER NOT NULL,
    `permissionId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `user_permissions_permissionId_idx`(`permissionId`),
    UNIQUE INDEX `user_permissions_profileId_permissionId_key`(`profileId`, `permissionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 4. users(role, isSuperAdmin) — supports the super-admin lookups/counts used
--    by the final-active-super-admin invariant without a table scan. Added
--    only when the index is still missing.
-- ------------------------------------------------------------------
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'CREATE INDEX `users_role_isSuperAdmin_idx` ON `users`(`role`, `isSuperAdmin`)',
    'SELECT 1')
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
      AND INDEX_NAME = 'users_role_isSuperAdmin_idx');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 5. Foreign keys — each added only when the constraint is still missing.
-- ------------------------------------------------------------------
-- 5a. user_permission_profiles.userId -> users.id (ON DELETE CASCADE)
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `user_permission_profiles` ADD CONSTRAINT `user_permission_profiles_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
    'SELECT 1')
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'user_permission_profiles'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME = 'user_permission_profiles_userId_fkey');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- 5b. user_permission_profiles.updatedById -> users.id (ON DELETE SET NULL)
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `user_permission_profiles` ADD CONSTRAINT `user_permission_profiles_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
    'SELECT 1')
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'user_permission_profiles'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME = 'user_permission_profiles_updatedById_fkey');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- 5c. user_permissions.profileId -> user_permission_profiles.id (CASCADE)
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `user_permissions` ADD CONSTRAINT `user_permissions_profileId_fkey` FOREIGN KEY (`profileId`) REFERENCES `user_permission_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
    'SELECT 1')
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'user_permissions'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME = 'user_permissions_profileId_fkey');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- 5d. user_permissions.permissionId -> Permission.id (ON DELETE CASCADE)
SET @ddl = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE `user_permissions` ADD CONSTRAINT `user_permissions_permissionId_fkey` FOREIGN KEY (`permissionId`) REFERENCES `Permission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
    'SELECT 1')
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'user_permissions'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME = 'user_permissions_permissionId_fkey');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ------------------------------------------------------------------
-- 6. BACK-COMPAT data step — every pre-existing ADMIN keeps its current
--    unrestricted capability by being flagged as a Super Admin.
--
--    Runs EXACTLY ONCE, guarded by a sentinel row in the existing `Counter`
--    table (id = 'rbac_staff_hierarchy_20261016'). On any later run the
--    sentinel is present, so the UPDATE is skipped — a clean no-op. No email,
--    id or name is hardcoded: the promoted set is defined solely by
--    `role = 'ADMIN'`.
--
--    The UPDATE is itself idempotent (setting 1 where already 1 is a no-op) and
--    runs BEFORE the sentinel is written, so a crash between the two steps can
--    only cause a harmless re-run of the same UPDATE, never data loss.
-- ------------------------------------------------------------------
SET @rbac_backfilled = (SELECT COUNT(*) FROM `Counter` WHERE `id` = 'rbac_staff_hierarchy_20261016');

SET @ddl = (SELECT IF(@rbac_backfilled = 0,
    'UPDATE `users` SET `isSuperAdmin` = 1 WHERE `role` = ''ADMIN''',
    'SELECT 1'));
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

SET @ddl = (SELECT IF(@rbac_backfilled = 0,
    'INSERT INTO `Counter` (`id`, `value`, `updatedAt`) VALUES (''rbac_staff_hierarchy_20261016'', 1, NOW(3))',
    'SELECT 1'));
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;
