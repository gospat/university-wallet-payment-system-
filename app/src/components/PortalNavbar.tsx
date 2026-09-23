import React from 'react';
import { Link } from 'react-router-dom';

type PortalNavbarProps = {
  brand: string;
  userText: string;
  onLogout: () => void;
  tabs?: Array<{ label: string; active: boolean; onClick?: () => void; to?: string; }>;
};

const PortalNavbar: React.FC<PortalNavbarProps> = ({ brand, userText, onLogout, tabs }) => {
  return (
    <nav className="bg-white border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between md:h-16 gap-0 md:gap-4 pt-3 md:pt-0">
          <div className="flex items-center h-12 md:h-16 shrink-0">
            <span className="text-xl font-bold text-blue-600">{brand}</span>
          </div>
          {tabs && tabs.length > 0 && (
            <div className="flex items-center gap-1 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0 pb-2 md:pb-0">
              {tabs.map((t) => {
                const base =
                  'inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap';
                const cls = t.active
                  ? `${base} bg-blue-50 text-blue-700 border border-blue-200`
                  : `${base} text-gray-600 hover:bg-gray-50 hover:text-gray-900`;
                if (t.to) {
                  return (
                    <Link key={t.label} to={t.to} className={cls}>{t.label}</Link>
                  );
                }
                return (
                  <button key={t.label} onClick={t.onClick} className={cls} type="button">
                    {t.label}
                  </button>
                );
              })}
            </div>
          )}
          <div className="hidden md:flex items-center gap-4 h-16 shrink-0">
            <span className="text-gray-700 font-medium truncate max-w-[16rem]">{userText}</span>
            <button
              onClick={onLogout}
              className="text-sm text-red-600 hover:text-red-800 font-medium"
            >
              Logout
            </button>
          </div>
          <div className="md:hidden flex items-center justify-between pb-3">
            <span className="text-gray-700 font-medium truncate max-w-[70%]">{userText}</span>
            <button
              onClick={onLogout}
              className="text-sm text-red-600 hover:text-red-800 font-medium"
            >
              Logout
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default PortalNavbar;
