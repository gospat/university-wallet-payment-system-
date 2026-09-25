import React, { useEffect, useState } from 'react';
import { Save, RotateCcw, Settings, CreditCard, Shield, Landmark, FileText, PenLine, Info } from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import ConfirmAction from '../../components/ConfirmAction';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/AuthContext';
import { settingsApi, SystemSettingsOut, SystemSettingsPatch } from '../../services/adminApi';
import { navCounters, NavCounters } from '../../services/api';
import { useLocation } from 'react-router-dom';
import { i18n } from '../../i18n/en';

const inputCls = 'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm';

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
  </div>
);

type AlertState = { isOpen: boolean; title: string; message: string; type: 'error' | 'success' };

const SystemSettingsPage: React.FC = () => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [navCounts, setNavCounts] = useState<NavCounters>({});

  const [original, setOriginal] = useState<SystemSettingsOut | null>(null);
  const [form, setForm] = useState<SystemSettingsOut | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'error' });
  const [showConfirmDiscard, setShowConfirmDiscard] = useState(false);

  useEffect(() => {
    navCounters().then(setNavCounts).catch(() => {});
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    loadSettings();
    return () => ctrl.abort();
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const data = await settingsApi.get();
      setOriginal(data);
      setForm({ ...data });
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setAlert({ isOpen: true, title: 'Failed to load settings', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const isDirty = ((): boolean => {
    if (!original || !form) return false;
    const keys = Object.keys(original) as Array<keyof SystemSettingsOut>;
    for (const k of keys) {
      if (k === 'id' || k === 'createdAt' || k === 'updatedAt' || k === 'updatedById') continue;
      if (String(original[k] ?? '') !== String(form[k] ?? '')) return true;
    }
    return false;
  })();

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes';
        return 'You have unsaved changes';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const updateField = <K extends keyof SystemSettingsOut>(key: K, value: SystemSettingsOut[K]) => {
    if (!form) return;
    setForm({ ...form, [key]: value });
  };

  const handleDiscard = () => {
    if (!original) return;
    setForm({ ...original });
    setShowConfirmDiscard(false);
  };

  const handleSave = async () => {
    if (!original || !form) return;
    const patch: SystemSettingsPatch = {};
    const keys = Object.keys(original) as Array<keyof SystemSettingsOut>;
    for (const k of keys) {
      if (k === 'id' || k === 'createdAt' || k === 'updatedAt' || k === 'updatedById') continue;
      if (String(original[k] ?? '') !== String(form[k] ?? '')) {
        (patch as any)[k] = form[k];
      }
    }
    if (Object.keys(patch).length === 0) {
      setAlert({ isOpen: true, title: 'No changes', message: 'There are no changes to save.', type: 'success' });
      return;
    }
    setSaving(true);
    try {
      const updated = await settingsApi.patch(patch);
      setOriginal(updated);
      setForm({ ...updated });
      setAlert({ isOpen: true, title: 'Success', message: 'Settings saved successfully', type: 'success' });
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setAlert({ isOpen: true, title: 'Save failed', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const fullName = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();

  return (
    <PortalShell
      role="ADMIN"
      activePath={location.pathname}
      brand={i18n.portals.admin.dashboardBrand}
      userText={fullName || i18n.portals.admin.dashboardGreeting('')}
      userEmail={user?.email ?? undefined}
      onLogout={logout}
      userPermissions={(user?.permissions as string[]) ?? []}
      showGlobalSearch
      navCounters={navCounts}
    >
      <div className="w-full space-y-6 pb-20 relative">
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-gray-100 rounded-lg">
              <Settings className="h-6 w-6 text-gray-700" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">System Settings</h1>
              <p className="text-sm text-gray-500">Configure university, payments, receipts, and session defaults</p>
            </div>
          </div>
        </div>

        {isDirty && (
          <div className="yellow text-amber-700 bg-amber-50 border border-amber-200 px-4 py-2 rounded mb-4 flex items-center gap-2">
            <Shield className="h-4 w-4 text-amber-600 shrink-0" />
            <span className="text-sm font-medium">You have unsaved changes</span>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-16">
            <svg className="animate-spin h-8 w-8 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}

        {!loading && form && (
          <div className="space-y-6 max-w-5xl">
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="p-6 border-b border-gray-100 flex items-center gap-3">
                <div className="p-2 bg-amber-50 rounded-lg">
                  <Landmark className="h-5 w-5 text-amber-700" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">University</h2>
                  <p className="text-sm text-gray-500">Institution identity and contact details</p>
                </div>
              </div>
              <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <Field label="Name">
                    <input
                      className={inputCls}
                      value={form.universityName ?? ''}
                      onChange={(e) => updateField('universityName', e.target.value)}
                      placeholder="e.g. University of Lagos"
                    />
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <Field label="Logo URL (optional)">
                    <input
                      type="url"
                      className={inputCls}
                      value={form.universityLogoUrl ?? ''}
                      onChange={(e) => updateField('universityLogoUrl', e.target.value)}
                      placeholder="https://..."
                    />
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <Field label="Favicon URL (optional)">
                    <div className="flex items-start gap-3">
                      <div className="flex-1">
                        <input
                          type="url"
                          className={inputCls}
                          value={form.universityFaviconUrl ?? ''}
                          onChange={(e) => updateField('universityFaviconUrl', e.target.value)}
                          placeholder="https://.../favicon.ico"
                        />
                      </div>
                      <div className="flex-shrink-0 w-10 h-10 bg-gray-50 border border-gray-200 rounded-md flex items-center justify-center overflow-hidden">
                        {form.universityFaviconUrl ? (
                          <img
                            src={form.universityFaviconUrl}
                            alt="favicon preview"
                            className="w-6 h-6 object-contain"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).replaceWith(
                                Object.assign(document.createElement('span'), { className: 'text-xs text-gray-400', textContent: '?' })
                              );
                            }}
                          />
                        ) : (
                          <Info className="h-4 w-4 text-gray-400" />
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Browser tab icon (16x16 / 32x32; .ico or .png). Affects document favicon live.</p>
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <Field label="Address">
                    <textarea
                      rows={2}
                      className={inputCls}
                      value={form.universityAddress ?? ''}
                      onChange={(e) => updateField('universityAddress', e.target.value)}
                      placeholder="Street, city, state, country"
                    />
                  </Field>
                </div>
                <Field label="Phone">
                  <input
                    className={inputCls}
                    value={form.universityPhone ?? ''}
                    onChange={(e) => updateField('universityPhone', e.target.value)}
                    placeholder="+234..."
                  />
                </Field>
                <Field label="Email">
                  <input
                    type="email"
                    className={inputCls}
                    value={form.universityEmail ?? ''}
                    onChange={(e) => updateField('universityEmail', e.target.value)}
                    placeholder="info@university.edu.ng"
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Website">
                    <input
                      type="url"
                      className={inputCls}
                      value={form.universityWebsite ?? ''}
                      onChange={(e) => updateField('universityWebsite', e.target.value)}
                      placeholder="https://www.university.edu.ng"
                    />
                  </Field>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="p-6 border-b border-gray-100 flex items-center gap-3">
                <div className="p-2 bg-blue-50 rounded-lg">
                  <CreditCard className="h-5 w-5 text-blue-700" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Payments</h2>
                  <p className="text-sm text-gray-500">Payment processing thresholds and mode</p>
                </div>
              </div>
              <div className="p-6 space-y-5">
                <div className="flex items-start gap-3">
                  <input
                    id="paystackLiveEnabled"
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    checked={!!form.paystackLiveEnabled}
                    onChange={(e) => updateField('paystackLiveEnabled', e.target.checked)}
                  />
                  <div>
                    <label htmlFor="paystackLiveEnabled" className="cursor-pointer text-sm font-medium text-gray-700">
                      Enable Paystack Live Mode (unchecked = Sandbox)
                    </label>
                    <p className="text-xs text-gray-500 mt-0.5">
                      When checked, Paystack charges real cards. Uncheck for testing with fake cards in Sandbox mode.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label="Large Payment Threshold (₦)">
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500 pointer-events-none">₦</span>
                      <input
                        inputMode="numeric"
                        className={`${inputCls} pl-8`}
                        value={String(form.largePaymentThreshold ?? '')}
                        onChange={(e) => {
                          const v = e.target.value.replace(/[^0-9.]/g, '');
                          updateField('largePaymentThreshold', v === '' ? 0 : Number(v));
                        }}
                        placeholder="100000"
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Amounts above this flag for special handling</p>
                  </Field>
                  <Field label="Bulk Upload Error Threshold (count)">
                    <input
                      inputMode="numeric"
                      className={inputCls}
                      value={String(form.importErrorThreshold ?? 0)}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9]/g, '');
                        updateField('importErrorThreshold', v === '' ? 0 : Number(v));
                      }}
                      placeholder="5"
                    />
                    <p className="text-xs text-gray-500 mt-1">Students above this total CSV errors will abort the import</p>
                  </Field>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="p-6 border-b border-gray-100 flex items-center gap-3">
                <div className="p-2 bg-emerald-50 rounded-lg">
                  <FileText className="h-5 w-5 text-emerald-700" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Receipts</h2>
                  <p className="text-sm text-gray-500">Reference prefixes and receipt footer text</p>
                </div>
              </div>
              <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Receipt Prefix">
                  <input
                    className={inputCls}
                    value={form.receiptPrefix ?? ''}
                    onChange={(e) => updateField('receiptPrefix', e.target.value)}
                    placeholder="e.g. REC"
                  />
                </Field>
                <Field label="Payment Ref Prefix">
                  <input
                    className={inputCls}
                    value={form.paymentRefPrefix ?? ''}
                    onChange={(e) => updateField('paymentRefPrefix', e.target.value)}
                    placeholder="e.g. PAY"
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Receipt Footer Text">
                    <textarea
                      rows={3}
                      maxLength={500}
                      className={inputCls}
                      value={form.receiptFooterText ?? ''}
                      onChange={(e) => updateField('receiptFooterText', e.target.value)}
                      placeholder="Up to 500 chars; shown at bottom of every generated receipt"
                    />
                  </Field>
                  <p className="text-xs text-gray-500 mt-1">Up to 500 chars; shown at bottom of every generated receipt</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="p-6 border-b border-gray-100 flex items-center gap-3">
                <div className="p-2 bg-rose-50 rounded-lg">
                  <PenLine className="h-5 w-5 text-rose-700" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Receipt Bursar Signature</h2>
                  <p className="text-sm text-gray-500">Printed signing block shown at the bottom of every receipt PDF</p>
                </div>
              </div>
              <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <Field label="Signatory Name">
                    <input
                      className={inputCls}
                      value={form.receiptBursarName ?? ''}
                      onChange={(e) => updateField('receiptBursarName', e.target.value)}
                      placeholder="e.g. Mrs. Adenike O. Bursar"
                      maxLength={190}
                    />
                  </Field>
                  <p className="text-xs text-gray-500 mt-1">Name printed under the signature line. Leave blank to show placeholder.</p>
                </div>
                <div className="sm:col-span-2">
                  <Field label="Signatory Title">
                    <input
                      className={inputCls}
                      value={form.receiptBursarTitle ?? ''}
                      onChange={(e) => updateField('receiptBursarTitle', e.target.value)}
                      placeholder="e.g. Bursar, Bursary Department"
                      maxLength={190}
                    />
                  </Field>
                  <p className="text-xs text-gray-500 mt-1">Title printed below the signatory name.</p>
                </div>
                <div className="sm:col-span-2">
                  <Field label="Signature Image URL (PNG / SVG, max ~72px height)">
                    <div className="flex items-start gap-3">
                      <div className="flex-1">
                        <input
                          type="url"
                          className={inputCls}
                          value={form.receiptBursarSignatureUrl ?? ''}
                          onChange={(e) => updateField('receiptBursarSignatureUrl', e.target.value)}
                          placeholder="https://.../bursar-signature.png"
                        />
                      </div>
                      <div className="flex-shrink-0 w-40 h-20 bg-white border border-dashed border-gray-300 rounded-md flex items-center justify-center overflow-hidden">
                        {form.receiptBursarSignatureUrl ? (
                          <img
                            src={form.receiptBursarSignatureUrl}
                            alt="signature preview"
                            className="max-w-full max-h-full object-contain"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).replaceWith(
                                Object.assign(document.createElement('span'), { className: 'text-xs text-gray-400 px-2 text-center', textContent: 'Could not load image' })
                              );
                            }}
                          />
                        ) : (
                          <PenLine className="h-5 w-5 text-gray-300" />
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Transparent PNG/SVG of the signatory's written signature. Printed above the signature line if provided.</p>
                  </Field>
                </div>
                <div className="sm:col-span-2 border border-rose-100 bg-rose-50/40 rounded-lg p-4">
                  <p className="text-xs text-rose-800">
                    <strong>Note:</strong> Setting any field above flips the receipt footer T&C from
                    <em> "requires no signature"</em> to <em>"validates the Bursary signatory above"</em> and renders a
                    2-column signature + <strong>"APPROVED BY"</strong> manual stamp box on printed PDFs.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {isDirty && (
          <div className="fixed bottom-6 right-6 z-30 bg-white border border-gray-200 rounded-xl shadow-lg p-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowConfirmDiscard(true)}
              className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium rounded-lg transition-colors"
            >
              <RotateCcw className="h-4 w-4" />
              Discard Changes
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save Changes
            </button>
          </div>
        )}
      </div>

      <ConfirmAction
        isOpen={showConfirmDiscard}
        onClose={() => setShowConfirmDiscard(false)}
        onConfirm={() => { handleDiscard(); return Promise.resolve(); }}
        title="Discard changes?"
        description="Any unsaved edits to system settings will be lost and reverted to the last saved values."
        resourceLabel="System Settings"
        confirmLabel="Discard Changes"
        confirmVariant="warning"
        cancelLabel="Keep Editing"
      />

      <Modal
        isOpen={alert.isOpen}
        onClose={() => setAlert({ ...alert, isOpen: false })}
        title={alert.title}
        footer={
          <button
            onClick={() => setAlert({ ...alert, isOpen: false })}
            className={`px-6 py-2 rounded-lg font-bold text-white shadow-md transition-all ${
              alert.type === 'success' ? 'bg-green-600 hover:bg-green-700 shadow-green-200' : 'bg-red-600 hover:bg-red-700 shadow-red-200'
            }`}
          >
            Acknowledge
          </button>
        }
      >
        <div className="py-4">
          <p className="text-gray-700 text-lg">{alert.message}</p>
        </div>
      </Modal>
    </PortalShell>
  );
};

export default SystemSettingsPage;
