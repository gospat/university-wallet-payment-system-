import React, { useState } from 'react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { ShieldCheck, Mail } from 'lucide-react';
import PasswordInput from '../../components/ui/PasswordInput';
import UniversityLogo from '../../components/ui/UniversityLogo';

const AdminLogin: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    
    try {
      const res = await api.post('/auth/login', { email, password });
      
      const role = res.data.data.user.role;
      if (role !== 'ADMIN' && role !== 'BURSARY') {
        throw new Error('Unauthorized access. Administrative privileges required.');
      }

      login(res.data.token, res.data.data.user);

      const base = role === 'ADMIN' ? '/admin/dashboard' : '/bursary/dashboard';
      const next = (location.state?.from as string | undefined) || base;
      navigate(next, { replace: true });
      
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 px-4 py-8">
      <div className="max-w-md w-full">
        <div className="flex justify-center mb-6">
          <Link to="/admin/login" className="inline-flex items-center gap-3">
            <UniversityLogo size="lg" showName nameClassName="!text-white" />
          </Link>
        </div>

        <div className="bg-gray-800 rounded-2xl shadow-2xl p-8 border border-gray-700">
          <div className="text-center mb-8">
            <div className="bg-gray-700 p-3 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4 border border-gray-600">
              <ShieldCheck className="h-8 w-8 text-green-400" />
            </div>
            <h1 className="text-2xl font-bold text-white">Administrative Access</h1>
            <p className="text-gray-400 mt-2">Authorized Personnel Only</p>
          </div>

          {error && (
            <div className="bg-red-900/30 text-red-400 p-4 rounded-lg mb-6 text-sm border border-red-900/50">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Admin Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none transition-all placeholder-gray-500"
                  placeholder="admin@bellsuniversity.edu.ng"
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <PasswordInput
              label="Secure Key"
              variant="dark"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
              inputClassName="focus:!border-green-500 focus:!ring-green-500/30"
              required
            />

            <div className="flex items-center justify-end">
              <Link
                to="/forgot-password"
                className="text-sm font-medium text-green-400 hover:text-green-300 transition"
              >
                Forgot Password?
              </Link>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg transition-all transform hover:scale-[1.02] active:scale-95 disabled:opacity-70 disabled:cursor-not-allowed shadow-lg shadow-green-900/20"
            >
              {loading ? 'Verifying Credentials...' : 'Secure Login'}
            </button>
          </form>
          
          <div className="mt-6 text-center text-xs text-gray-500">
            <p>Access to this system is monitored and logged.</p>
            <p>Unauthorized access attempts will be reported.</p>
          </div>
        </div>

        <p className="text-center text-xs text-gray-500 mt-6">
          &copy; {new Date().getFullYear()} Bells University of Technology. All rights reserved.
        </p>
      </div>
    </div>
  );
};

export default AdminLogin;
