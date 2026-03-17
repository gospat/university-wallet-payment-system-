import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Users, DollarSign, Activity, FileText } from 'lucide-react';
import api from '../../services/api';

const AdminDashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const [stats, setStats] = useState<any>(null);

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
    const email = prompt("Enter student email:");
    const firstName = prompt("Enter first name:");
    const lastName = prompt("Enter last name:");
    const matricNumber = prompt("Enter matric number:");

    if (!email || !firstName || !lastName || !matricNumber) {
      alert("All fields are required.");
      return;
    }

    try {
      await api.post('/admin/students', { email, firstName, lastName, matricNumber });
      alert('Student added successfully!');
      fetchStats(); // Refresh stats to update total student count
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to add student');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navbar */}
      <nav className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <span className="text-xl font-bold text-gray-900">Admin Portal</span>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-gray-700 font-medium">Admin: {user?.firstName}</span>
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
                  onClick={handleAddStudent}
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
    </div>
  );
};

export default AdminDashboard;
