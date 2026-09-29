import React, { useState } from 'react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { User, Mail } from 'lucide-react';
import PasswordInput from '../../components/ui/PasswordInput';
import UniversityLogo from '../../components/ui/UniversityLogo';

const StudentLogin: React.FC = () => {
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
      
      if (res.data.data.user.role !== 'STUDENT') {
        throw new Error('Unauthorized access. This portal is for students only.');
      }

      login(res.data.token, res.data.data.user);
      const base = '/student/dashboard';
      const raw = location.state?.from as string | undefined;
      const fromOk = raw && (raw === base || raw.startsWith('/student/'));
      const next = fromOk ? raw! : base;
      navigate(next, { replace: true });
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Login failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-sky-100 px-4 py-8">
      <div className="max-w-md w-full">
        <div className="flex justify-center mb-6">
          <Link to="/login" className="inline-flex items-center gap-3">
            <UniversityLogo size="lg" showName nameVariant="brand" />
          </Link>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8 border border-blue-50">
          <div className="text-center mb-8">
            <div className="bg-blue-100 p-3 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4">
              <User className="h-8 w-8 text-blue-600" />
            </div>
            <h1 className="text-3xl font-bold text-gray-900">Student Portal</h1>
            <p className="text-gray-500 mt-2">Access your fees, invoices and receipts</p>
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 p-4 rounded-lg mb-6 text-sm border border-red-100">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Student Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                  placeholder="student@bellsuniversity.edu.ng"
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <PasswordInput
              label="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
              inputClassName="border-gray-300 focus:ring-blue-500 focus:border-blue-500"
              required
            />

            <div className="flex items-center justify-end">
              <Link
                to="/forgot-password"
                className="text-sm font-medium text-[var(--brand-primary,#0e74cc)] hover:text-blue-800 transition"
              >
                Forgot Password?
              </Link>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[var(--brand-primary,#0e74cc)] hover:bg-[var(--brand-primary-hover,#0b64b0)] text-white font-bold py-3 rounded-lg transition-all transform hover:scale-[1.02] active:scale-95 disabled:opacity-70 disabled:cursor-not-allowed shadow-lg shadow-blue-200"
            >
              {loading ? 'Authenticating...' : 'Access Portal'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-500 mt-6">
          &copy; {new Date().getFullYear()} Bells University of Technology. All rights reserved.
        </p>
      </div>
    </div>
  );
};

export default StudentLogin;
