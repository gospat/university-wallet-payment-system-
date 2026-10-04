import React, { useEffect, useState } from 'react';
import { Save, RotateCcw, Settings, CreditCard, Shield } from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import ConfirmAction from '../../components/ConfirmAction';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/AuthContext';
import { paymentConfigApi, PaymentConfigOut, GatewayStatus } from '../../services/adminApi';
import { navCounters, NavCounters } from '../../services/api';
import { useLocation } from 'react-router-dom';
import { i18n } from '../../i18n/en';

type AlertState = { isOpen: boolean; title: string; message: string; type: 'error' | 'success' };

const GATEWAY_DESCRIPTIONS: Record<string, string> = {
  PAYSTACK: 'Industry-leading African payments processor; wide coverage NG banks, cards, USSD',
  ALATPAY: "WEMA Bank's ALAT Pay; direct bank integration with transparent settlement; supports Sandbox via apibox.alatpay.ng",
};

const PaymentConfigPage: React.FC = () => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [navCounts, setNavCounts] = useState<NavCounters>({});

  const [config, setConfig] = useState<PaymentConfigOut | null>(null);
  const [originalGateway, setOriginalGateway] = useState<'PAYSTACK' | 'ALATPAY' | null>(null);
  const [selectedGateway, setSelectedGateway] = useState<'PAYSTACK' | 'ALATPAY' | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'error' });
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    navCounters().then(setNavCounts).catch(() => {});
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    loadConfig();
    return () => ctrl.abort();
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const data = await paymentConfigApi.get();
      setConfig(data);
      setOriginalGateway(data.activeGateway);
      setSelectedGateway(data.activeGateway);
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setAlert({ isOpen: true, title: 'Failed to load', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const isChanged = originalGateway !== null && selectedGateway !== null && originalGateway !== selectedGateway;

  const handleCancel = async () => {
    await loadConfig();
  };

  const handleSaveClick = () => {
    if (!isChanged) return;
    setShowConfirm(true);
  };

  const handleConfirmSave = async () => {
    if (!selectedGateway) return;
    setSaving(true);
    try {
      const updated = await paymentConfigApi.save(selectedGateway);
      setConfig(updated);
      setOriginalGateway(updated.activeGateway);
      setSelectedGateway(updated.activeGateway);
      setShowConfirm(false);
      setAlert({ isOpen: true, title: 'Success', message: `Active payment gateway updated to ${selectedGateway}. New student payments will route through this gateway.`, type: 'success' });
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setShowConfirm(false);
      setAlert({ isOpen: true, title: 'Save failed', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const gateways: GatewayStatus[] = config?.supportedGateways ?? [
    { key: 'PAYSTACK', label: 'Paystack', status: selectedGateway === 'PAYSTACK' ? 'ACTIVE' : 'INACTIVE' },
    { key: 'ALATPAY', label: 'ALAT Pay', status: selectedGateway === 'ALATPAY' ? 'ACTIVE' : 'INACTIVE' },
  ];

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
              <h1 className="text-2xl font-bold text-gray-900">Payment Configuration</h1>
              <p className="text-sm text-gray-500">Select active payment gateway for processing student payments</p>
            </div>
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16">
            <svg className="animate-spin h-8 w-8 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}

        {!loading && (
          <div className="w-full max-w-6xl">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              {gateways.map((gw) => {
                const isActive = selectedGateway === gw.key;
                const isSelected = selectedGateway === gw.key;
                return (
                  <div
                    key={gw.key}
                    onClick={() => setSelectedGateway(gw.key)}
                    className={`cursor-pointer rounded-xl border transition-all duration-200 overflow-hidden ${
                      isSelected
                        ? 'ring-2 ring-blue-500 bg-blue-50/30 shadow-md border-blue-200'
                        : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
                    }`}
                  >
                    <div className="p-6">
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className={`p-2.5 rounded-lg ${
                            gw.key === 'PAYSTACK' ? 'bg-blue-50' : 'bg-emerald-50'
                          }`}>
                            <CreditCard className={`h-5 w-5 ${
                              gw.key === 'PAYSTACK' ? 'text-blue-700' : 'text-emerald-700'
                            }`} />
                          </div>
                          <div>
                            <h3 className="text-lg font-bold text-gray-900">{gw.label}</h3>
                            <p className="text-xs font-mono text-gray-500 uppercase tracking-wide">{gw.key}</p>
                          </div>
                        </div>
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium border ${
                          isActive
                            ? 'bg-green-50 text-green-700 border-green-200'
                            : 'bg-gray-100 text-gray-700 border-gray-200'
                        }`}>
                          {isActive ? 'Active' : 'Inactive'}
                        </span>
                      </div>

                      <div className="flex items-start gap-3 mb-4">
                        <input
                          type="radio"
                          name="gateway"
                          checked={isSelected}
                          onChange={() => setSelectedGateway(gw.key)}
                          className="mt-0.5 h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                        />
                        <p className="text-sm text-gray-600 leading-relaxed flex-1">
                          {GATEWAY_DESCRIPTIONS[gw.key] ?? gw.label}
                        </p>
                      </div>

                      {isActive && (
                        <div className="flex items-center gap-2 px-3 py-2 bg-green-50/50 rounded-lg border border-green-200/60">
                          <Shield className="h-4 w-4 text-green-600 shrink-0" />
                          <span className="text-xs font-medium text-green-700">Currently routing live payments</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="border border-gray-200 bg-gray-50 rounded-lg p-4 flex items-start gap-3">
              <Shield className="h-5 w-5 text-gray-500 shrink-0 mt-0.5" />
              <div className="text-sm text-gray-600">
                <span className="font-medium text-gray-700">Security note:</span>{' '}
                Gateway public keys live in environment variables only; never displayed or editable here for security.
              </div>
            </div>

            {(isChanged || originalGateway !== null) && (
              <div className="fixed bottom-6 right-6 z-30 bg-white border border-gray-200 rounded-xl shadow-lg p-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={saving}
                  className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RotateCcw className="h-4 w-4" />
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveClick}
                  disabled={saving || !isChanged}
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
        )}
      </div>

      <ConfirmAction
        isOpen={showConfirm}
        onClose={() => !saving && setShowConfirm(false)}
        onConfirm={handleConfirmSave}
        title={`Switch payment gateway to ${selectedGateway}?`}
        description={`Confirm switch active payment gateway to ${selectedGateway}? This will immediately route ALL new student payments to ${selectedGateway}. Existing Paystack/ALATPAY transactions are unaffected.`}
        resourceLabel={`Payment Gateway → ${selectedGateway}`}
        confirmLabel={`Switch to ${selectedGateway}`}
        confirmVariant="primary"
        cancelLabel="Keep Current Gateway"
        loading={saving}
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

export default PaymentConfigPage;
