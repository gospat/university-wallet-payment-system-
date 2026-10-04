import React, { useEffect, useState } from 'react';
import PortalShell from '../../components/PortalShell';
import { useAuth } from '../../context/AuthContext';
import { navCounters, NavCounters } from '../../services/api';
import { i18n } from '../../i18n/en';
import { useSearchParams } from 'react-router-dom';
import {
  Search, Loader2, AlertTriangle, FileSpreadsheet, FileText,
  GraduationCap, BookOpen, CreditCard, Banknote, Wallet, ArrowDownUp, ArrowLeft, Download, Building2,
} from 'lucide-react';
import {
  getStudentStatement, exportStudentStatement, downloadBlob,
} from '../../services/reportsApi';
import MatricStudentInput from '../../components/fees/MatricStudentInput';
import type { MatricStudentResp } from '../../services/adminFees';

type Role = 'BURSARY' | 'ADMIN';
export interface StudentStatementPageProps { role: Role; activePath: string; }

const hasPerm = (p: string, perms?: string[], role?: Role) => {
  if (role === 'ADMIN') return true;
  return perms?.includes(p) ?? false;
};

const fmtNGN = (v: any) => {
  if (v === null || v === undefined || v === '') return '₦0.00';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const SUMMARY_METRICS: Array<{
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  isMoney?: boolean;
  isCount?: boolean;
}> = [
  { key: 'billsAssignedCount', label: 'Bills Assigned', icon: BookOpen, color: 'bg-blue-50 text-blue-700 border-blue-200', isCount: true },
  { key: 'amountBilled', label: 'Amount Billed', icon: Banknote, color: 'bg-indigo-50 text-indigo-700 border-indigo-200', isMoney: true },
  { key: 'amountPaid', label: 'Amount Paid', icon: CreditCard, color: 'bg-emerald-50 text-emerald-700 border-emerald-200', isMoney: true },
  { key: 'walletBalance', label: 'Wallet Balance', icon: Wallet, color: 'bg-purple-50 text-purple-700 border-purple-200', isMoney: true },
  { key: 'outstandingAmount', label: 'Outstanding', icon: ArrowDownUp, color: 'bg-amber-50 text-amber-700 border-amber-200', isMoney: true },
  { key: 'refundsSum', label: 'Refunds Sum', icon: ArrowLeft, color: 'bg-rose-50 text-rose-700 border-rose-200', isMoney: true },
  { key: 'totalCharges', label: 'Total Charges', icon: Download, color: 'bg-orange-50 text-orange-700 border-orange-200', isMoney: true },
  { key: 'netBalance', label: 'Net Balance', icon: Building2, color: 'bg-teal-50 text-teal-700 border-teal-200', isMoney: true },
];

const StudentStatementPage: React.FC<StudentStatementPageProps> = ({ role, activePath }) => {
  const { user, logout } = useAuth();
  const userPerms = (user?.permissions as string[] | undefined) ?? [];
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const [sp] = useSearchParams();
  const [matricInput, setMatricInput] = useState<string>(sp.get('matricNumber') ?? '');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<'xlsx' | 'pdf' | null>(null);
  const [data, setData] = useState<{
    student?: any;
    summary?: Record<string, any>;
    ledger?: any[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [resolvedStudent, setResolvedStudent] = useState<MatricStudentResp | null>(null);

  useEffect(() => { navCounters().then(setNavCounts).catch(() => {}); }, []);

  const doFetch = (studentId?: number, matricNumber?: string) => {
    const params: Record<string, any> = {};
    if (studentId) params.studentId = studentId;
    if (matricNumber) params.matricNumber = matricNumber;
    if (!params.studentId && !params.matricNumber) return;
    setLoading(true);
    setErr(null);
    setData(null);
    getStudentStatement(params)
      .then((d: any) => {
        setData(d ?? null);
        if (!d?.student) setErr('Student not found for criteria.');
      })
      .catch((e: any) => setErr(String(e?.message ?? e).slice(0, 200)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const m = sp.get('matricNumber');
    const sid = sp.get('studentId');
    if (m || sid) {
      if (m) setMatricInput(m);
      doFetch(sid ? Number(sid) : undefined, m ?? undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const brand = role === 'BURSARY' ? i18n.portals.bursary.dashboardBrand : i18n.portals.admin.dashboardBrand;
  const userText = role === 'BURSARY'
    ? `Bursary: ${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim()
    : i18n.portals.admin.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin');

  const st = data?.student;
  const summary = data?.summary;
  const ledgerRows: any[] = data?.ledger ?? [];

  const runExport = async (fmt: 'xlsx' | 'pdf') => {
    if (!hasPerm(fmt === 'xlsx' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF', userPerms, role)) return;
    try {
      setExporting(fmt);
      const body: Record<string, any> = {};
      if (matricInput) body.matricNumber = matricInput;
      const sid = sp.get('studentId');
      if (sid) body.studentId = Number(sid);
      if (st?.id) body.studentId = Number(st.id);
      const result = await exportStudentStatement(body, fmt);
      if (result instanceof Blob) {
        const filename = `STUDENT_STATEMENT_${st?.matricNumber ?? 'statement'}_${new Date().getTime()}.${fmt === 'xlsx' ? 'xlsx' : 'pdf'}`;
        downloadBlob(result, filename);
      } else if (result && typeof result === 'object' && 'queued' in (result as any)) {
        alert((result as any).message || 'Export queued — you will receive an email when ready.');
      }
    } catch (e: any) {
      alert('Export failed: ' + String(e?.message ?? e).slice(0, 150));
    } finally { setExporting(null); }
  };

  const content = (
    <div className="px-6 py-6 md:px-8 lg:px-10">
      <div className="mb-6">
        <div className="text-xs text-amber-700 font-semibold tracking-widest mb-1">REPORTS • STUDENT STATEMENT</div>
        <h1 className="text-2xl font-extrabold text-gray-900 mb-4">Individual Student Statement</h1>

        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-[320px]">
            <MatricStudentInput
              value={matricInput}
              onChange={(v) => {
                setMatricInput(v);
                setResolvedStudent(null);
              }}
              onResolved={(s, resErr) => {
                if (resErr) {
                  setErr(resErr);
                  setData(null);
                  setResolvedStudent(null);
                } else if (s) {
                  setErr(null);
                  setResolvedStudent(s);
                  setMatricInput(s.matricNumber ?? '');
                  doFetch(Number(s.id), s.matricNumber ?? undefined);
                }
              }}
              label="Matric Number Search"
              placeholder="Enter matric (e.g. 2023/SCI/1001) — Enter or blur to resolve"
              autoResolveOnMount={!!sp.get('matricNumber')}
              helpText="Relaxed matching: accepts 4 schema formats (slash, hyphen, dot, underscore separators)."
            />
            {resolvedStudent && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => doFetch(Number(resolvedStudent.id), resolvedStudent.matricNumber ?? undefined)}
                  disabled={loading}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Load Statement
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 pt-6">
            <button
              type="button"
              onClick={() => runExport('xlsx')}
              disabled={!data || !!exporting || !hasPerm('REPORTS_EXPORT_EXCEL', userPerms, role)}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg disabled:opacity-50"
              title={hasPerm('REPORTS_EXPORT_EXCEL', userPerms, role) ? 'Download Statement Excel' : 'Permission required: REPORTS_EXPORT_EXCEL'}
            >
              {exporting === 'xlsx' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
              Statement Excel
            </button>
            <button
              type="button"
              onClick={() => runExport('pdf')}
              disabled={!data || !!exporting || !hasPerm('REPORTS_EXPORT_PDF', userPerms, role)}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold bg-rose-700 hover:bg-rose-800 text-white rounded-lg disabled:opacity-50"
              title={hasPerm('REPORTS_EXPORT_PDF', userPerms, role) ? 'Download Statement PDF (includes Bursar signature block)' : 'Permission required: REPORTS_EXPORT_PDF'}
            >
              {exporting === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Statement PDF
            </button>
          </div>
        </div>
      </div>

      {err && !loading && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 mb-5">
          <AlertTriangle className="h-4 w-4 inline mr-2 -mt-0.5" /> {err}
        </div>
      )}

      {st && summary && (
        <>
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5 mb-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center border border-amber-200">
                <GraduationCap className="h-6 w-6" />
              </div>
              <div>
                <div className="text-xs text-gray-500 font-semibold tracking-wide mb-0.5">NAME</div>
                <div className="font-bold text-gray-900">{st.fullName ?? [st.firstName, st.middleName, st.lastName].filter(Boolean).join(' ')}</div>
                <div className="text-xs text-gray-500 font-semibold tracking-wide mt-1 mb-0.5">MATRIC</div>
                <div className="font-mono text-sm text-gray-800">{st.matricNumber ?? '—'}</div>
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500 font-semibold tracking-wide mb-0.5">COLLEGE</div>
              <div className="font-semibold text-gray-800">{st.college ?? '—'}</div>
              <div className="text-xs text-gray-500 font-semibold tracking-wide mt-2 mb-0.5">DEPARTMENT</div>
              <div className="font-semibold text-gray-800">{st.department ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 font-semibold tracking-wide mb-0.5">PROGRAMME</div>
              <div className="font-semibold text-gray-800">{st.programme ?? '—'}</div>
              <div className="text-xs text-gray-500 font-semibold tracking-wide mt-2 mb-0.5">LEVEL</div>
              <div className="font-semibold text-gray-800">{st.level ?? st.academicLevel ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 font-semibold tracking-wide mb-0.5">CURRENT SESSION</div>
              <div className="font-semibold text-gray-800">{st.session ?? st.academicSession ?? '—'}</div>
              <div className="text-xs text-gray-500 font-semibold tracking-wide mt-2 mb-0.5">EMAIL</div>
              <div className="font-semibold text-gray-800 truncate">{st.email ?? '—'}</div>
            </div>
          </div>

          <div className="mb-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
              {SUMMARY_METRICS.map((metric) => {
                const Icon = metric.icon;
                const rawVal = (summary as any)?.[metric.key];
                const displayVal = metric.isMoney
                  ? fmtNGN(rawVal)
                  : metric.isCount
                    ? rawVal != null ? String(Number(rawVal)) : '0'
                    : rawVal != null ? String(rawVal) : '—';
                return (
                  <div key={metric.key} className={`rounded-xl border p-3 ${metric.color}`}>
                    <div className="flex items-center justify-between mb-2">
                      <Icon className="h-4 w-4" />
                      <span className="text-[10px] uppercase tracking-wider font-bold opacity-70">{metric.label}</span>
                    </div>
                    <div className="text-lg font-bold font-mono tabular-nums" title={`API payload.summary.${metric.key} = ${JSON.stringify(rawVal)} (AC-2: server-derived, never client-computed)`}>
                      {displayVal}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 text-sm font-bold text-gray-800 flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-gray-500" />
              Chronological Ledger
              <span className="inline-flex rounded-full bg-gray-100 text-gray-600 px-2 py-0.5 text-xs font-mono">
                {ledgerRows.length} rows
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b">Date</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b">Description</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b">Bill</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-700 border-b">Debit</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-700 border-b">Credit</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-700 border-b">Running Balance</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b">Reference</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b">Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerRows.map((r: any, i: number) => (
                    <tr key={i} className="border-b border-gray-50 hover:bg-amber-50/40">
                      <td className="px-3 py-1.5 whitespace-nowrap">{r.date ?? r.entryDate ?? r.createdAt ?? ''}</td>
                      <td className="px-3 py-1.5">{r.description ?? ''}</td>
                      <td className="px-3 py-1.5">{r.bill ?? r.billName ?? ''}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">{r.debit ? fmtNGN(r.debit) : '—'}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-emerald-700">{r.credit ? fmtNGN(r.credit) : '—'}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums font-bold">{fmtNGN(r.runningBalance ?? r.balance)}</td>
                      <td className="px-3 py-1.5 font-mono">{r.reference ?? r.ref ?? r.transactionReference ?? ''}</td>
                      <td className="px-3 py-1.5 font-mono">{r.receipt ?? r.receiptNumber ?? ''}</td>
                    </tr>
                  ))}
                  {ledgerRows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="p-10 text-center text-gray-500">No ledger rows for criteria.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {!st && !loading && !err && (
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-10 text-center text-gray-500">
          <GraduationCap className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          Enter a Matric Number above to generate a statement.
        </div>
      )}
    </div>
  );

  return (
    <PortalShell
      role={role}
      activePath={activePath}
      brand={brand}
      userText={userText}
      userEmail={user?.email}
      onLogout={logout}
      userPermissions={userPerms}
      navCounters={navCounts}
      showGlobalSearch
    >
      {content}
    </PortalShell>
  );
};

export default StudentStatementPage;
