import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../utils/AppError';
import prisma from '../config/database';
import { Role, AccountStatus } from '@prisma/client';
import { catchAsync } from '../utils/catchAsync';
import { i18n } from '../i18n/en';
import { PERMISSION_DEFS, isAdminOnlyPermission } from '../services/permissionSeed';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        role: Role;
        permissions?: string[];
      };
      cookies?: {
        [key: string]: string;
      };
    }
  }
}

// ---------------------------------------------------------------------------
// AUTHORIZATION MODEL
// ---------------------------------------------------------------------------
//   protect()            → AUTHENTICATION (resolves req.user + effective permissions)
//   restrictTo(...roles) → HARD ROLE BOUNDARY (e.g. finance-only endpoints)
//   requirePermission(k) → CAPABILITY authorization (per-permission)
//
//   ADMIN    → intentional SUPER ADMINISTRATOR (see isSuperAdmin): bypasses
//              individual permission checks and always holds the full registry.
//   BURSARY  → capability checks resolved LIVE from the authoritative
//              RolePermission table (never from stale token claims).
//   STUDENT  → role-specific student access.
//
// The ADMIN bypass is INTENTIONAL, CENTRALISED here and covered by tests.
// Do not duplicate it elsewhere.
// ---------------------------------------------------------------------------

const SUPER_ADMIN_ROLE: Role = Role.ADMIN;

/** ADMIN is the protected super-administrator; its bypass is intentional. */
export function isSuperAdmin(role: Role | undefined | null): boolean {
  return role === SUPER_ADMIN_ROLE;
}

const ROLE_PERMS_CACHE_TTL_MS = 1000;
const rolePermsCache = new Map<string, { ts: number; perms: string[] }>();
let lastRolePermissionDBWriteAt = 0;

/**
 * Invalidate the live role-permission cache. Called after any write to
 * RolePermission (role update endpoint, permission seeding) so that a REMOVED
 * permission stops working immediately on the next request — no stale window
 * within this process.
 */
export function bumpRolePermsVersion() {
  lastRolePermissionDBWriteAt = Date.now();
  rolePermsCache.clear();
}

async function resolveRolePermissionsLive(role: Role, fallback: string[]): Promise<string[]> {
  const now = Date.now();
  const cached = rolePermsCache.get(role);
  const forceRefresh = now - lastRolePermissionDBWriteAt < 50;
  if (!forceRefresh && cached && now - cached.ts < ROLE_PERMS_CACHE_TTL_MS) {
    return cached.perms;
  }
  try {
    const rows = await prisma.rolePermission.findMany({
      where: { role },
      select: { permission: { select: { key: true } } },
    });
    const perms = rows.map((r) => r.permission.key);
    rolePermsCache.set(role, { ts: now, perms });
    return perms;
  } catch {
    return fallback;
  }
}

export const protect = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    let token: string | undefined;
    if (req.cookies && typeof req.cookies.access_token === 'string') {
      token = req.cookies.access_token;
    }
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      return next(new AppError(i18n.errors.auth.unauthenticated, 401));
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET as string, { algorithms: ['HS256'] });
    } catch (err) {
      return next(new AppError(i18n.errors.auth.invalidToken, 401));
    }

    if (typeof decoded !== 'object' || !decoded || typeof decoded.id !== 'number') {
      return next(new AppError(i18n.errors.auth.invalidToken, 401));
    }

    if (decoded.type && decoded.type !== 'access') {
      return next(new AppError(i18n.errors.auth.wrongTokenTypeAccess, 401));
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, role: true, accountStatus: true },
    });

    if (!currentUser) {
      return next(new AppError(i18n.errors.auth.tokenUserGone, 401));
    }

    if (currentUser.accountStatus !== AccountStatus.ACTIVE) {
      return next(
        new AppError(
          i18n.errors.auth.accountInactive,
          403
        )
      );
    }

    const decodedPermissions = Array.isArray((decoded as any).permissions)
      ? ((decoded as any).permissions as string[])
      : [];

    const role = currentUser.role as Role;
    let effectivePermissions: string[];
    if (isSuperAdmin(role)) {
      // Intentional super-admin: ADMIN always holds the full canonical registry.
      effectivePermissions = PERMISSION_DEFS.map((p) => p.key);
    } else {
      // BURSARY (and any other configurable role): resolve LIVE from the
      // authoritative RolePermission table, ignoring stale token claims.
      effectivePermissions = await resolveRolePermissionsLive(role, decodedPermissions);
    }

    req.user = {
      id: currentUser.id,
      role,
      permissions: effectivePermissions,
    };
    next();
  }
);

export const restrictTo = (...roles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(i18n.errors.auth.notPermitted, 403));
    }
    next();
  };
};

/**
 * CAPABILITY authorization.
 *
 * - ADMIN (super-admin): intentional bypass.
 * - ADMIN-only capabilities (Layer 4 defence-in-depth): enforced as ADMIN-only
 *   here, so a forged/legacy RolePermission row can never grant a sensitive
 *   capability to a non-ADMIN role.
 * - Otherwise: the requested key must be present in the caller's live
 *   permissions.
 */
export const requirePermission = (permKey: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      return next(new AppError(i18n.errors.auth.notPermitted, 403));
    }
    if (isSuperAdmin(user.role)) {
      return next();
    }
    // Layer 4: never let a non-ADMIN reach an ADMIN-only capability, even if an
    // invalid RolePermission row exists for it.
    if (isAdminOnlyPermission(permKey)) {
      return next(new AppError(i18n.errors.auth.notPermitted, 403));
    }
    const perms = user.permissions;
    if (!Array.isArray(perms) || !perms.includes(permKey)) {
      return next(new AppError(i18n.errors.auth.notPermitted, 403));
    }
    next();
  };
};
