import React from 'react';

type PortalNavbarProps = {
  brand: string;
  userText: string;
  onLogout: () => void;
};

const PortalNavbar: React.FC<PortalNavbarProps> = ({ brand, userText, onLogout }) => {
  return (
    <nav className="bg-white shadow-sm border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex items-center">
            <span className="text-xl font-bold text-blue-600">{brand}</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-gray-700 font-medium">{userText}</span>
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

