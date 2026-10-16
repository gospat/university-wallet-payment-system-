/**
 * RBAC PERMISSION CONSISTENCY — static drift guard (brief §4, §5, §21)
 * =============================================================================
 * Guarantees there is exactly ONE canonical permission registry and that every
 * permission key referenced anywhere in the API routes (and on the frontend
 * route guards) actually exists in that registry.
 *
 * This test fails the build the moment a route references a permission that was
 * never registered, or the registry/catalogue/ADMIN-only classification drifts.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  PERMISSION_DEFS,
  ALL_PERMISSION_KEYS,
  ADMIN_ONLY_PERMISSION_KEYS,
  PERMISSION_CATALOGUE,
  BURSARY_PERMISSION_KEYS,
  isAdminOnlyPermission,
} from '../services/permissionSeed';

const ROUTES_DIR = path.resolve(__dirname, '../routes');
const APP_TX = path.resolve(__dirname, '../../../app/src/App.tsx');

/** Resolve every permission key a route file gates on. */
function keysGatedBySource(src: string): string[] {
  const keys: string[] = [];

  // const IDENT = 'PERMISSION_KEY';
  const idents = new Map<string, string>();
  for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*'([A-Z_]+)'/g)) {
    idents.set(m[1], m[2]);
  }

  for (const m of src.matchAll(/requirePermission\(\s*(?:'([A-Z_]+)'|([A-Za-z_$][\w$]*))\s*\)/g)) {
    if (m[1]) keys.push(m[1]);
    else if (m[2] && idents.has(m[2])) keys.push(idents.get(m[2])!);
  }
  return keys;
}

describe('canonical registry integrity (brief §4, §5)', () => {
  it('contains no duplicate permission keys', () => {
    const keys = PERMISSION_DEFS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ALL_PERMISSION_KEYS mirrors the registry exactly', () => {
    expect(ALL_PERMISSION_KEYS).toEqual(PERMISSION_DEFS.map((p) => p.key));
  });

  it('ADMIN-only keys are a strict subset derived from the registry', () => {
    for (const k of ADMIN_ONLY_PERMISSION_KEYS) {
      expect(ALL_PERMISSION_KEYS).toContain(k);
      expect(isAdminOnlyPermission(k)).toBe(true);
    }
    expect(ADMIN_ONLY_PERMISSION_KEYS.length).toBeGreaterThan(0);
    expect(ADMIN_ONLY_PERMISSION_KEYS.length).toBeLessThan(ALL_PERMISSION_KEYS.length);
  });

  it('the catalogue is complete and its assignability matches the ADMIN-only flag', () => {
    expect(PERMISSION_CATALOGUE.map((c) => c.key)).toEqual([...ALL_PERMISSION_KEYS]);
    for (const entry of PERMISSION_CATALOGUE) {
      expect(entry.assignable).toBe(!entry.adminOnly);
      expect(entry.adminOnly).toBe(isAdminOnlyPermission(entry.key));
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.category.length).toBeGreaterThan(0);
    }
  });

  it('BURSARY can never be offered (or seeded with) an ADMIN-only key', () => {
    const overlapping = BURSARY_PERMISSION_KEYS.filter((k) => isAdminOnlyPermission(k));
    expect(overlapping).toEqual([]);
    for (const k of BURSARY_PERMISSION_KEYS) expect(ALL_PERMISSION_KEYS).toContain(k);
  });
});

describe('route permission gates reference only registered keys (brief §5, §21)', () => {
  const files = fs
    .readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: f, src: fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8') }));

  it('found route files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every key passed to requirePermission() exists in the registry', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const key of keysGatedBySource(file.src)) {
        if (!ALL_PERMISSION_KEYS.includes(key)) offenders.push(`${file.name} → ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the API actually enforces permission gates (not a vacuous scan)', () => {
    const all = files.flatMap((f) => keysGatedBySource(f.src));
    expect(all.length).toBeGreaterThan(30);
    expect(new Set(all).size).toBeGreaterThan(20);
  });
});

describe('frontend route guards reference only registered keys (brief §4, §12)', () => {
  it('every permission="KEY" in App.tsx exists in the canonical registry', () => {
    const src = fs.readFileSync(APP_TX, 'utf8');
    const keys = Array.from(src.matchAll(/permission="([A-Z_]+)"/g)).map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(ALL_PERMISSION_KEYS).toContain(k);
  });
});
