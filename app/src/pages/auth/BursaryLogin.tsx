import React, { useState } from 'react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Briefcase, Mail } from 'lucide-react';
import PasswordInput from '../../components/ui/PasswordInput';
import UniversityLogo from '../../components/ui/UniversityLogo';

const BursaryLogin: React.FC = () => {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError('');
    
    try {
      const res = await api.post('/auth/login', { identifier, password, audience: 'BURSARY' });
      
      const role = res.data?.data?.user?.role;
      if (role !== 'BURSARY') {
        throw new Error('Incorrect email or password.');
      }

      login(res.data.token, res.data.data.user, res.data.refreshToken);
      const base = '/bursary/dashboard';
      const allowedPrefix = '/bursary/';
      const raw = location.state?.from as string | undefined;
      const fromOk = raw && (raw === base || raw.startsWith(allowedPrefix));
      const next = fromOk ? raw! : base;
      navigate(next, { replace: true });
      
    } catch (err: any) {
      const serverMsg = err?.response?.data?.message;
      setError(serverMsg && String(serverMsg).trim() ? String(serverMsg) : 'Incorrect email or password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-amber-50 via-white to-orange-50 px-4 py-8">
      <div className="max-w-md w-full">
        <div className="flex justify-center mb-6">
          <Link to="/bursary/login" className="inline-flex items-center gap-3">
            <UniversityLogo size="lg" showName />
          </Link>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8 border border-gray-100">
          <div className="text-center mb-8">
            <div className="bg-amber-100 p-3 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4 border border-amber-200">
              <Briefcase className="h-8 w-8 text-amber-600" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Bursary Portal</h1>
            <p className="text-gray-500 mt-2">Finance & Operations Access</p>
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 p-4 rounded-lg mb-6 text-sm border border-red-100">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Staff Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                <input
                  type="text"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none transition-all placeholder-gray-400"
                  placeholder="finance@bellsuniversity.edu.ng"
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
              inputClassName="border-gray-300 focus:ring-amber-500 focus:border-amber-500"
              required
            />

            <div className="flex items-center justify-end">
              <Link
                to="/forgot-password"
                className="text-sm font-medium text-amber-700 hover:text-amber-900 transition"
              >
                Forgot Password?
              </Link>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-lg transition-all transform hover:scale-[1.02] active:scale-95 disabled:opacity-70 disabled:cursor-not-allowed shadow-lg shadow-amber-200"
            >
              {loading ? 'Authenticating...' : 'Login to Finance'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-500 mt-6">
          &copy; {new Date().getFullYear()} Bells University of Technology — Bursary Dept. All rights reserved.
        </p>
      </div>
    </div>
  );
};

export default BursaryLogin;
