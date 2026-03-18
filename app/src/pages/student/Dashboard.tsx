import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { Wallet, ArrowDownCircle, History, Download, CreditCard, ShieldCheck, BookOpen, Building2, GraduationCap } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import Modal from '../../components/Modal';

interface Transaction {
  id: number;
  reference: string;
  amount: number;
  type: string;
  status: string;
  createdAt: string;
}

interface FeesBreakdown {
  amount: number;
  serviceCharge: number;
  paystackFee: number;
  total: number;
}

const StudentDashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const [balance, setBalance] = useState(0);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [depositAmount, setDepositAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  
  // Modal State
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [feesBreakdown, setFeesBreakdown] = useState<FeesBreakdown | null>(null);
  
  // Alert Modal State
  const [alertModal, setAlertModal] = useState({ isOpen: false, title: '', message: '', type: 'error' as 'error' | 'success' });

  // Pagination and Filtering State
  const [currentPage, setCurrentPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const itemsPerPage = 10;

  const showAlert = (title: string, message: string, type: 'error' | 'success' = 'error') => {
    setAlertModal({ isOpen: true, title, message, type });
  };

  useEffect(() => {
    // Check if returning from Paystack
    const reference = searchParams.get('reference');
    if (reference) {
      verifyTransaction(reference);
    }

    fetchBalance();
    fetchTransactions();
  }, []);

  const verifyTransaction = async (reference: string) => {
    try {
      await api.get(`/wallet/verify/${reference}`);
      showAlert('Deposit Successful', 'Your wallet has been credited successfully.', 'success');
      // Clear URL params
      setSearchParams({});
      fetchBalance();
      fetchTransactions();
    } catch (error) {
      console.error('Verification failed', error);
      // showAlert('Verification Failed', 'Payment verification failed or was already processed.');
    }
  };

  const fetchBalance = async () => {
    try {
      const res = await api.get('/wallet/balance');
      setBalance(res.data.data.balance);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchTransactions = async () => {
    try {
      const res = await api.get('/wallet/transactions'); 
      setTransactions(res.data.data.transactions);
    } catch (err) {
      console.error(err);
    }
  };

  const initiateDepositCalculation = () => {
    const amount = Number(depositAmount);
    
    // Paystack max limit per transaction is generally around 5,000,000 NGN depending on merchant KYC level
    // Setting practical bounds as requested
    if (!amount || amount < 20000) {
      showAlert('Invalid Amount', 'Minimum deposit amount is ₦20,000');
      return;
    }
    
    if (amount > 5000000) {
      showAlert('Invalid Amount', 'Maximum deposit amount per transaction is ₦5,000,000');
      return;
    }
    
    const serviceCharge = 2000;
    const paystackFee = 2000; // Fixed at 2000 as requested
    const total = amount + serviceCharge + paystackFee;

    setFeesBreakdown({
      amount,
      serviceCharge,
      paystackFee,
      total
    });
    setShowPaymentModal(true);
  };

  const processPayment = async () => {
    if (!feesBreakdown) return;
    
    setLoading(true);
    try {
      const res = await api.post('/wallet/deposit', { amount: feesBreakdown.amount, email: user?.email });
      window.location.href = res.data.data.authorization_url;
    } catch (err: any) {
      console.error(err);
      setShowPaymentModal(false);
      showAlert('Deposit Failed', err.response?.data?.message || 'Deposit failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const downloadStatement = async () => {
    try {
      const response = await api.get(`/wallet/statement`, {
        responseType: 'blob', // Important: Treat response as binary data
        headers: {
          'Accept': 'application/pdf'
        }
      });
      
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `Account_Statement_${user?.matricNumber || 'User'}.pdf`);
      document.body.appendChild(link);
      link.click();
      
      window.URL.revokeObjectURL(url);
      link.remove();
    } catch (error) {
      console.error('Failed to download statement', error);
      showAlert('Statement Error', 'Failed to generate your account statement. Please try again later.');
    }
  };

  const downloadReceipt = async (reference: string) => {
    try {
      const response = await api.get(`/wallet/receipt/${reference}`, {
        responseType: 'blob', // Important: Treat response as binary data
        headers: {
          'Accept': 'application/pdf'
        }
      });
      
      // Create blob with explicit PDF type
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `receipt_${reference}.pdf`);
      document.body.appendChild(link);
      link.click();
      
      // Clean up
      window.URL.revokeObjectURL(url);
      link.remove();
    } catch (error) {
      console.error('Failed to download receipt', error);
      showAlert('Receipt Error', 'Failed to download receipt. It may only be available for successful transactions.');
    }
  };

  // Derived state for filtered and paginated transactions
  const filteredTransactions = transactions.filter(txn => 
    statusFilter === 'ALL' ? true : txn.status === statusFilter
  );
  
  const totalPages = Math.ceil(filteredTransactions.length / itemsPerPage);
  const currentTransactions = filteredTransactions.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navbar */}
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <span className="text-xl font-bold text-blue-600">UniWallet</span>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-gray-700 font-medium">Hello, {user?.firstName}</span>
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
        {/* Student Profile Section */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-8 flex flex-col md:flex-row items-center md:items-start gap-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 -mt-4 -mr-4 w-32 h-32 bg-blue-50 rounded-full blur-2xl opacity-60"></div>
          <div className="h-24 w-24 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 text-3xl font-bold shrink-0 border-4 border-white shadow-md z-10">
            {user?.firstName?.[0]}{user?.lastName?.[0]}
          </div>
          <div className="flex-1 text-center md:text-left z-10 w-full">
            <h1 className="text-2xl font-bold text-gray-900">{user?.firstName} {user?.lastName}</h1>
            <p className="text-gray-500 font-medium mb-4">{user?.matricNumber || 'N/A'}</p>
            
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full">
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg border border-gray-100">
                <BookOpen className="h-4 w-4 text-blue-500 shrink-0" />
                <span className="truncate font-medium" title={user?.college || 'N/A'}>{user?.college || 'N/A'}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg border border-gray-100">
                <Building2 className="h-4 w-4 text-blue-500 shrink-0" />
                <span className="truncate font-medium" title={user?.department || 'N/A'}>{user?.department || 'N/A'}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg border border-gray-100">
                <GraduationCap className="h-4 w-4 text-blue-500 shrink-0" />
                <span className="truncate font-medium" title={user?.program || 'N/A'}>{user?.program || 'N/A'}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Wallet Card */}
          <div className="lg:col-span-1">
            <div className="bg-blue-600 rounded-2xl p-6 text-white shadow-lg relative overflow-hidden">
              <div className="absolute top-0 right-0 -mt-4 -mr-4 w-24 h-24 bg-white opacity-10 rounded-full blur-xl"></div>
              <div className="relative z-10">
                <div className="flex items-center space-x-2 mb-4 opacity-90">
                  <Wallet className="h-5 w-5" />
                  <span className="text-sm font-medium uppercase tracking-wider">Total Balance</span>
                </div>
                <h2 className="text-4xl font-bold mb-6">₦{Number(balance).toLocaleString()}</h2>
                
                <div className="bg-white/10 rounded-xl p-4 backdrop-blur-sm">
                  <label className="block text-xs text-blue-100 mb-2">Quick Deposit (Min: ₦20,000 | Max: ₦5,000,000)</label>
                  <div className="flex gap-2">
                    <input 
                      type="number" 
                      placeholder="Amount" 
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      className="w-full bg-white/20 border border-white/30 rounded-lg px-3 py-2 text-white placeholder-blue-200 focus:outline-none focus:ring-2 focus:ring-white/50"
                    />
                    <button 
                      onClick={initiateDepositCalculation}
                      disabled={loading}
                      className="bg-white text-blue-600 px-4 py-2 rounded-lg font-semibold hover:bg-blue-50 transition-colors disabled:opacity-75"
                    >
                      {loading ? '...' : <ArrowDownCircle className="h-5 w-5" />}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="grid grid-cols-1 gap-4 mt-6">
              <button 
                onClick={downloadStatement}
                className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow flex flex-col items-center justify-center text-gray-700"
              >
                <Download className="h-6 w-6 text-green-500 mb-2" />
                <span className="text-sm font-medium">Download Statement</span>
              </button>
            </div>
          </div>

          {/* Transactions */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 h-full flex flex-col">
              <div className="p-6 border-b border-gray-100 flex justify-between items-center flex-wrap gap-4">
                <h3 className="text-lg font-bold text-gray-900 flex items-center">
                  <History className="h-5 w-5 mr-2 text-gray-500" />
                  Transaction History
                </h3>
                
                {/* Status Filter */}
                <div className="flex bg-gray-100 p-1 rounded-lg">
                  {['ALL', 'SUCCESS', 'PENDING', 'FAILED'].map((status) => (
                    <button
                      key={status}
                      onClick={() => {
                        setStatusFilter(status);
                        setCurrentPage(1); // Reset to first page on filter
                      }}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                        statusFilter === status 
                          ? 'bg-white text-gray-900 shadow-sm' 
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {status}
                    </button>
                  ))}
                </div>
              </div>
              
              <div className="overflow-x-auto flex-1">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Reference</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                      <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                      <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {currentTransactions.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-6 py-16 text-center text-gray-500">
                          <div className="flex flex-col items-center">
                            <History className="h-10 w-10 text-gray-300 mb-3" />
                            <p className="text-base font-medium text-gray-900">No transactions found</p>
                            <p className="text-sm text-gray-500">Try changing your filters or make a deposit.</p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      currentTransactions.map((txn) => (
                        <tr key={txn.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                            {new Date(txn.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-500">
                            {txn.reference}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm">
                            <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 text-blue-800">
                              {txn.type}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium text-gray-900">
                            ₦{Number(txn.amount).toLocaleString()}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-center text-sm">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              txn.status === 'SUCCESS' ? 'bg-green-100 text-green-800' : 
                              txn.status === 'FAILED' ? 'bg-red-100 text-red-800' : 
                              'bg-yellow-100 text-yellow-800'
                            }`}>
                              {txn.status}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-center text-sm">
                            {txn.status === 'SUCCESS' && (
                              <button 
                                onClick={() => downloadReceipt(txn.reference)}
                                className="text-blue-600 hover:text-blue-900 font-medium underline decoration-blue-300 underline-offset-2"
                              >
                                Receipt
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination Controls */}
              {totalPages > 1 && (
                <div className="p-4 border-t border-gray-100 bg-gray-50 flex items-center justify-between rounded-b-xl">
                  <span className="text-sm text-gray-500">
                    Showing <span className="font-medium">{(currentPage - 1) * itemsPerPage + 1}</span> to <span className="font-medium">{Math.min(currentPage * itemsPerPage, filteredTransactions.length)}</span> of <span className="font-medium">{filteredTransactions.length}</span> results
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
            </div>
          </div>

        </div>
      </main>

      {/* Payment Confirmation Modal */}
      <Modal
        isOpen={showPaymentModal}
        onClose={() => setShowPaymentModal(false)}
        title="Payment Breakdown"
        footer={
          <>
            <button 
              onClick={() => setShowPaymentModal(false)}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium"
            >
              Cancel
            </button>
            <button 
              onClick={processPayment}
              disabled={loading}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-bold shadow-md shadow-blue-200 transition-all flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? 'Processing...' : (
                <>
                  <ShieldCheck className="h-4 w-4" />
                  Proceed to Pay
                </>
              )}
            </button>
          </>
        }
      >
        {feesBreakdown && (
          <div className="space-y-4">
            <div className="bg-blue-50 p-4 rounded-lg border border-blue-100">
              <div className="flex justify-between items-center mb-2">
                <span className="text-gray-600 text-sm">Deposit Amount</span>
                <span className="font-bold text-gray-900">₦{feesBreakdown.amount.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center mb-2">
                <span className="text-gray-600 text-sm">Service Charge</span>
                <span className="font-medium text-gray-900">₦{feesBreakdown.serviceCharge.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600 text-sm">Gateway Fee</span>
                <span className="font-medium text-gray-900">₦{feesBreakdown.paystackFee.toLocaleString()}</span>
              </div>
            </div>
            
            <div className="flex justify-between items-center pt-2 border-t border-gray-100">
              <span className="text-lg font-bold text-gray-900">Total Payable</span>
              <span className="text-2xl font-extrabold text-blue-600">₦{feesBreakdown.total.toLocaleString()}</span>
            </div>
            
            <div className="flex items-center gap-2 text-xs text-gray-500 bg-gray-50 p-3 rounded">
              <CreditCard className="h-4 w-4" />
              <span>Secured by Paystack. You will be redirected to complete payment.</span>
            </div>
          </div>
        )}
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

export default StudentDashboard;
