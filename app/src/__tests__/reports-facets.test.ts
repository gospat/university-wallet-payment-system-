// =============================================================================
// Reports Centre — settlement drill-down facet regressions.
//
// Proves the Fully Settled / Partially Settled / Outstanding Settlement
// dashboard cards map to DISTINCT reconciliationStatus scopes:
//   • FULLY_SETTLED  → MATCHED, SETTLED only (never PARTIALLY_MATCHED)
//   • PARTIALLY_SETTLED → PARTIALLY_MATCHED only (never MATCHED/SETTLED)
//   • OUTSTANDING_SETTLEMENT → incomplete statuses incl. PARTIALLY_MATCHED
//
// A partially settled transaction is never presented as fully settled.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_FACETS,
  FACET_LABELS,
  applyFacetToFilters,
  type DashboardFacetName,
} from '../services/reportsApi';

describe('Reports Centre — settlement drill-down facets', () => {
  it('E. FULLY_SETTLED resolves to ONLY MATCHED / SETTLED', () => {
    expect(applyFacetToFilters('FULLY_SETTLED').reconciliationStatus).toEqual(['MATCHED', 'SETTLED']);
    expect(DASHBOARD_FACETS.FULLY_SETTLED.reconciliationStatus).toEqual(['MATCHED', 'SETTLED']);
  });

  it('F. PARTIALLY_SETTLED resolves to ONLY PARTIALLY_MATCHED', () => {
    expect(applyFacetToFilters('PARTIALLY_SETTLED').reconciliationStatus).toEqual(['PARTIALLY_MATCHED']);
    expect(DASHBOARD_FACETS.PARTIALLY_SETTLED.reconciliationStatus).toEqual(['PARTIALLY_MATCHED']);
  });

  it('G. the Fully Settled card can never return PARTIALLY_MATCHED', () => {
    const f = applyFacetToFilters('FULLY_SETTLED');
    expect(f.reconciliationStatus).not.toContain('PARTIALLY_MATCHED');
    expect(DASHBOARD_FACETS.FULLY_SETTLED.reconciliationStatus).not.toContain('PARTIALLY_MATCHED');
  });

  it('H. the Partially Settled card can never return MATCHED / SETTLED', () => {
    const f = applyFacetToFilters('PARTIALLY_SETTLED');
    expect(f.reconciliationStatus).not.toContain('MATCHED');
    expect(f.reconciliationStatus).not.toContain('SETTLED');
    expect(DASHBOARD_FACETS.PARTIALLY_SETTLED.reconciliationStatus).not.toContain('MATCHED');
    expect(DASHBOARD_FACETS.PARTIALLY_SETTLED.reconciliationStatus).not.toContain('SETTLED');
  });

  it('OUTSTANDING_SETTLEMENT covers the incomplete statuses AND PARTIALLY_MATCHED', () => {
    const expected = ['PENDING_SETTLEMENT', 'VARIANCE', 'UNMATCHED', 'UNDER_REVIEW', 'PARTIALLY_MATCHED'];
    expect(applyFacetToFilters('OUTSTANDING_SETTLEMENT').reconciliationStatus).toEqual(expect.arrayContaining(expected));
    expect(DASHBOARD_FACETS.OUTSTANDING_SETTLEMENT.reconciliationStatus).toEqual(expect.arrayContaining(expected));
  });

  it('the settlement count facets map to DISTINCT datasets (never one mixed set)', () => {
    expect(DASHBOARD_FACETS.FULLY_SETTLED.reconciliationStatus).not.toEqual(DASHBOARD_FACETS.PARTIALLY_SETTLED.reconciliationStatus);
    expect(DASHBOARD_FACETS.FULLY_SETTLED.reconciliationStatus).not.toEqual(DASHBOARD_FACETS.RECONCILED.reconciliationStatus);
    expect(DASHBOARD_FACETS.PARTIALLY_SETTLED.reconciliationStatus).not.toEqual(DASHBOARD_FACETS.RECONCILED.reconciliationStatus);
  });

  it('every dashboard facet has a label and a facet definition', () => {
    for (const name of Object.keys(DASHBOARD_FACETS) as DashboardFacetName[]) {
      expect(typeof FACET_LABELS[name as keyof typeof FACET_LABELS]).toBe('string');
    }
    for (const n of ['FULLY_SETTLED', 'PARTIALLY_SETTLED', 'OUTSTANDING_SETTLEMENT'] as const) {
      expect(FACET_LABELS[n]).toBeTruthy();
    }
  });
});
