import React, { useEffect, useState } from 'react';
import { Save, RotateCcw, Settings, CreditCard, Shield, Landmark, FileText, PenLine, Info, Mail, RefreshCw, Send, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import ConfirmAction from '../../components/ConfirmAction';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/AuthContext';
import {
  settingsApi,
  SystemSettingsOut,
  SystemSettingsPatch,
  emailTemplatesApi,
  emailDeliveryLogsApi,
  EmailTemplateConfigOut,
  EmailTemplateConfigPatch,
  EmailDeliveryLogOut,
  EmailDeliveryListParams,
  EmailDeliveryListOut,
  EmailDeliveryStatusKey,
  EmailTypeKey,
} from '../../services/adminApi';
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

  const [emailTemplate, setEmailTemplate] = useState<EmailTemplateConfigOut | null>(null);
  const [emailTemplateOrig, setEmailTemplateOrig] = useState<EmailTemplateConfigOut | null>(null);
  const [emailTemplateLoading, setEmailTemplateLoading] = useState(false);
  const [emailTemplateSaving, setEmailTemplateSaving] = useState(false);

  const [deliveryLogs, setDeliveryLogs] = useState<EmailDeliveryListOut | null>(null);
  const [deliveryLogsLoading, setDeliveryLogsLoading] = useState(false);
  const [deliveryLogsPage, setDeliveryLogsPage] = useState(1);
  const [deliveryLogsFilterStatus, setDeliveryLogsFilterStatus] = useState<EmailDeliveryStatusKey | ''>('');
  const [deliveryLogsFilterType, setDeliveryLogsFilterType] = useState<EmailTypeKey | ''>('');
  const [deliveryLogsFilterSearch, setDeliveryLogsFilterSearch] = useState('');
  const [selectedLog, setSelectedLog] = useState<EmailDeliveryLogOut | null>(null);

  useEffect(() => {
    navCounters().then(setNavCounts).catch(() => {});
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    loadSettings();
    loadEmailTemplate();
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    loadDeliveryLogs();
  }, [deliveryLogsPage, deliveryLogsFilterStatus, deliveryLogsFilterType, deliveryLogsFilterSearch]);

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

  const loadEmailTemplate = async () => {
    setEmailTemplateLoading(true);
    try {
      const data = await emailTemplatesApi.get('student_credentials');
      setEmailTemplate({ ...data });
      setEmailTemplateOrig({ ...data });
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setAlert({ isOpen: true, title: 'Failed to load email template', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setEmailTemplateLoading(false);
    }
  };

  const updateEmailField = <K extends keyof EmailTemplateConfigOut>(key: K, value: EmailTemplateConfigOut[K]) => {
    if (!emailTemplate) return;
    setEmailTemplate({ ...emailTemplate, [key]: value });
  };

  const isEmailTemplateDirty = ((): boolean => {
    if (!emailTemplate || !emailTemplateOrig) return false;
    const keys = Object.keys(emailTemplate) as Array<keyof EmailTemplateConfigOut>;
    for (const k of keys) {
      if (k === 'templateKey' || k === 'updatedById') continue;
      if (String(emailTemplate[k] ?? '') !== String(emailTemplateOrig[k] ?? '')) return true;
    }
    return false;
  })();

  const saveEmailTemplate = async () => {
    if (!emailTemplateOrig || !emailTemplate) return;
    const patch: EmailTemplateConfigPatch = {};
    const keys = Object.keys(emailTemplateOrig) as Array<keyof EmailTemplateConfigOut>;
    for (const k of keys) {
      if (k === 'templateKey' || k === 'updatedById') continue;
      if (String(emailTemplateOrig[k] ?? '') !== String(emailTemplate[k] ?? '')) {
        (patch as any)[k] = emailTemplate[k];
      }
    }
    if (Object.keys(patch).length === 0) {
      setAlert({ isOpen: true, title: 'No changes', message: 'No email template changes to save.', type: 'success' });
      return;
    }
    setEmailTemplateSaving(true);
    try {
      const updated = await emailTemplatesApi.patch('student_credentials', patch);
      setEmailTemplate({ ...updated });
      setEmailTemplateOrig({ ...updated });
      setAlert({ isOpen: true, title: 'Success', message: 'Email template saved successfully', type: 'success' });
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setAlert({ isOpen: true, title: 'Save failed', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setEmailTemplateSaving(false);
    }
  };

  const discardEmailChanges = () => {
    if (!emailTemplateOrig) return;
    setEmailTemplate({ ...emailTemplateOrig });
  };

  const loadDeliveryLogs = async () => {
    setDeliveryLogsLoading(true);
    try {
      const params: EmailDeliveryListParams = { page: deliveryLogsPage, pageSize: 25 };
      if (deliveryLogsFilterStatus) params.status = deliveryLogsFilterStatus;
      if (deliveryLogsFilterType) params.emailType = deliveryLogsFilterType;
      if (deliveryLogsFilterSearch) params.toAddressContains = deliveryLogsFilterSearch;
      const data = await emailDeliveryLogsApi.list(params);
      setDeliveryLogs(data);
    } catch (_) {
      setDeliveryLogs(null);
    } finally {
      setDeliveryLogsLoading(false);
    }
  };

  const previewAccent = (c?: string | null) => {
    const color = (c || '#2563eb').replace(/^#?/, '#');
    if (/^#[0-9a-fA-F]{6}$/.test(color) || /^#[0-9a-fA-F]{3}$/.test(color) || /^#[0-9a-fA-F]{8}$/.test(color)) return color;
    return '#2563eb';
  };

  const statusBadge = (s: EmailDeliveryStatusKey): string => {
    const m: Record<EmailDeliveryStatusKey, string> = {
      PENDING: 'bg-gray-100 text-gray-700 border-gray-200',
      SENT: 'bg-green-50 text-green-700 border-green-200',
      RETRIED: 'bg-amber-50 text-amber-700 border-amber-200',
      FAILED: 'bg-red-50 text-red-700 border-red-200',
    };
    return m[s] ?? 'bg-gray-100 text-gray-700 border-gray-200';
  };

  const emailTypeLabel = (t: EmailTypeKey): string => {
    const m: Record<EmailTypeKey, string> = {
      STUDENT_CREDENTIALS: 'Student Credentials',
      PASSWORD_RESET: 'Password Reset',
      PAYMENT_SUCCESSFUL: 'Payment Success',
      FEE_ASSIGNED: 'Fee Assigned',
      BILL_CREATED: 'Bill Created',
      REFUND_REQUESTED: 'Refund Requested',
      REFUND_APPROVED: 'Refund Approved',
      REFUND_REJECTED: 'Refund Rejected',
      OTHER: 'Other',
    };
    return m[t] ?? t;
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

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="p-6 border-b border-gray-100 flex items-center gap-3">
                <div className="p-2 bg-indigo-50 rounded-lg">
                  <Mail className="h-5 w-5 text-indigo-700" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Email Delivery &amp; Templates</h2>
                  <p className="text-sm text-gray-500">Configure student credential email templates and monitor delivery status</p>
                </div>
              </div>
              <div className="p-6 space-y-8">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-700 flex items-center justify-center shrink-0">
                        <PenLine className="h-4 w-4" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-gray-900">Student Credentials Template</h3>
                        <p className="text-xs text-gray-500">Sent automatically when a student account is created or credentials are reset.</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={loadEmailTemplate}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-50 border border-gray-200 rounded-lg transition-colors"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${emailTemplateLoading ? 'animate-spin' : ''}`} />
                      Refresh
                    </button>
                  </div>

                  {emailTemplateLoading ? (
                    <div className="flex items-center justify-center py-10">
                      <svg className="animate-spin h-6 w-6 text-indigo-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    </div>
                  ) : emailTemplate ? (
                    <>
                      {isEmailTemplateDirty && (
                        <div className="border border-indigo-100 bg-indigo-50/50 rounded-lg px-4 py-2.5 flex items-center gap-2">
                          <Info className="h-4 w-4 text-indigo-600 shrink-0" />
                          <span className="text-xs font-medium text-indigo-800">Unsaved template changes — use the Save button below this section.</span>
                        </div>
                      )}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Field label="Sender Name (max 120 chars)">
                          <input
                            className={inputCls}
                            maxLength={120}
                            value={emailTemplate.senderName}
                            onChange={(e) => updateEmailField('senderName', e.target.value)}
                            placeholder="e.g. University Bursary"
                          />
                        </Field>
                        <Field label="Sender Email Address">
                          <input
                            type="email"
                            className={inputCls}
                            maxLength={254}
                            value={emailTemplate.senderAddress}
                            onChange={(e) => updateEmailField('senderAddress', e.target.value)}
                            placeholder="noreply@university.edu.ng"
                          />
                        </Field>
                        <Field label="Reply-To Address (optional)">
                          <input
                            type="email"
                            className={inputCls}
                            maxLength={254}
                            value={emailTemplate.replyToAddress ?? ''}
                            onChange={(e) => updateEmailField('replyToAddress', e.target.value || null)}
                            placeholder="support@university.edu.ng"
                          />
                        </Field>
                        <Field label="Portal Login URL">
                          <input
                            type="url"
                            className={inputCls}
                            maxLength={500}
                            value={emailTemplate.portalLoginUrl}
                            onChange={(e) => updateEmailField('portalLoginUrl', e.target.value)}
                            placeholder="https://portal.university.edu.ng/login"
                          />
                        </Field>
                        <div className="sm:col-span-2">
                          <Field label="Subject Line (max 200 chars)">
                            <input
                              className={inputCls}
                              maxLength={200}
                              value={emailTemplate.subjectLine}
                              onChange={(e) => updateEmailField('subjectLine', e.target.value)}
                              placeholder="e.g. Your University Account Has Been Created"
                            />
                          </Field>
                        </div>
                        <div className="sm:col-span-2">
                          <Field label="Greeting Line (supports placeholders: {{studentName}}, {{matricNumber}}, {{email}})">
                            <textarea
                              rows={2}
                              className={inputCls}
                              maxLength={500}
                              value={emailTemplate.greeting}
                              onChange={(e) => updateEmailField('greeting', e.target.value)}
                              placeholder="Dear {{studentName}},"
                            />
                          </Field>
                        </div>
                        <div className="sm:col-span-2">
                          <Field label="Body Paragraph (supports placeholders)">
                            <textarea
                              rows={4}
                              className={inputCls}
                              maxLength={4000}
                              value={emailTemplate.paragraph}
                              onChange={(e) => updateEmailField('paragraph', e.target.value)}
                              placeholder="Your student account has been created. Use the credentials below to access the student portal..."
                            />
                          </Field>
                        </div>
                        <Field label="Call-to-Action Button Label (max 60 chars)">
                          <div className="flex items-start gap-3">
                            <div className="flex-1">
                              <input
                                className={inputCls}
                                maxLength={60}
                                value={emailTemplate.buttonLabel}
                                onChange={(e) => updateEmailField('buttonLabel', e.target.value)}
                                placeholder="Login to Student Portal"
                              />
                            </div>
                            <div className="flex-shrink-0">
                              <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Accent</label>
                              <div className="flex items-center gap-2">
                                <input
                                  type="color"
                                  value={previewAccent(emailTemplate.accentColor)}
                                  onChange={(e) => updateEmailField('accentColor', e.target.value)}
                                  className="w-10 h-10 rounded-md border border-gray-200 p-0.5 bg-white cursor-pointer"
                                />
                                <div
                                  className="w-24 h-10 rounded-md border border-gray-200 flex items-center justify-center text-white text-xs font-bold shadow-sm"
                                  style={{ backgroundColor: previewAccent(emailTemplate.accentColor) }}
                                >
                                  {emailTemplate.buttonLabel.slice(0, 12)}
                                </div>
                              </div>
                            </div>
                          </div>
                        </Field>
                        <Field label="(reserved — Portal Login URL above)">
                          <input
                            className={`${inputCls} bg-gray-50 text-gray-500`}
                            disabled
                            value="(set above)"
                          />
                        </Field>
                        <div className="sm:col-span-2">
                          <Field label="Force Password Change Notice (shown in red banner)">
                            <textarea
                              rows={2}
                              className={inputCls}
                              maxLength={2000}
                              value={emailTemplate.forceChangeNotice}
                              onChange={(e) => updateEmailField('forceChangeNotice', e.target.value)}
                              placeholder="IMPORTANT: You must change this temporary password on your first login..."
                            />
                          </Field>
                        </div>
                        <div className="sm:col-span-2">
                          <Field label="Closing / Signature (supports placeholders: {{universityName}}, {{supportEmail}})">
                            <textarea
                              rows={3}
                              className={inputCls}
                              maxLength={2000}
                              value={emailTemplate.closing}
                              onChange={(e) => updateEmailField('closing', e.target.value)}
                              placeholder="Best regards,\nThe Bursary Department\n{{universityName}}"
                            />
                          </Field>
                        </div>
                      </div>
                      <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-100">
                        <button
                          type="button"
                          onClick={discardEmailChanges}
                          disabled={!isEmailTemplateDirty || emailTemplateSaving}
                          className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <RotateCcw className="h-4 w-4" />
                          Discard
                        </button>
                        <button
                          type="button"
                          onClick={saveEmailTemplate}
                          disabled={!isEmailTemplateDirty || emailTemplateSaving}
                          className="inline-flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {emailTemplateSaving ? (
                            <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                          ) : (
                            <Send className="h-4 w-4" />
                          )}
                          Save Template
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="text-center py-10 text-sm text-gray-500">Unable to load email template.</div>
                  )}
                </div>

                <div className="border-t border-gray-100 pt-8 space-y-4">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-slate-50 text-slate-700 flex items-center justify-center shrink-0">
                        <FileText className="h-4 w-4" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-gray-900">Recent Email Delivery Logs</h3>
                        <p className="text-xs text-gray-500">Track status of all credential and notification emails.</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={loadDeliveryLogs}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-50 border border-gray-200 rounded-lg transition-colors"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${deliveryLogsLoading ? 'animate-spin' : ''}`} />
                      Reload
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Search Recipient</label>
                      <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                        <input
                          className={`${inputCls} pl-8`}
                          placeholder="email or name"
                          value={deliveryLogsFilterSearch}
                          onChange={(e) => { setDeliveryLogsFilterSearch(e.target.value); setDeliveryLogsPage(1); }}
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Email Type</label>
                      <select
                        className={inputCls}
                        value={deliveryLogsFilterType}
                        onChange={(e) => { setDeliveryLogsFilterType(e.target.value as any); setDeliveryLogsPage(1); }}
                      >
                        <option value="">All types</option>
                        {(['STUDENT_CREDENTIALS','PASSWORD_RESET','PAYMENT_SUCCESSFUL','FEE_ASSIGNED','BILL_CREATED','REFUND_REQUESTED','REFUND_APPROVED','REFUND_REJECTED','OTHER'] as EmailTypeKey[]).map((t) => (
                          <option key={t} value={t}>{emailTypeLabel(t)}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Status</label>
                      <select
                        className={inputCls}
                        value={deliveryLogsFilterStatus}
                        onChange={(e) => { setDeliveryLogsFilterStatus(e.target.value as any); setDeliveryLogsPage(1); }}
                      >
                        <option value="">All statuses</option>
                        <option value="PENDING">Pending</option>
                        <option value="SENT">Sent</option>
                        <option value="RETRIED">Retried</option>
                        <option value="FAILED">Failed</option>
                      </select>
                    </div>
                  </div>

                  <div className="border border-gray-200 rounded-xl overflow-hidden">
                    <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                      <table className="min-w-full divide-y divide-gray-200 text-xs">
                        <thead className="bg-gray-50 sticky top-0 z-10">
                          <tr>
                            <th className="px-3 py-2.5 text-left font-semibold text-gray-700 whitespace-nowrap">Date/Time</th>
                            <th className="px-3 py-2.5 text-left font-semibold text-gray-700 whitespace-nowrap">Type</th>
                            <th className="px-3 py-2.5 text-left font-semibold text-gray-700 whitespace-nowrap">Recipient</th>
                            <th className="px-3 py-2.5 text-left font-semibold text-gray-700 whitespace-nowrap">Provider</th>
                            <th className="px-3 py-2.5 text-left font-semibold text-gray-700 whitespace-nowrap">Status</th>
                            <th className="px-3 py-2.5 text-left font-semibold text-gray-700 whitespace-nowrap text-right">Attempts</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 bg-white">
                          {deliveryLogsLoading ? (
                            <tr><td colSpan={6} className="px-3 py-10 text-center text-gray-500">Loading logs…</td></tr>
                          ) : !deliveryLogs || deliveryLogs.rows.length === 0 ? (
                            <tr><td colSpan={6} className="px-3 py-10 text-center text-gray-500">No delivery records found.</td></tr>
                          ) : deliveryLogs.rows.map((log: EmailDeliveryLogOut) => (
                            <tr
                              key={log.id}
                              className="hover:bg-gray-50/60 cursor-pointer"
                              onClick={() => setSelectedLog(log)}
                            >
                              <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap font-mono text-[11px]">
                                {new Date(log.createdAt).toLocaleString()}
                              </td>
                              <td className="px-3 py-2.5 whitespace-nowrap">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-indigo-50 text-indigo-700 border-indigo-200`}>
                                  {emailTypeLabel(log.emailType)}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-gray-800 whitespace-nowrap min-w-[200px]">
                                <div className="font-medium truncate max-w-[220px]">{log.recipient?.firstName} {log.recipient?.lastName}</div>
                                <div className="text-[11px] text-gray-500 truncate max-w-[220px]">{log.toAddress}</div>
                                {log.recipient?.matricNumber && (
                                  <div className="text-[10px] font-mono text-gray-400 truncate max-w-[220px]">Matric: {log.recipient.matricNumber}</div>
                                )}
                              </td>
                              <td className="px-3 py-2.5 whitespace-nowrap">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                                  log.provider === 'RESEND' ? 'bg-purple-50 text-purple-700 border-purple-200'
                                  : log.provider === 'SMTP' ? 'bg-blue-50 text-blue-700 border-blue-200'
                                  : 'bg-gray-50 text-gray-600 border-gray-200'
                                }`}>
                                  {log.provider}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 whitespace-nowrap">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusBadge(log.status)}`}>
                                  {log.status}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 whitespace-nowrap text-right font-mono text-[11px] text-gray-700">
                                {log.attempts}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {deliveryLogs && deliveryLogs.total > 0 && (
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-t border-gray-100 bg-gray-50/50 text-xs text-gray-600">
                        <div>
                          Showing {deliveryLogs.pageSize * (deliveryLogs.page - 1) + (deliveryLogs.rows.length ? 1 : 0)}–
                          {deliveryLogs.pageSize * (deliveryLogs.page - 1) + deliveryLogs.rows.length} of {deliveryLogs.total}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setDeliveryLogsPage(deliveryLogs.page - 1)}
                            disabled={deliveryLogs.page <= 1}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-gray-300 bg-white rounded-md font-medium disabled:opacity-40"
                          >
                            <ChevronLeft className="w-3.5 h-3.5" /> Prev
                          </button>
                          <span className="font-medium text-gray-900 min-w-[4rem] text-center">
                            Page {deliveryLogs.page} of {deliveryLogs.totalPages}
                          </span>
                          <button
                            onClick={() => setDeliveryLogsPage(deliveryLogs.page + 1)}
                            disabled={!deliveryLogs.hasNext}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-gray-300 bg-white rounded-md font-medium disabled:opacity-40"
                          >
                            Next <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
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

      <Modal
        isOpen={selectedLog !== null}
        size="lg"
        onClose={() => setSelectedLog(null)}
        title="Email Delivery Details"
        footer={
          <div className="flex w-full justify-end">
            <button
              onClick={() => setSelectedLog(null)}
              className="px-5 py-2 bg-gray-700 hover:bg-gray-800 text-white rounded-lg font-bold"
            >
              Close
            </button>
          </div>
        }
      >
        {selectedLog && (
          <div className="space-y-5 py-2 text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">Log ID</div>
                <div className="font-mono text-xs break-all mt-0.5 text-gray-800">{selectedLog.id}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">Created At</div>
                <div className="text-gray-800 mt-0.5">{new Date(selectedLog.createdAt).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">Email Type</div>
                <div className="mt-1"><span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border bg-indigo-50 text-indigo-700 border-indigo-200`}>{emailTypeLabel(selectedLog.emailType)}</span></div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">Provider</div>
                <div className="mt-1"><span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                  selectedLog.provider === 'RESEND' ? 'bg-purple-50 text-purple-700 border-purple-200'
                  : selectedLog.provider === 'SMTP' ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-gray-50 text-gray-600 border-gray-200'
                }`}>{selectedLog.provider}</span></div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">Status</div>
                <div className="mt-1"><span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${statusBadge(selectedLog.status)}`}>{selectedLog.status}</span></div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">Attempts</div>
                <div className="text-gray-800 mt-0.5 font-mono">{selectedLog.attempts} / 3</div>
              </div>
              <div className="sm:col-span-2">
                <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">To Address</div>
                <div className="text-gray-800 mt-0.5 break-all">{selectedLog.toAddress}</div>
              </div>
              {selectedLog.recipient && (
                <div className="sm:col-span-2 rounded-lg bg-gray-50 p-3 border border-gray-100">
                  <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500 mb-1">Recipient (Student)</div>
                  <div className="text-sm">
                    <div className="font-medium text-gray-900">{selectedLog.recipient.firstName} {selectedLog.recipient.lastName}</div>
                    <div className="text-gray-600 text-xs mt-0.5">ID #{selectedLog.recipient.id} · {selectedLog.recipient.email || '—'}</div>
                    {selectedLog.recipient.matricNumber && <div className="font-mono text-xs text-gray-500 mt-0.5">Matric: {selectedLog.recipient.matricNumber}</div>}
                  </div>
                </div>
              )}
              {selectedLog.triggeredByAdmin && (
                <div className="sm:col-span-2 rounded-lg bg-amber-50 p-3 border border-amber-100">
                  <div className="text-[11px] uppercase tracking-wide font-semibold text-amber-700 mb-1">Triggered By Admin</div>
                  <div className="text-sm">
                    <div className="font-medium text-gray-900">{selectedLog.triggeredByAdmin.firstName} {selectedLog.triggeredByAdmin.lastName}</div>
                    <div className="text-gray-600 text-xs mt-0.5">{selectedLog.triggeredByAdmin.email} · {selectedLog.triggeredByAdmin.role}</div>
                  </div>
                </div>
              )}
              {selectedLog.studentImport && (
                <div className="sm:col-span-2 rounded-lg bg-blue-50 p-3 border border-blue-100">
                  <div className="text-[11px] uppercase tracking-wide font-semibold text-blue-700 mb-1">Bulk Import Batch</div>
                  <div className="text-sm">
                    <div className="font-medium text-gray-900">{selectedLog.studentImport.fileName}</div>
                    <div className="text-gray-600 text-xs mt-0.5">
                      Batch #{selectedLog.studentImport.id} · ImportNo: {selectedLog.studentImport.importNumber} ·
                      Uploaded {new Date(selectedLog.studentImport.createdAt).toLocaleString()}
                    </div>
                    {(selectedLog.studentImport.successfulRecords !== undefined || selectedLog.studentImport.totalRecords !== undefined) && (
                      <div className="text-xs text-gray-500 mt-1">
                        {selectedLog.studentImport.successfulRecords} of {selectedLog.studentImport.totalRecords} successful
                      </div>
                    )}
                  </div>
                </div>
              )}
              {selectedLog.resendMessageId && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">Resend Message ID</div>
                  <div className="font-mono text-xs break-all mt-0.5 text-gray-800">{selectedLog.resendMessageId}</div>
                </div>
              )}
              {selectedLog.smtpMessageId && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">SMTP Message ID</div>
                  <div className="font-mono text-xs break-all mt-0.5 text-gray-800">{selectedLog.smtpMessageId}</div>
                </div>
              )}
              {selectedLog.retryAfter && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">Retry After</div>
                  <div className="text-gray-800 mt-0.5">{new Date(selectedLog.retryAfter).toLocaleString()}</div>
                </div>
              )}
            </div>

            {selectedLog.lastError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-1.5">
                <div className="text-[11px] uppercase tracking-wide font-bold text-red-700">Last Delivery Error</div>
                <pre className="whitespace-pre-wrap break-words text-xs text-red-900 leading-relaxed max-h-[300px] overflow-y-auto font-mono">{selectedLog.lastError}</pre>
              </div>
            ) : selectedLog.status === 'FAILED' ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                <div className="text-xs text-red-700">Marked FAILED with no error detail captured.</div>
              </div>
            ) : null}

            {selectedLog.payloadSummary && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-1.5">
                <div className="text-[11px] uppercase tracking-wide font-bold text-gray-600">Payload Summary (PII-Scrubbed)</div>
                <pre className="whitespace-pre-wrap break-words text-xs text-gray-800 leading-relaxed max-h-[220px] overflow-y-auto font-mono">
                  {typeof selectedLog.payloadSummary === 'string'
                    ? selectedLog.payloadSummary
                    : JSON.stringify(selectedLog.payloadSummary, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </Modal>
    </PortalShell>
  );
};

export default SystemSettingsPage;
