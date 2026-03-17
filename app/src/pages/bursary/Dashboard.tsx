import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { CheckCircle, XCircle } from 'lucide-react';
import api from '../../services/api';

const BursaryDashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

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

  const handleAction = async (id: number, action: 'approve' | 'reject') => {
    if (!window.confirm(`Are you sure you want to ${action} this withdrawal?`)) return;
    
    setLoading(true);
    try {
      await api.post(`/bursary/withdrawals/${id}/${action}`);
      alert(`Withdrawal ${action}d successfully`);
      fetchWithdrawals();
    } catch (error: any) {
      alert(error.response?.data?.message || `Failed to ${action} withdrawal`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navbar */}
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <span className="text-xl font-bold text-gray-900">Bursary Portal</span>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-gray-700 font-medium">{user?.firstName}</span>
              <button 
                onClick={logout}
                className="text-sm text-red-600 hover:text-red-800 font-medium"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Withdrawal Requests</h1>
          <p className="text-gray-500">Manage and approve student withdrawal requests.</p>
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
              {withdrawals.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                    No pending withdrawal requests.
                  </td>
                </tr>
              ) : (
                withdrawals.map((req) => {
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
                            onClick={() => handleAction(req.id, 'approve')}
                            disabled={loading}
                            className="text-green-600 hover:text-green-900 bg-green-50 p-2 rounded-full disabled:opacity-50"
                            title="Approve & Debit Wallet"
                          >
                            <CheckCircle className="h-5 w-5" />
                          </button>
                          <button 
                            onClick={() => handleAction(req.id, 'reject')}
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
      </main>
    </div>
  );
};

export default BursaryDashboard;
