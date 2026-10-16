/**
 * RBAC PERMISSION SEEDING — regression suite
 * =============================================================================
 * Proves brief §9: seeding must NEVER undo an administrator's saved role
 * configuration, and "never initialized" must be determined by an EXPLICIT
 * marker — never by `RolePermission count === 0`.
 *
 * Covers brief TEST Q / R / S plus the fresh-install and fail-safe paths.
 * Uses an in-memory Prisma double; no live DB, no production data, no network.
 */

import { Role } from '@prisma/client';

jest.mock('../middlewares/auth', () => ({ bumpRolePermsVersion: jest.fn() }));

// The store is created INSIDE the factory so the hoisted `import` of
// permissionSeed can never observe an uninitialised module-scope binding.
jest.mock('../config/database', () => {
  const permissions = new Map<string, number>(); // key -> id
  const rolePerms = new Map<string, Set<number>>(); // role -> permissionId set
  const counters = new Set<string>();
  let nextId = 1;

  const ensurePerm = (key: string): number => {
    if (!permissions.has(key)) permissions.set(key, nextId++);
    return permissions.get(key)!;
  };

  const prisma: any = {
    permission: {
      upsert: jest.fn((args: any) => {
        const id = ensurePerm(args.where.key);
        return Promise.resolve({ id, key: args.where.key });
      }),
      findMany: jest.fn((args: any) => {
        const keys: string[] = args?.where?.key?.in ?? [];
        return Promise.resolve(
          keys.filter((k) => permissions.has(k)).map((k) => ({ id: permissions.get(k)!, key: k })),
        );
      }),
    },
    rolePermission: {
      deleteMany: jest.fn((args: any) => {
        const set = rolePerms.get(String(args?.where?.role));
        const ids: number[] = args?.where?.permissionId?.in ?? [];
        if (set) ids.forEach((id: number) => set.delete(id));
        return Promise.resolve({ count: 0 });
      }),
      groupBy: jest.fn((args: any) => {
        const roles: string[] = args?.where?.role?.in ?? [];
        return Promise.resolve(
          roles.map((r) => ({ role: r, _count: { role: rolePerms.get(r)?.size ?? 0 } })),
        );
      }),
      findMany: jest.fn((args: any) =>
        Promise.resolve(
          Array.from(rolePerms.get(String(args?.where?.role)) ?? []).map((permissionId) => ({ permissionId })),
        ),
      ),
      upsert: jest.fn((args: any) => {
        const role = String(args.where.role_permissionId.role);
        const pid = args.where.role_permissionId.permissionId as number;
        if (!rolePerms.has(role)) rolePerms.set(role, new Set());
        rolePerms.get(role)!.add(pid);
        return Promise.resolve({});
      }),
      createMany: jest.fn((args: any) => {
        const rows = (args.data ?? []) as any[];
        for (const r of rows) {
          const role = String(r.role);
          if (!rolePerms.has(role)) rolePerms.set(role, new Set());
          rolePerms.get(role)!.add(r.permissionId as number);
        }
        return Promise.resolve({ count: rows.length });
      }),
      create: jest.fn((args: any) => {
        const role = String(args.data.role);
        if (!rolePerms.has(role)) rolePerms.set(role, new Set());
        rolePerms.get(role)!.add(args.data.permissionId as number);
        return Promise.resolve({});
      }),
    },
    counter: {
      findMany: jest.fn((args: any) => {
        const ids: string[] = args?.where?.id?.in ?? [];
        return Promise.resolve(ids.filter((id) => counters.has(id)).map((id) => ({ id })));
      }),
      findUnique: jest.fn((args: any) =>
        Promise.resolve(counters.has(args?.where?.id) ? { id: args.where.id } : null),
      ),
      upsert: jest.fn((args: any) => {
        counters.add(args.where.id);
        return Promise.resolve({ id: args.where.id, value: 1 });
      }),
    },
    $transaction: jest.fn((fn: any) => fn(prisma)),
  };

  return {
    __esModule: true,
    default: prisma,
    __store: {
      permissions,
      rolePerms,
      counters,
      ensureId: ensurePerm,
      reset: () => {
        permissions.clear();
        rolePerms.clear();
        counters.clear();
        nextId = 1;
      },
    },
  };
});

import {
  seedPermissions,
  ALL_PERMISSION_KEYS,
  BURSARY_PERMISSION_KEYS,
  ADMIN_ONLY_PERMISSION_KEYS,
  RBAC_BURSARY_INIT_SENTINEL_ID,
  BURSARY_RELEASE_UPGRADE_SENTINEL_ID,
} from '../services/permissionSeed';

const store = (jest.requireMock('../config/database') as any).__store as {
  permissions: Map<string, number>;
  rolePerms: Map<string, Set<number>>;
  counters: Set<string>;
  ensureId: (key: string) => number;
  reset: () => void;
};

const dbMock = jest.requireMock('../config/database') as any;

/** Pre-populate a persisted role→permission set from keys (bypasses the seed). */
const persist = (role: string, keys: string[]) => {
  store.rolePerms.set(role, new Set(keys.map((k) => store.ensureId(k))));
};

const grantedKeys = (role: string): string[] => {
  const idToKey = new Map<number, string>();
  for (const [k, id] of store.permissions) idToKey.set(id, k);
  return Array.from(store.rolePerms.get(role) ?? [])
    .map((id) => idToKey.get(id)!)
    .sort();
};

const hasKey = (role: string, key: string): boolean => grantedKeys(role).includes(key);

beforeEach(() => {
  store.reset();
  jest.clearAllMocks();
});

describe('fresh installation (brief §9)', () => {
  it('grants the full BURSARY safe default set and records both sentinels', async () => {
    await seedPermissions();
    expect(grantedKeys(Role.BURSARY)).toEqual([...BURSARY_PERMISSION_KEYS].sort());
    expect(store.counters.has(RBAC_BURSARY_INIT_SENTINEL_ID)).toBe(true);
    expect(store.counters.has(BURSARY_RELEASE_UPGRADE_SENTINEL_ID)).toBe(true);
  });

  it('never grants an ADMIN-only key to BURSARY', async () => {
    await seedPermissions();
    for (const k of ADMIN_ONLY_PERMISSION_KEYS) expect(hasKey(Role.BURSARY, k)).toBe(false);
  });
});

describe('seeding must not undo an administrator configuration (brief §9, TEST Q/R/S)', () => {
  it('TEST Q — a deliberately removed BURSARY permission is NOT restored on restart', async () => {
    persist(Role.ADMIN, []);
    persist(Role.BURSARY, BURSARY_PERMISSION_KEYS.filter((k) => k !== 'VIEW_STUDENTS'));
    store.counters.add(RBAC_BURSARY_INIT_SENTINEL_ID);
    store.counters.add(BURSARY_RELEASE_UPGRADE_SENTINEL_ID);

    await seedPermissions();

    expect(hasKey(Role.BURSARY, 'VIEW_STUDENTS')).toBe(false);
    expect(grantedKeys(Role.BURSARY)).toEqual(BURSARY_PERMISSION_KEYS.filter((k) => k !== 'VIEW_STUDENTS').sort());
  });

  it('TEST R — an intentional ZERO-permission BURSARY role survives a restart', async () => {
    persist(Role.BURSARY, []);
    store.counters.add(RBAC_BURSARY_INIT_SENTINEL_ID);
    store.counters.add(BURSARY_RELEASE_UPGRADE_SENTINEL_ID);

    await seedPermissions();

    expect(grantedKeys(Role.BURSARY)).toEqual([]);
  });

  it('TEST S — a new registry key is synchronised into the catalogue without overwriting customisations', async () => {
    persist(Role.ADMIN, []);
    persist(Role.BURSARY, ['VIEW_DASHBOARD']);
    store.counters.add(RBAC_BURSARY_INIT_SENTINEL_ID);
    store.counters.add(BURSARY_RELEASE_UPGRADE_SENTINEL_ID);

    await seedPermissions();

    // Every registry key exists in the Permission catalogue (new keys added),
    expect(store.permissions.size).toBe(ALL_PERMISSION_KEYS.length);
    // ADMIN is a protected super-admin: always the whole registry,
    expect(grantedKeys(Role.ADMIN)).toEqual([...ALL_PERMISSION_KEYS].sort());
    // but the administrator's BURSARY customisation is untouched.
    expect(grantedKeys(Role.BURSARY)).toEqual(['VIEW_DASHBOARD']);
  });

  it('a legacy install with rows but no init marker is treated as initialised (no re-grant)', async () => {
    persist(Role.BURSARY, ['VIEW_DASHBOARD']);
    store.counters.add(BURSARY_RELEASE_UPGRADE_SENTINEL_ID); // predates the init marker

    await seedPermissions();

    expect(grantedKeys(Role.BURSARY)).toEqual(['VIEW_DASHBOARD']);
  });
});

describe('fail-safe behaviour (brief §9)', () => {
  it('assumes initialised when the init marker cannot be read, so defaults are never re-granted', async () => {
    persist(Role.BURSARY, ['VIEW_DASHBOARD']);
    dbMock.default.counter.findMany.mockImplementationOnce(() => Promise.reject(new Error('connection reset')));
    dbMock.default.counter.findUnique.mockImplementationOnce(() => Promise.reject(new Error('connection reset')));

    await seedPermissions();

    expect(grantedKeys(Role.BURSARY)).toEqual(['VIEW_DASHBOARD']);
  });

  it('pre-sweeps a stale ADMIN-only grant from BURSARY', async () => {
    persist(Role.BURSARY, ['VIEW_DASHBOARD', 'REPORTS_SCHEDULE']);
    store.counters.add(RBAC_BURSARY_INIT_SENTINEL_ID);
    store.counters.add(BURSARY_RELEASE_UPGRADE_SENTINEL_ID);

    await seedPermissions();

    expect(hasKey(Role.BURSARY, 'REPORTS_SCHEDULE')).toBe(false);
    expect(hasKey(Role.BURSARY, 'VIEW_DASHBOARD')).toBe(true);
  });
});
