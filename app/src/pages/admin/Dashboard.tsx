import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Users, DollarSign, Activity, FileText, Shield, Mail } from 'lucide-react';
import api from '../../services/api';
import Modal from '../../components/Modal';
import PortalNavbar from '../../components/PortalNavbar';

const AdminDashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const [stats, setStats] = useState<any>(null);

  // Modals state
  const [showAddStudentModal, setShowAddStudentModal] = useState(false);
  const [alertModal, setAlertModal] = useState({ isOpen: false, title: '', message: '', type: 'error' as 'error' | 'success' });
  const [studentForm, setStudentForm] = useState({ email: '', firstName: '', lastName: '', matricNumber: '', password: 'student123', college: '', department: '', program: '' });
  const [loading, setLoading] = useState(false);

  const showAlert = (title: string, message: string, type: 'error' | 'success' = 'error') => {
    setAlertModal({ isOpen: true, title, message, type });
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const res = await api.get('/admin/stats');
      setStats(res.data.data);
    } catch (error) {
      console.error('Failed to fetch stats', error);
    }
  };

  const handleAddStudent = async () => {
    const { email, firstName, lastName, matricNumber, password, college, department, program } = studentForm;

    if (!email || !firstName || !lastName || !matricNumber) {
      showAlert('Validation Error', 'All fields are required.');
      return;
    }

    setLoading(true);
    try {
      await api.post('/admin/students', { email, firstName, lastName, matricNumber, password, college, department, program });
      setShowAddStudentModal(false);
      setStudentForm({ email: '', firstName: '', lastName: '', matricNumber: '', password: 'student123', college: '', department: '', program: '' });
      showAlert('Success', 'Student added successfully!', 'success');
      fetchStats(); // Refresh stats to update total student count
    } catch (err: any) {
      showAlert('Error', err.response?.data?.message || 'Failed to add student');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navbar */}
      <PortalNavbar brand="Admin Portal" userText={`Admin: ${user?.firstName || ''}`} onLogout={logout} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        
        {/* Admin Profile Section */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-8 flex flex-col md:flex-row items-center md:items-start gap-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 -mt-4 -mr-4 w-32 h-32 bg-gray-100 rounded-full blur-2xl opacity-60"></div>
          <div className="h-24 w-24 bg-gray-800 rounded-full flex items-center justify-center text-white text-3xl font-bold shrink-0 border-4 border-white shadow-md z-10">
            {user?.firstName?.[0]}{user?.lastName?.[0]}
          </div>
          <div className="flex-1 text-center md:text-left z-10 w-full">
            <h1 className="text-2xl font-bold text-gray-900">{user?.firstName} {user?.lastName}</h1>
            <p className="text-gray-500 font-medium mb-4">System Administrator</p>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full md:w-2/3">
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg border border-gray-100">
                <Shield className="h-4 w-4 text-gray-500 shrink-0" />
                <span className="truncate font-medium">Full Access</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg border border-gray-100">
                <Mail className="h-4 w-4 text-gray-500 shrink-0" />
                <span className="truncate font-medium">{user?.email || 'admin@university.edu.ng'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">Total Students</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{stats?.stats?.totalStudents || 0}</p>
              </div>
              <div className="p-3 bg-blue-50 rounded-lg">
                <Users className="h-6 w-6 text-blue-600" />
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">Total Deposits</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">₦{Number(stats?.stats?.totalDeposits || 0).toLocaleString()}</p>
              </div>
              <div className="p-3 bg-green-50 rounded-lg">
                <DollarSign className="h-6 w-6 text-green-600" />
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">Active Wallets</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{stats?.stats?.activeWallets || 0}</p>
              </div>
              <div className="p-3 bg-purple-50 rounded-lg">
                <Activity className="h-6 w-6 text-purple-600" />
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">Pending Requests</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{stats?.stats?.pendingRequests || 0}</p>
              </div>
              <div className="p-3 bg-orange-50 rounded-lg">
                <FileText className="h-6 w-6 text-orange-600" />
              </div>
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Recent Activity */}
          <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200">
            <div className="p-6 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-900">System Audit Logs</h3>
            </div>
            <div className="p-6">
              <div className="space-y-4">
                {stats?.auditLogs?.length === 0 ? (
                  <p className="text-gray-500 text-sm">No recent activity.</p>
                ) : (
                  stats?.auditLogs?.map((log: any) => (
                    <div key={log.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                      <div className="flex items-center space-x-3">
                        <div className="h-2 w-2 bg-blue-500 rounded-full"></div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{log.action}</p>
                          <p className="text-xs text-gray-500">
                            {log.user ? `${log.user.firstName} ${log.user.lastName}` : 'System'} - IP: {log.ipAddress || 'Unknown'}
                          </p>
                        </div>
                      </div>
                      <span className="text-xs text-gray-400">{new Date(log.createdAt).toLocaleString()}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Quick Management</h3>
              <div className="space-y-3">
                <button 
                  onClick={() => setShowAddStudentModal(true)}
                  className="w-full text-left px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg text-sm font-medium text-gray-700 transition-colors"
                >
                  Add New Student
                </button>
                <button className="w-full text-left px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg text-sm font-medium text-gray-700 transition-colors">
                  Manage Wallet Rules
                </button>
                <button className="w-full text-left px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg text-sm font-medium text-gray-700 transition-colors">
                  View Transaction Reports
                </button>
                <button className="w-full text-left px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg text-sm font-medium text-gray-700 transition-colors">
                  System Settings
                </button>
              </div>
          </div>
        </div>

      </main>

      {/* Add Student Modal */}
      <Modal
        isOpen={showAddStudentModal}
        onClose={() => setShowAddStudentModal(false)}
        title="Add New Student"
        footer={
          <>
            <button 
              onClick={() => setShowAddStudentModal(false)}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium"
            >
              Cancel
            </button>
            <button 
              onClick={handleAddStudent}
              disabled={loading}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-bold shadow-md transition-all flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? 'Adding...' : 'Add Student'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
            <input 
              type="email" 
              value={studentForm.email}
              onChange={(e) => setStudentForm({...studentForm, email: e.target.value})}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="student@university.edu.ng"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
              <input 
                type="text" 
                value={studentForm.firstName}
                onChange={(e) => setStudentForm({...studentForm, firstName: e.target.value})}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="John"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
              <input 
                type="text" 
                value={studentForm.lastName}
                onChange={(e) => setStudentForm({...studentForm, lastName: e.target.value})}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Doe"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Matric Number</label>
            <input 
              type="text" 
              value={studentForm.matricNumber}
              onChange={(e) => setStudentForm({...studentForm, matricNumber: e.target.value})}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="2023/SCI/1000"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">College</label>
              <input 
                type="text" 
                value={studentForm.college}
                onChange={(e) => setStudentForm({...studentForm, college: e.target.value})}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="College of Science"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Department</label>
              <input 
                type="text" 
                value={studentForm.department}
                onChange={(e) => setStudentForm({...studentForm, department: e.target.value})}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Computer Science"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Program</label>
              <input 
                type="text" 
                value={studentForm.program}
                onChange={(e) => setStudentForm({...studentForm, program: e.target.value})}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="B.Sc. Computer Science"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Default Password</label>
            <input 
              type="text" 
              value={studentForm.password}
              onChange={(e) => setStudentForm({...studentForm, password: e.target.value})}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg bg-gray-50 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
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

export default AdminDashboard;
