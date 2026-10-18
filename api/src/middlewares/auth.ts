import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../utils/AppError';
import prisma from '../config/database';
import { Role, AccountStatus } from '@prisma/client';
import { catchAsync } from '../utils/catchAsync';
import { i18n } from '../i18n/en';
import { isAdminOnlyPermission, isSuperAdminOnlyPermission } from '../services/permissionSeed';
import {
  isSuperAdmin,
  resolveEffectivePermissionsForUser,
} from '../services/permissionResolver';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        role: Role;
        isSuperAdmin: boolean;
        /**
         * Mandatory first-login password change flag (authoritative DB value).
         * When true AND role === STUDENT the account is in the restricted
         * first-login state and every `protect()`-guarded route is blocked.
         */
        mustChangePassword?: boolean;
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
//   SUPER ADMIN → a user with role=ADMIN AND User.isSuperAdmin === true. It
//                 bypasses individual permission checks and always holds the
//                 full registry. A plain role=ADMIN account that is NOT flagged
//                 is NOT a super administrator.
//   ADMIN       → staff administrator. Holds exactly its resolved capability set.
//   BURSARY     → capability checks resolved LIVE from the authoritative
//                 RolePermission / UserPermission tables (never stale token claims).
//   STUDENT     → role-specific student access.
//
// The super-admin bypass is INTENTIONAL, CENTRALISED here and covered by tests.
// Do not duplicate it elsewhere.
// ---------------------------------------------------------------------------

// Single authoritative resolver owns the cache/versioning. Re-exported here so
// existing importers (`../middlewares/auth`) keep working unchanged.
export { isSuperAdmin, bumpRolePermsVersion } from '../services/permissionResolver';

/**
 * Core authentication: verifies the access token, loads the AUTHORITATIVE user
 * row and resolves the LIVE effective permission set. Returns an AppError
 * describing the failure, or null on success (with `req.user` populated).
 *
 * JWT permission claims are DELIBERATELY ignored — a forged/stale token can
 * never widen access. On any resolver failure the effective set collapses to
 * [] (fail closed).
 */
async function authenticate(req: Request): Promise<AppError | null> {
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

  if (!token) return new AppError(i18n.errors.auth.unauthenticated, 401);

  let decoded: any;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET as string, { algorithms: ['HS256'] });
  } catch {
    return new AppError(i18n.errors.auth.invalidToken, 401);
  }

  if (typeof decoded !== 'object' || !decoded || typeof decoded.id !== 'number') {
    return new AppError(i18n.errors.auth.invalidToken, 401);
  }

  if (decoded.type && decoded.type !== 'access') {
    return new AppError(i18n.errors.auth.wrongTokenTypeAccess, 401);
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: decoded.id },
    select: {
      id: true,
      role: true,
      accountStatus: true,
      isSuperAdmin: true,
      mustChangePassword: true,
      authVersion: true,
    },
  });

  if (!currentUser) {
    return new AppError(i18n.errors.auth.tokenUserGone, 401);
  }

  if (currentUser.accountStatus !== AccountStatus.ACTIVE) {
    return new AppError(i18n.errors.auth.accountInactive, 403);
  }

  // SESSION-GENERATION CHECK — invalidates already-issued access tokens after a
  // credential/security event (password change/reset). Legacy tokens carry no
  // `ver` claim and are treated as generation 0, matching the additive DB
  // default, so this is fully backward compatible.
  const tokenVersion = typeof decoded.ver === 'number' ? decoded.ver : 0;
  const currentVersion = Number((currentUser as any).authVersion ?? 0);
  if (tokenVersion !== currentVersion) {
    return new AppError(i18n.errors.auth.sessionInvalidated, 401);
  }

  const role = currentUser.role as Role;
  const superAdmin = isSuperAdmin({
    id: currentUser.id,
    role,
    isSuperAdmin: (currentUser as any).isSuperAdmin === true,
  });

  const effectivePermissions = await resolveEffectivePermissionsForUser({
    id: currentUser.id,
    role,
    isSuperAdmin: superAdmin,
  });

  req.user = {
    id: currentUser.id,
    role,
    isSuperAdmin: superAdmin,
    mustChangePassword: (currentUser as any).mustChangePassword === true,
    permissions: effectivePermissions,
  };
  return null;
}

/**
 * AUTHENTICATION + MANDATORY FIRST-LOGIN PASSWORD CHANGE ENFORCEMENT.
 *
 * A student holding the predictable bootstrap credential (lowercased surname)
 * is placed in a RESTRICTED first-login state by the BACKEND. Every route
 * mounted behind `protect()` is blocked with 403 `PASSWORD_CHANGE_REQUIRED`
 * until the password has been changed. Frontend routing is NOT the boundary.
 *
 * Only the minimal self-service surface (identity / change-password / refresh /
 * logout) is mounted behind `protectSelfService` instead.
 */
export const protect = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const err = await authenticate(req);
    if (err) return next(err);

    const user = req.user!;
    if (user.role === Role.STUDENT && user.mustChangePassword === true) {
      return res.status(403).json({
        status: 'fail',
        code: 'PASSWORD_CHANGE_REQUIRED',
        error: 'You must change your initial password before continuing.',
      });
    }
    next();
  }
);

/**
 * AUTHENTICATION ONLY — for the minimal set of endpoints a restricted
 * first-login account must still reach: identity (`/auth/me`), password change,
 * session refresh and logout.
 */
export const protectSelfService = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const err = await authenticate(req);
    if (err) return next(err);
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
 * SUPER-ADMIN guard. Only a flag-aware super administrator (role === ADMIN AND
 * User.isSuperAdmin === true) passes. Used for the most privileged mutations.
 */
export const requireSuperAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || !isSuperAdmin(req.user)) {
    return next(new AppError(i18n.errors.auth.notPermitted, 403));
  }
  next();
};

/**
 * CAPABILITY authorization.
 *
 * - flag-aware SUPER ADMIN: intentional bypass.
 * - ADMIN-only / super-admin-only capability (Layer 4 defence-in-depth):
 *   enforced here, so a forged/legacy RolePermission or UserPermission row can
 *   never grant a sensitive capability to a non-super-admin.
 * - Otherwise: the requested key must be present in the caller's live
 *   permissions.
 */
export const requirePermission = (permKey: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      return next(new AppError(i18n.errors.auth.notPermitted, 403));
    }
    if (isSuperAdmin(user)) {
      return next();
    }
    // Layer 4a — SUPER-ADMIN-ONLY capability: never reachable by a normal ADMIN
    // or BURSARY, even if a forged RolePermission / UserPermission row exists.
    if (isSuperAdminOnlyPermission(permKey)) {
      return next(new AppError(i18n.errors.auth.notPermitted, 403));
    }
    // Layer 4b — ADMIN-only capability: never reachable by a NON-ADMIN role, even
    // if a forged row exists. A normal ADMIN (role === ADMIN, not flagged) that
    // holds the capability in its effective set (INHERIT or CUSTOM subset) MAY
    // exercise it — normal ADMIN is a configurable administrative role.
    if (isAdminOnlyPermission(permKey) && user.role !== Role.ADMIN) {
      return next(new AppError(i18n.errors.auth.notPermitted, 403));
    }
    const perms = user.permissions;
    if (!Array.isArray(perms) || !perms.includes(permKey)) {
      return next(new AppError(i18n.errors.auth.notPermitted, 403));
    }
    next();
  };
};
