import React, { useState, useRef, useMemo } from 'react';
import { Download, UploadCloud, FileSpreadsheet, AlertTriangle, CheckCircle2, XCircle, Info, Loader2, StepForward } from 'lucide-react';
import Modal from '../Modal';
import { AcademicBulkKind, BulkImportResult, BulkRowError, bulkImport } from '../../services/academicApi';
import { API_BASE_URL } from '../../services/api';

const kindLabels: Record<AcademicBulkKind, { singular: string; plural: string; capital: string }> = {
  college: { singular: 'College', plural: 'Colleges', capital: 'COLLEGE' },
  department: { singular: 'Department', plural: 'Departments', capital: 'DEPARTMENT' },
  programme: { singular: 'Programme', plural: 'Programmes', capital: 'PROGRAMME' },
};

const stepInstructions: Record<AcademicBulkKind, { step: number; title: string; bullets: string[] }> = {
  college: {
    step: 1,
    title: 'STEP 1 — Always import Colleges FIRST',
    bullets: [
      'Colleges are the TOP of the academic hierarchy (other entities reference them).',
      'Fill the code column (e.g. COS, ENG, MED) — this code is used later as the parent key in Departments CSV.',
      'Download the template below to guarantee correct column names and ordering.',
    ],
  },
  department: {
    step: 2,
    title: 'STEP 2 — Import Departments AFTER Colleges',
    bullets: [
      'Every Department MUST reference a College. Use collegeCode (PREFERRED) OR collegeId.',
      'Copy collegeCode values EXACTLY from the Colleges page / your already-uploaded College CSV.',
      'If you get "collegeCode X not found" errors, go back to Step 1 and import the Colleges CSV first.',
    ],
  },
  programme: {
    step: 3,
    title: 'STEP 3 — Import Programmes AFTER Departments',
    bullets: [
      'Every Programme MUST reference a Department. Use departmentCode (PREFERRED) OR departmentId.',
      'Copy departmentCode values EXACTLY from the Departments page / your already-uploaded Dept CSV.',
      'Optional: Fill collegeCode for an extra cross-check (we verify the dept actually belongs to that college).',
    ],
  },
};

interface Props {
  kind: AcademicBulkKind;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (result: BulkImportResult) => void;
}

const VALID_FILE_RE = /\.(csv|xlsx|xls)$/i;

const BulkImportModal: React.FC<Props> = ({ kind, isOpen, onClose, onSuccess }) => {
  const labels = kindLabels[kind];
  const instructions = stepInstructions[kind];
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BulkImportResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setResult(null);
    setErrorMsg('');
    setSubmitting(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const downloadErrorsCsv = () => {
    if (!result?.errorsCsvUrl) return;
    const token = localStorage.getItem('token') ?? '';
    const abs = result.errorsCsvUrl.startsWith('/') ? `${API_BASE_URL.replace(/\/api\/v1$/, '')}${result.errorsCsvUrl}` : result.errorsCsvUrl;
    const sep = abs.includes('?') ? '&' : '?';
    const url = `${abs}${sep}access_token=${encodeURIComponent(token)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setResult(null);
    setErrorMsg('');
    if (!f) { setFile(null); return; }
    if (!VALID_FILE_RE.test(f.name)) {
      setErrorMsg(`Unsupported file "${f.name}". Please choose CSV, XLSX, or XLS.`);
      setFile(null);
      return;
    }
    if ((f.size ?? 0) > 20 * 1024 * 1024) {
      setErrorMsg(`File too large (${((f.size ?? 0) / 1024 / 1024).toFixed(1)} MB). Max 20 MB.`);
      setFile(null);
      return;
    }
    setFile(f);
  };

  const doUpload = async () => {
    if (!file) return;
    setSubmitting(true);
    setResult(null);
    setErrorMsg('');
    try {
      const r = await bulkImport(kind, file);
      setResult(r);
      if ((r.created ?? 0) > 0) {
        setTimeout(() => onSuccess(r), 0);
      }
    } catch (e: any) {
      setErrorMsg(e?.response?.data?.message ?? e?.message ?? 'Upload failed. Please check the file format.');
    } finally {
      setSubmitting(false);
    }
  };

  const stepBadgeClass = useMemo(() => {
    if (kind === 'college') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (kind === 'department') return 'bg-amber-50 text-amber-700 border-amber-200';
    return 'bg-indigo-50 text-indigo-700 border-indigo-200';
  }, [kind]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={`Bulk Import ${labels.plural}`}
      size="xl"
      footer={
        <>
          <button
            onClick={handleClose}
            disabled={submitting}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium text-sm disabled:opacity-50"
          >
            Close
          </button>
          <button
            onClick={doUpload}
            disabled={submitting || !file}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
            {submitting ? `Importing ${labels.plural}…` : `Import ${labels.plural}`}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <div className={`border rounded-xl p-4 ${stepBadgeClass}`}>
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-white border flex items-center justify-center font-bold text-sm">
              <StepForward className="h-5 w-5" />
            </div>
            <div className="flex-1 space-y-1">
              <div className="text-xs font-bold uppercase tracking-wider opacity-80">Hierarchy Step {instructions.step} of 3</div>
              <div className="font-semibold">{instructions.title}</div>
              <ul className="space-y-1 text-sm mt-2 list-disc list-outside ml-5 opacity-95">
                {instructions.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-sm">
            <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
            <div>
              <div className="font-semibold">Supported formats</div>
              <div className="text-emerald-700 text-xs">CSV, Excel .xlsx, Excel .xls (max 20 MB)</div>
            </div>
          </div>
          <div className="flex items-center gap-2 px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl text-blue-800 text-sm">
            <Info className="h-5 w-5 flex-shrink-0" />
            <div>
              <div className="font-semibold">Parent matching</div>
              <div className="text-blue-700 text-xs">By <b>Code</b> first (recommended), then numeric ID as fallback.</div>
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-800 mb-2">
            Select {labels.plural} CSV / Excel File
          </label>
          <div className="border-2 border-dashed border-gray-300 hover:border-blue-400 rounded-2xl transition-colors bg-gray-50/50 p-6">
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={onFileChange}
              className="hidden"
              id={`bulk-upload-${kind}`}
            />
            <label
              htmlFor={`bulk-upload-${kind}`}
              className="flex flex-col items-center justify-center gap-2 cursor-pointer text-center"
            >
              <div className="w-14 h-14 rounded-full bg-white shadow-sm border flex items-center justify-center">
                <FileSpreadsheet className="h-7 w-7 text-blue-600" />
              </div>
              <div className="font-semibold text-gray-800 text-sm">
                Click to select file or drag &amp; drop
              </div>
              <div className="text-xs text-gray-500">Accepts .csv, .xlsx, .xls</div>
            </label>
            {file && (
              <div className="mt-4 flex items-center justify-between px-4 py-3 bg-white border border-gray-200 rounded-xl">
                <div className="flex items-center gap-3 min-w-0">
                  <FileSpreadsheet className="h-5 w-5 text-green-600 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{file.name}</div>
                    <div className="text-xs text-gray-500">{(file.size / 1024).toFixed(1)} KB</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); setFile(null); if (inputRef.current) inputRef.current.value = ''; }}
                  className="text-xs text-red-600 hover:text-red-700 font-semibold px-2 py-1 rounded hover:bg-red-50"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
          {errorMsg && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              <XCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <div className="flex-1 whitespace-pre-wrap break-words">{errorMsg}</div>
            </div>
          )}
        </div>

        {result && (
          <div className="border-t border-gray-200 pt-4 space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-emerald-700">{result.created ?? 0}</div>
                <div className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">Created</div>
              </div>
              <div className={`rounded-xl p-3 text-center ${
                (result.skipped ?? 0) > 0
                  ? 'bg-amber-50 border border-amber-200'
                  : 'bg-gray-50 border border-gray-200'
              }`}>
                <div className={`text-2xl font-bold ${(result.skipped ?? 0) > 0 ? 'text-amber-700' : 'text-gray-600'}`}>
                  {result.skipped ?? 0}
                </div>
                <div className={`text-xs font-semibold uppercase tracking-wide ${(result.skipped ?? 0) > 0 ? 'text-amber-700' : 'text-gray-600'}`}>
                  Skipped
                </div>
              </div>
              <div className={`rounded-xl p-3 text-center ${
                (result.errors?.length ?? 0) > 0
                  ? 'bg-red-50 border border-red-200'
                  : 'bg-gray-50 border border-gray-200'
              }`}>
                <div className={`text-2xl font-bold ${(result.errors?.length ?? 0) > 0 ? 'text-red-700' : 'text-gray-600'}`}>
                  {result.errors?.length ?? 0}
                </div>
                <div className={`text-xs font-semibold uppercase tracking-wide ${(result.errors?.length ?? 0) > 0 ? 'text-red-700' : 'text-gray-600'}`}>
                  Errors
                </div>
              </div>
            </div>

            {(result.createdItems?.length ?? 0) > 0 && (
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800 mb-2">
                  <CheckCircle2 className="h-4 w-4" /> Created {labels.plural}
                </div>
                <div className="max-h-28 overflow-y-auto border border-emerald-200 rounded-lg divide-y divide-emerald-100 bg-emerald-50/40">
                  {result.createdItems!.map((it) => (
                    <div key={it.id} className="grid grid-cols-12 gap-2 px-3 py-1.5 text-xs">
                      <div className="col-span-2 text-gray-500 font-mono">#{it.id}</div>
                      <div className="col-span-3 font-mono font-semibold text-emerald-800">{it.code}</div>
                      <div className="col-span-7 text-gray-800 truncate">{it.name}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(result.errors?.length ?? 0) > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-red-800">
                    <AlertTriangle className="h-4 w-4" /> Row Errors ({result.errors!.length})
                  </div>
                  <button
                    onClick={downloadErrorsCsv}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-800 px-2 py-1 rounded hover:bg-red-50"
                  >
                    <Download className="h-3.5 w-3.5" /> Download errors.csv
                  </button>
                </div>
                <div className="max-h-56 overflow-y-auto border border-red-200 rounded-lg">
                  <table className="min-w-full divide-y divide-red-200 text-xs">
                    <thead className="bg-red-50 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold text-red-800 w-16">Row #</th>
                        <th className="text-left px-3 py-2 font-semibold text-red-800 w-56">Code / Name</th>
                        <th className="text-left px-3 py-2 font-semibold text-red-800">Error Message</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-red-100 bg-white">
                      {result.errors!.map((e: BulkRowError, i) => (
                        <tr key={i} className="hover:bg-red-50/30">
                          <td className="px-3 py-2 font-mono text-gray-700">{e.row}</td>
                          <td className="px-3 py-2 font-medium text-gray-900 truncate max-w-[14rem]">{e.record}</td>
                          <td className="px-3 py-2 text-red-800 whitespace-pre-wrap break-words">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default BulkImportModal;
