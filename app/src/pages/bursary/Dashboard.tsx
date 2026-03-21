import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { CheckCircle, XCircle, ShieldCheck, Mail, History } from 'lucide-react';
import api from '../../services/api';
import Modal from '../../components/Modal';
import PortalNavbar from '../../components/PortalNavbar';

const BursaryDashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Alert Modal State
  const [alertModal, setAlertModal] = useState({ isOpen: false, title: '', message: '', type: 'error' as 'error' | 'success' });
  
  // Confirm Modal State
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean; id: number | null; action: 'approve' | 'reject' | null }>({
    isOpen: false,
    id: null,
    action: null
  });

  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  const showAlert = (title: string, message: string, type: 'error' | 'success' = 'error') => {
    setAlertModal({ isOpen: true, title, message, type });
  };

  useEffect(() => {
    fetchWithdrawals();
  }, []);

  const fetchWithdrawals = async () => {
    try {
      const res = await api.get('/bursary/withdrawals');
      setWithdrawals(res.data.data.withdrawals);
    } catch (error) {
      console.error('Failed to fetch withdrawals', error);
    }
  };

  const confirmAction = (id: number, action: 'approve' | 'reject') => {
    setConfirmModal({ isOpen: true, id, action });
  };

  const handleAction = async () => {
    const { id, action } = confirmModal;
    if (!id || !action) return;
    
    setLoading(true);
    try {
      await api.post(`/bursary/withdrawals/${id}/${action}`);
      setConfirmModal({ isOpen: false, id: null, action: null });
      showAlert('Success', `Withdrawal ${action}d successfully`, 'success');
      fetchWithdrawals();
    } catch (error: any) {
      setConfirmModal({ isOpen: false, id: null, action: null });
      showAlert('Error', error.response?.data?.message || `Failed to ${action} withdrawal`);
    } finally {
      setLoading(false);
    }
  };

  const totalPages = Math.ceil(withdrawals.length / itemsPerPage);
  const currentWithdrawals = withdrawals.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navbar */}
      <PortalNavbar brand="Bursary Portal" userText={user?.firstName || ''} onLogout={logout} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        
        {/* Bursary Profile Section */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-8 flex flex-col md:flex-row items-center md:items-start gap-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 -mt-4 -mr-4 w-32 h-32 bg-green-50 rounded-full blur-2xl opacity-60"></div>
          <div className="h-24 w-24 bg-green-100 rounded-full flex items-center justify-center text-green-600 text-3xl font-bold shrink-0 border-4 border-white shadow-md z-10">
            {user?.firstName?.[0]}{user?.lastName?.[0]}
          </div>
          <div className="flex-1 text-center md:text-left z-10 w-full">
            <h1 className="text-2xl font-bold text-gray-900">{user?.firstName} {user?.lastName}</h1>
            <p className="text-gray-500 font-medium mb-4">Financial Controller</p>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full md:w-2/3">
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg border border-gray-100">
                <ShieldCheck className="h-4 w-4 text-green-500 shrink-0" />
                <span className="truncate font-medium">Bursary Dept</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg border border-gray-100">
                <Mail className="h-4 w-4 text-green-500 shrink-0" />
                <span className="truncate font-medium">{user?.email || 'finance@university.edu.ng'}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mb-6 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <History className="h-5 w-5 text-gray-500" />
              Withdrawal Requests
            </h2>
            <p className="text-gray-500 text-sm mt-1">Manage and approve student withdrawal requests.</p>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Student</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Bank Details</th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {currentWithdrawals.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                    <div className="flex flex-col items-center">
                      <History className="h-10 w-10 text-gray-300 mb-3" />
                      <p className="text-base font-medium text-gray-900">No pending withdrawal requests</p>
                    </div>
                  </td>
                </tr>
              ) : (
                currentWithdrawals.map((req) => {
                  const metadata = req.metadata || {};
                  return (
                    <tr key={req.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {new Date(req.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{req.user.firstName} {req.user.lastName}</div>
                        <div className="text-xs text-gray-500">{req.user.matricNumber}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">
                        ₦{Number(req.amount).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        <div>{metadata.bank || 'N/A'}</div>
                        <div className="text-xs text-gray-500">{metadata.account || 'N/A'}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center text-sm font-medium">
                        <div className="flex justify-center space-x-2">
                          <button 
                            onClick={() => confirmAction(req.id, 'approve')}
                            disabled={loading}
                            className="text-green-600 hover:text-green-900 bg-green-50 p-2 rounded-full disabled:opacity-50"
                            title="Approve & Debit Wallet"
                          >
                            <CheckCircle className="h-5 w-5" />
                          </button>
                          <button 
                            onClick={() => confirmAction(req.id, 'reject')}
                            disabled={loading}
                            className="text-red-600 hover:text-red-900 bg-red-50 p-2 rounded-full disabled:opacity-50"
                            title="Reject Request"
                          >
                            <XCircle className="h-5 w-5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        {totalPages > 1 && (
          <div className="p-4 mt-4 border border-gray-100 bg-white shadow-sm flex items-center justify-between rounded-xl">
            <span className="text-sm text-gray-500">
              Showing <span className="font-medium">{(currentPage - 1) * itemsPerPage + 1}</span> to <span className="font-medium">{Math.min(currentPage * itemsPerPage, withdrawals.length)}</span> of <span className="font-medium">{withdrawals.length}</span> requests
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                disabled={currentPage === 1}
                className="px-3 py-1 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                disabled={currentPage === totalPages}
                className="px-3 py-1 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Confirmation Modal */}
      <Modal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal({ isOpen: false, id: null, action: null })}
        title={confirmModal.action === 'approve' ? 'Approve Withdrawal' : 'Reject Withdrawal'}
        footer={
          <>
            <button 
              onClick={() => setConfirmModal({ isOpen: false, id: null, action: null })}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium"
            >
              Cancel
            </button>
            <button 
              onClick={handleAction}
              disabled={loading}
              className={`px-6 py-2 rounded-lg font-bold text-white shadow-md transition-all flex items-center gap-2 disabled:opacity-50 ${
                confirmModal.action === 'approve' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {loading ? 'Processing...' : 'Confirm'}
            </button>
          </>
        }
      >
        <div className="py-4">
          <p className="text-gray-700">
            Are you sure you want to <strong>{confirmModal.action}</strong> this withdrawal request?
            {confirmModal.action === 'approve' && ' The student\'s wallet will be permanently debited.'}
          </p>
        </div>
      </Modal>

      {/* General Alert Modal */}
      <Modal
        isOpen={alertModal.isOpen}
        onClose={() => setAlertModal({ ...alertModal, isOpen: false })}
        title={alertModal.title}
        footer={
          <button 
            onClick={() => setAlertModal({ ...alertModal, isOpen: false })}
            className={`px-6 py-2 rounded-lg font-bold text-white shadow-md transition-all ${
              alertModal.type === 'success' ? 'bg-green-600 hover:bg-green-700 shadow-green-200' : 'bg-red-600 hover:bg-red-700 shadow-red-200'
            }`}
          >
            Acknowledge
          </button>
        }
      >
        <div className="py-4">
          <p className="text-gray-700 text-lg">{alertModal.message}</p>
        </div>
      </Modal>

    </div>
  );
};

export default BursaryDashboard;
