import { AccessMode, Role } from '@prisma/client';
import prisma from '../config/database';
import { PERMISSION_DEFS, RBAC_ADMIN_INIT_SENTINEL_ID } from './permissionSeed';

// ---------------------------------------------------------------------------
// AUTHORITATIVE PERMISSION RESOLVER (single source of truth)
// ---------------------------------------------------------------------------
// Every authorization decision in the API MUST funnel through this module.
// There is exactly ONE place that decides what a user is allowed to do:
//
//   effective permissions(user) =
//     · FLAG-AWARE SUPER ADMIN (role === ADMIN && isSuperAdmin === true)
//         → the ENTIRE canonical registry, always.
//     · CUSTOM individual access (UserPermissionProfile.accessMode === CUSTOM)
//         → exactly the explicit UserPermission set (an EMPTY set is a VALID
//           explicit zero — it is never conflated with INHERIT).
//     · INHERIT (default / no profile)
//         → the live RolePermission rows for the user's role.
//
// RULES
//   · Live, never stale: role permissions are read from the DB (1s cache,
//     invalidated on write via bumpRolePermsVersion). JWT claims are NEVER
//     consulted — a forged/stale token cannot widen access.
//   · Fail CLOSED: any lookup failure collapses to "no capability" (empty set),
//     never to caller-supplied claims.
//   · STUDENT is untouched: role boundary + no permission profile.
// ---------------------------------------------------------------------------

/** Minimal user shape required to resolve effective permissions. */
export interface PermissionResolutionUser {
  id: number;
  role: Role | null | undefined;
  isSuperAdmin?: boolean | null;
}

/** Normalised view of a single user's access, used by the admin access API. */
export interface UserAccessDescriptor {
  userId: number;
  role: Role | null;
  isSuperAdmin: boolean;
  accessMode: AccessMode;
  rolePermissionKeys: string[];
  customPermissionKeys: string[];
  effectivePermissionKeys: string[];
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
export function bumpRolePermsVersion(): void {
  lastRolePermissionDBWriteAt = Date.now();
  rolePermsCache.clear();
}

/** The full canonical registry key set (used for the super-admin grant). */
function registryKeys(): string[] {
  return PERMISSION_DEFS.map((p) => p.key);
}

/**
 * Tri-state result of the ADMIN-baseline sentinel lookup.
 *
 *   'initialized'   → the sentinel row is PRESENT: the ADMIN baseline HAS been
 *                     seeded, so a stored zero-row baseline is an explicit,
 *                     intentional state and MUST be honoured literally.
 *   'uninitialized' → a GENUINE `null` result (the sentinel row is absent): the
 *                     baseline was never seeded (fresh install / pre-seed), so
 *                     the canonical FULL-registry floor applies to prevent
 *                     administrative lockout.
 *   'unknown'       → the sentinel could NOT be read (DB/query error). We must
 *                     NOT assume "uninitialised": doing so would silently turn
 *                     an intentionally-empty ADMIN baseline into full canonical
 *                     registry access. The stored baseline is honoured as-is.
 */
type AdminBaselineMarker = 'initialized' | 'uninitialized' | 'unknown';

async function readAdminBaselineMarker(): Promise<AdminBaselineMarker> {
  try {
    const marker = await prisma.counter.findUnique({
      where: { id: RBAC_ADMIN_INIT_SENTINEL_ID },
      select: { id: true },
    });
    return marker !== null ? 'initialized' : 'uninitialized';
  } catch (e) {
    console.warn(
      '[permissionResolver] ADMIN baseline sentinel lookup failed; honouring the stored ADMIN baseline literally (no full-registry escalation).',
      (e as Error)?.message?.slice(0, 180),
    );
    return 'unknown';
  }
}

/**
 * Flag-aware super-administrator test.
 *
 * A plain `role === ADMIN` is NO LONGER treated as a super administrator.
 * Only a user whose DB record has `role === ADMIN` AND `isSuperAdmin === true`
 * is a super administrator. Passing a bare role (no flag) is always false.
 */
export function isSuperAdmin(
  user: PermissionResolutionUser | Role | null | undefined
): boolean {
  if (!user) return false;
  if (typeof user === 'string') return false; // legacy role-only call → never super admin
  return user.role === Role.ADMIN && user.isSuperAdmin === true;
}

/**
 * Resolve a role's baseline capability set LIVE from the authoritative
 * RolePermission table (1s cache). Fail CLOSED ([]) on any lookup error — never
 * fall back to a caller-supplied/stale list.
 */
export async function getRolePermissions(role: Role | null | undefined): Promise<string[]> {
  if (!role) return [];
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
    let perms = rows.map((r) => r.permission.key);
    // D4 — the ADMIN role MAXIMUM is the FULL canonical registry, applied ONLY
    // as the floor for a genuinely UNINITIALISED ADMIN baseline (proven absent
    // by a GENUINE null from the explicit RBAC_ADMIN_INIT_SENTINEL_ID marker).
    // Once the baseline has been initialised — OR when the marker cannot be
    // read — a stored zero-row set is honoured literally: an intentionally
    // zero-permission ADMIN baseline is NEVER silently converted into full
    // access (e.g. by a transient Counter lookup error).
    if (
      role === Role.ADMIN &&
      perms.length === 0 &&
      (await readAdminBaselineMarker()) === 'uninitialized'
    ) {
      perms = registryKeys();
    }
    rolePermsCache.set(role, { ts: now, perms });
    return perms;
  } catch (e) {
    console.warn(
      '[permissionResolver] role permission lookup failed; failing closed (no permissions).',
      (e as Error)?.message?.slice(0, 180),
    );
    return [];
  }
}

/** Outcome of an individual-access profile lookup. */
type AccessProfileLookup =
  | { status: 'absent' } // GENUINE `null` from findUnique ⇒ INHERIT
  | { status: 'resolved'; accessMode: AccessMode; keys: string[] }
  | { status: 'error' }; // query failure ⇒ callers MUST fail closed

/**
 * Load a user's individual-access profile.
 *
 * A GENUINE `null` result (the user simply has no profile row) is 'absent' ⇒
 * the user INHERITS the role baseline. A QUERY FAILURE is 'error' and MUST be
 * treated as fail-closed by every caller: we cannot prove the user's access
 * mode, so a CUSTOM-restricted user must NEVER silently fall back to the
 * (wider) role baseline.
 */
async function loadUserAccessProfile(userId: number): Promise<AccessProfileLookup> {
  try {
    const profile = await prisma.userPermissionProfile.findUnique({
      where: { userId },
      include: { permissions: { include: { permission: { select: { key: true } } } } },
    });
    if (!profile) return { status: 'absent' };
    const accessMode =
      (profile as any).accessMode === AccessMode.CUSTOM ? AccessMode.CUSTOM : AccessMode.INHERIT;
    const keys = (((profile as any).permissions ?? []) as any[])
      .map((p) => p?.permission?.key)
      .filter((k): k is string => typeof k === 'string');
    return { status: 'resolved', accessMode, keys };
  } catch (e) {
    console.warn(
      '[permissionResolver] individual access profile lookup failed; failing closed (no permissions).',
      (e as Error)?.message?.slice(0, 180),
    );
    return { status: 'error' };
  }
}

/**
 * Resolve the effective capability set for a user. This is the ONE function the
 * authentication middleware uses to populate `req.user.permissions`.
 */
export async function resolveEffectivePermissionsForUser(
  user: PermissionResolutionUser
): Promise<string[]> {
  if (isSuperAdmin(user)) return registryKeys();

  const lookup = await loadUserAccessProfile(user.id);

  // FAIL CLOSED — if the individual-access profile cannot be read we MUST NOT
  // fall back to the role baseline: that would silently widen a
  // CUSTOM-restricted user's access. Zero capability is the only safe answer.
  if (lookup.status === 'error') return [];

  if (lookup.status === 'resolved' && lookup.accessMode === AccessMode.CUSTOM) {
    // §8 effective-permission formula:
    //   CUSTOM = ROLE_BASELINE ∩ USER_CUSTOM_PERMISSIONS
    // An EMPTY selected set is a valid explicit zero (CUSTOM + zero ⇒ zero) and
    // is NEVER conflated with INHERIT. Individual access can only RESTRICT the
    // role maximum — it can never expand beyond it.
    const baseline = new Set(await getRolePermissions(user.role ?? null));
    return lookup.keys.filter((k) => baseline.has(k));
  }
  return getRolePermissions(user.role ?? null);
}

/**
 * Full normalised access descriptor for a user (used by the admin access API).
 * Returns null when the user does not exist.
 */
export async function getUserAccess(userId: number): Promise<UserAccessDescriptor | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, isSuperAdmin: true },
  });
  if (!user) return null;

  const superAdmin = isSuperAdmin(user);
  const rolePermissionKeys = await getRolePermissions((user as any).role);
  const lookup = await loadUserAccessProfile(userId);
  // FAIL CLOSED — never report an individual-access configuration we could not
  // verify. Inventing INHERIT here would misrepresent a CUSTOM-restricted user.
  if (lookup.status === 'error') {
    throw new Error('Unable to resolve individual access profile');
  }
  const profile = lookup.status === 'resolved' ? lookup : null;

  const accessMode: AccessMode = superAdmin
    ? AccessMode.INHERIT
    : profile?.accessMode ?? AccessMode.INHERIT;
  const customPermissionKeys =
    profile && profile.accessMode === AccessMode.CUSTOM ? profile.keys : [];
  // §8: CUSTOM effective = role baseline ∩ selected (restrict-only). The RAW
  // stored selection is reported separately so the UI can show what was saved.
  const baselineSet = new Set(rolePermissionKeys);
  const customEffectiveKeys = customPermissionKeys.filter((k) => baselineSet.has(k));
  const effectivePermissionKeys = superAdmin
    ? registryKeys()
    : profile && profile.accessMode === AccessMode.CUSTOM
    ? customEffectiveKeys
    : rolePermissionKeys;

  return {
    userId: (user as any).id,
    role: (user as any).role ?? null,
    isSuperAdmin: superAdmin,
    accessMode,
    rolePermissionKeys,
    customPermissionKeys,
    effectivePermissionKeys,
  };
}

export default {
  isSuperAdmin,
  getRolePermissions,
  resolveEffectivePermissionsForUser,
  getUserAccess,
  bumpRolePermsVersion,
};
