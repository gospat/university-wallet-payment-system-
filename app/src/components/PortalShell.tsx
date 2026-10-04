import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  GraduationCap,
  Shield,
  Landmark,
  LayoutDashboard,
  BookOpen,
  CreditCard,
  Receipt,
  FileText,
  User,
  MessageCircle,
  LogOut,
  Banknote,
  School,
  Scale,
  Settings,
  Menu,
  UserCircle2,
  Search,
  X,
  UserPlus,
  ListFilter,
  BarChart3,
} from 'lucide-react';
import { i18n } from '../i18n/en';
import { searchAdmin, AdminSearchResponse, SearchStudentRow } from '../services/searchApi';

type Role = 'STUDENT' | 'ADMIN' | 'BURSARY';

interface PortalShellProps {
  role: Role;
  activePath: string;
  brand: string;
  userText: string;
  userEmail?: string;
  onLogout: () => void;
  showGlobalSearch?: boolean;
  onGlobalSearch?: (query: string) => void;
  navCounters?: Record<string, number>;
  userPermissions?: string[];
  children: React.ReactNode;
}

interface NavItem {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  badge?: number;
  exact?: boolean;
  sub?: boolean;
  requiresPermission?: string;
  disabled?: boolean;
  onClick?: () => void;
  counterKey?: string;
  rightHint?: string;
  danger?: boolean;
}

interface NavGroup {
  title?: string;
  headingIcon?: React.ComponentType<{ className?: string }>;
  items: NavItem[];
}

const ROLE_STYLES: Record<Role, { accent: string; bg: string; border: string; text: string }> = {
  STUDENT: { accent: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-600', text: 'text-blue-600' },
  ADMIN: { accent: 'text-gray-700', bg: 'bg-gray-50', border: 'border-gray-700', text: 'text-gray-700' },
  BURSARY: { accent: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-600', text: 'text-amber-600' },
};

const ROLE_ICON: Record<Role, React.ComponentType<{ className?: string }>> = {
  STUDENT: GraduationCap,
  ADMIN: Shield,
  BURSARY: Landmark,
};

const ROLE_LABEL: Record<Role, string> = {
  STUDENT: 'STUDENT',
  ADMIN: 'ADMIN',
  BURSARY: 'BURSARY',
};

const formatNGN = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '₦0';
  const num = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.]/g, ''));
  if (isNaN(num)) return '₦0';
  return `₦${num.toLocaleString()}`;
};

const isActive = (itemTo: string, activePath: string, exact?: boolean): boolean => {
  if (itemTo === '#' || itemTo.startsWith('#')) return false;
  const [toPath, toQuery = ''] = itemTo.split('?');
  const [activePathOnly, activeQuery = ''] = activePath.split('?');
  if (exact) {
    if (toPath !== activePathOnly) return false;
    if (toQuery) {
      const toParams = new URLSearchParams(toQuery);
      const activeParams = new URLSearchParams(activeQuery);
      let allMatch = true;
      toParams.forEach((v, k) => {
        if (activeParams.get(k) !== v) allMatch = false;
      });
      return allMatch;
    }
    return true;
  }
  const cleanTo = toPath.split('#')[0];
  const cleanActive = activePathOnly.split('#')[0];
  const pathMatches = cleanTo === cleanActive || (cleanActive.startsWith(cleanTo) && cleanActive[cleanTo.length] === '/');
  if (!pathMatches) return false;
  if (toQuery) {
    const toParams = new URLSearchParams(toQuery);
    const activeParams = new URLSearchParams(activeQuery);
    let allMatch = true;
    toParams.forEach((v, k) => {
      if (activeParams.get(k) !== v) allMatch = false;
    });
    return allMatch;
  }
  return true;
};

const hasPermission = (
  requiresPermission: string | undefined,
  userPermissions?: string[],
  role?: Role,
): boolean => {
  if (!requiresPermission) return true;

  if (role === 'ADMIN') return true;

  if (!userPermissions || userPermissions.length === 0) return false;
  return userPermissions.includes(requiresPermission);
};

const buildStudentNav = (_counters?: Record<string, number>): NavGroup[] => [
  {
    title: i18n.sidebar.groups.navigation,
    items: [
      { to: '/student/dashboard', icon: LayoutDashboard, label: 'Dashboard', exact: true },
      { to: '/student/payments', icon: CreditCard, label: 'Make Payment' },
      { to: '/student/payment-history', icon: Receipt, label: 'Payment History' },
      { to: '/student/receipts', icon: FileText, label: 'Receipts' },
      { to: '/student/profile', icon: User, label: 'Profile' },
      { to: '#', icon: MessageCircle, label: 'Support', disabled: true, rightHint: i18n.sidebar.supportSoon },
    ],
  },
];

const buildAdminNav = (
  role: Role,
  _counters?: Record<string, number>,
  userPermissions?: string[],
): NavGroup[] => {
  const bursary = role === 'BURSARY';
  const prefix = bursary ? '/bursary' : '/admin';

  const receiptItems: NavItem[] = [
    { to: `${prefix}/receipts`, icon: Receipt, label: 'Receipts', sub: true, requiresPermission: 'VIEW_RECEIPTS' },
  ];

  if (bursary && userPermissions?.includes('AUDIT_LOGS_VIEW_LIMITED')) {
    receiptItems.push({
      to: '/bursary/audit-logs',
      icon: Receipt,
      label: 'Audit Logs',
      sub: true,
      requiresPermission: 'AUDIT_LOGS_VIEW_LIMITED',
    });
  }
  if (!bursary) {
    receiptItems.unshift({
      to: `${prefix}/receipts?view=generate`,
      icon: Receipt,
      label: 'Generate Receipt',
      sub: true,
      requiresPermission: 'GENERATE_RECEIPT',
    });
  }

  const groups: NavGroup[] = [
    {
      title: 'DASHBOARD',
      items: [
        { to: `${prefix}/dashboard`, icon: LayoutDashboard, label: 'Dashboard', exact: true, requiresPermission: 'VIEW_DASHBOARD' },
      ],
    },
    {
      title: i18n.sidebar.groups.studentManagement,
      headingIcon: GraduationCap,
      items: [
        { to: `${prefix}/students`, icon: User, label: 'All Students', sub: true, requiresPermission: 'VIEW_STUDENTS' },
        { to: `${prefix}/students?view=create`, icon: UserPlus, label: 'Add Student', sub: true, requiresPermission: 'CREATE_STUDENT' },
        { to: `${prefix}/students?view=upload`, icon: User, label: 'Bulk Upload', sub: true, requiresPermission: 'BULK_UPLOAD_STUDENTS' },
        { to: `${prefix}/students?view=history`, icon: User, label: 'Import History', sub: true, requiresPermission: 'VIEW_IMPORT_HISTORY' },
      ],
    },
    {
      title: 'BILLS & INVOICING',
      headingIcon: Banknote,
      items: [
        { to: `${prefix}/fees?tab=categories`, icon: Banknote, label: 'Bill Categories', sub: true, requiresPermission: 'VIEW_BILL_CATEGORIES' },
        { to: `${prefix}/fees?tab=fees`, icon: Banknote, label: 'Bills Catalogue', sub: true, requiresPermission: 'VIEW_BILLS_CATALOGUE' },
        { to: `${prefix}/bills/create`, icon: Banknote, label: 'Create Bill', sub: true, requiresPermission: 'CREATE_FEE' },
        { to: `${prefix}/fees?tab=edit`, icon: Banknote, label: 'Edit Bill', sub: true, requiresPermission: 'EDIT_FEE' },
        { to: `${prefix}/fees?tab=upload`, icon: Banknote, label: 'Bulk Upload Bills', sub: true, requiresPermission: 'BULK_UPLOAD_FEES' },
        { to: `${prefix}/fees?tab=assignments`, icon: Banknote, label: 'Bill Assignments', sub: true, requiresPermission: 'ASSIGN_FEES' },
      ],
    },
    {
      title: i18n.sidebar.groups.payments,
      headingIcon: CreditCard,
      items: [
        { to: `${prefix}/payments`, icon: CreditCard, label: 'Payments', sub: true, requiresPermission: 'VIEW_PAYMENTS' },
        { to: `${prefix}/payments?view=verify`, icon: Shield, label: 'Verify Payment', sub: true, requiresPermission: 'VERIFY_PAYMENT' },
        { to: `${prefix}/refunds`, icon: CreditCard, label: 'Process Refund', sub: true, requiresPermission: 'PROCESS_REFUND' },
      ],
    },
    {
      title: 'DIRECT BILLING',
      headingIcon: UserPlus,
      items: [
        { to: `${prefix}/direct-billing?tab=bill`, icon: UserPlus, label: 'Bill a Student', sub: true, requiresPermission: 'DIRECT_BILL_STUDENT' },
        { to: `${prefix}/direct-billing?tab=assigned`, icon: ListFilter, label: 'Direct Bills Log', sub: true, requiresPermission: 'VIEW_DIRECT_BILLS_LOG' },
      ],
    },
    {
      title: i18n.sidebar.groups.receipts,
      headingIcon: Receipt,
      items: receiptItems,
    },
    {
      title: i18n.sidebar.groups.academicStructure,
      headingIcon: School,
      items: [
        { to: `${prefix}/academic/faculties`, icon: School, label: 'Colleges', sub: true, requiresPermission: 'VIEW_COLLEGES' },
        { to: `${prefix}/academic/departments`, icon: School, label: 'Departments', sub: true, requiresPermission: 'VIEW_DEPARTMENTS' },
        { to: `${prefix}/academic/programmes`, icon: School, label: 'Programmes', sub: true, requiresPermission: 'VIEW_PROGRAMMES' },
      ],
    },
  ];

  if (bursary) {
    groups.push({
      title: i18n.sidebar.groups.reconciliation,
      headingIcon: Scale,
      items: [
        { to: '/bursary/reconciliation', icon: Scale, label: 'Reconciliation Overview', sub: true, requiresPermission: 'VIEW_RECONCILIATION' },
        { to: '/bursary/reports/centre', icon: BarChart3, label: 'Reports Centre', sub: true, requiresPermission: 'REPORTS_VIEW_COLLECTIONS' },
        { to: '/bursary/reports/exceptions', icon: Shield, label: 'Reconciliation Exceptions', sub: true, requiresPermission: 'REPORTS_VIEW_RECONCILIATION' },
        { to: '/bursary/reports/student-statement', icon: Search, label: 'Student Statement', sub: true, requiresPermission: 'REPORTS_VIEW_COLLECTIONS' },
        { to: '/bursary/reports/export-centre', icon: FileText, label: 'Export Centre', sub: true, requiresPermission: 'REPORTS_EXPORT_EXCEL' },
        { to: '/bursary/reports/scheduled', icon: CreditCard, label: 'Scheduled Reports', sub: true, requiresPermission: 'REPORTS_SCHEDULE' },
      ],
    });
  }

  if (!bursary) {
    groups.push({
      title: i18n.sidebar.groups.administration,
      headingIcon: Settings,
      items: [
        { to: '/admin/users', icon: Shield, label: 'Users', sub: true, requiresPermission: 'MANAGE_USERS' },
        { to: '/admin/roles', icon: Shield, label: 'Roles', sub: true, requiresPermission: 'MANAGE_ROLES' },
        { to: '/admin/permissions', icon: Shield, label: 'Permissions', sub: true, requiresPermission: 'MANAGE_ROLES' },
        { to: '/admin/settings', icon: Settings, label: 'System Settings', sub: true, requiresPermission: 'SYSTEM_SETTINGS' },
        { to: '/admin/payment-config', icon: Settings, label: 'Payment Configuration', sub: true, requiresPermission: 'PAYSTACK_CONFIG' },
        { to: '/admin/audit-logs', icon: FileText, label: 'Audit Logs', sub: true, requiresPermission: 'AUDIT_LOGS_VIEW_FULL' },
      ],
    });
  }

  return groups;
};

interface SearchFlattenedRow {
  kind: 'student-action' | 'payment' | 'receipt';
  groupTitle: string;
  indexInGroup: number;
  studentIndex?: number;
  href: string;
  label: string;
}

const NavItemRow: React.FC<{
  item: NavItem;
  role: Role;
  activePath: string;
  onItemClick?: () => void;
}> = ({ item, role, activePath, onItemClick }) => {
  const styles = ROLE_STYLES[role];
  const Icon = item.icon;
  const active = isActive(item.to, activePath, item.exact);
  const badgeValue = item.badge;

  const baseRowClass = [
    'h-10 w-full flex items-center justify-between px-4 text-sm cursor-pointer',
    item.sub ? 'pl-10' : '',
    item.disabled ? 'pointer-events-none' : 'hover:bg-gray-50',
    active
      ? `border-l-2 ${styles.border} ${styles.bg} ${styles.text} font-semibold`
      : 'border-l-2 border-transparent text-gray-700',
  ].join(' ');

  if (item.onClick) {
    return (
      <button
        type="button"
        onClick={() => {
          item.onClick?.();
          onItemClick?.();
        }}
        className={`${baseRowClass} ${item.danger ? 'text-red-600 hover:bg-gray-50' : ''} border-0 bg-transparent text-left w-full`}
      >
        <span className="flex items-center min-w-0 flex-1">
          <Icon className="h-4 w-4 mr-3 shrink-0" />
          <span className="truncate">{item.label}</span>
        </span>
        {badgeValue !== undefined && badgeValue > 0 && (
          <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 ml-2">
            {badgeValue}
          </span>
        )}
        {item.rightHint && <span className="text-xs text-gray-400 ml-2 shrink-0">{item.rightHint}</span>}
      </button>
    );
  }

  return (
    <Link
      to={item.to}
      onClick={onItemClick}
      className={baseRowClass}
      {...(active ? { 'aria-current': 'page' as const } : {})}
    >
      <span className="flex items-center min-w-0 flex-1">
        <Icon className="h-4 w-4 mr-3 shrink-0" />
        <span className="truncate">{item.label}</span>
      </span>
      {badgeValue !== undefined && badgeValue > 0 && (
        <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 ml-2">
          {badgeValue}
        </span>
      )}
      {item.rightHint && <span className="text-xs text-gray-400 ml-2 shrink-0">{item.rightHint}</span>}
    </Link>
  );
};

const getStudentName = (s: SearchStudentRow): string => {
  const parts = [s.firstName, s.middleName, s.lastName].filter(Boolean);
  return parts.join(' ') || s.email;
};

const STUDENT_ACTIONS: Array<{
  key: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  suffix: string;
}> = [
  { key: 'profile', label: 'Profile', Icon: User, suffix: '' },
  { key: 'fees', label: 'Bills', Icon: BookOpen, suffix: '/fees' },
  { key: 'invoices', label: 'Invoices', Icon: FileText, suffix: '/invoices' },
  { key: 'payments', label: 'Payments', Icon: CreditCard, suffix: '/payments' },
  { key: 'receipts', label: 'Receipts', Icon: Receipt, suffix: '/receipts' },
];

const PortalShell: React.FC<PortalShellProps> = ({
  role,
  activePath,
  brand,
  userText,
  userEmail,
  onLogout,
  showGlobalSearch,
  onGlobalSearch,
  navCounters,
  userPermissions,
  children,
}) => {
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<AdminSearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [focusedRowIndex, setFocusedRowIndex] = useState<number>(-1);

  const searchWrapRef = useRef<HTMLDivElement | null>(null);
  const debounceTimerRef = useRef<number | null>(null);

  const styles = ROLE_STYLES[role];
  const BrandIcon = ROLE_ICON[role];

  const navGroups = role === 'STUDENT'
    ? buildStudentNav(navCounters)
    : buildAdminNav(role, navCounters, userPermissions);

  const visibleNavGroups = useMemo(
    () =>
      navGroups
        .map((g) => ({
          ...g,
          visibleItems: g.items.filter((item) => hasPermission(item.requiresPermission, userPermissions, role)),
        }))
        .filter((g) => g.visibleItems.length > 0),
    [navGroups, userPermissions, role],
  );

  const logoutItem: NavItem = {
    to: '#',
    icon: LogOut,
    label: i18n.sidebar.logout,
    onClick: onLogout,
    danger: true,
  };

  const flattenedRows: SearchFlattenedRow[] = useMemo(() => {
    const rows: SearchFlattenedRow[] = [];
    if (!searchResults) return rows;

    searchResults.students.forEach((s, si) => {
      STUDENT_ACTIONS.forEach((a, ai) => {
        rows.push({
          kind: 'student-action',
          groupTitle: 'Students',
          indexInGroup: ai,
          studentIndex: si,
          href: `/admin/students/${s.id}${a.suffix}`,
          label: `${a.label} → ${getStudentName(s)}`,
        });
      });
    });

    searchResults.payments.forEach((p, i) => {
      rows.push({
        kind: 'payment',
        groupTitle: 'Payments',
        indexInGroup: i,
        href: p.studentId ? `/admin/students/${p.studentId}/payments` : '/admin/payments',
        label: `Payment ${p.reference}`,
      });
    });

    searchResults.receipts.forEach((r, i) => {
      rows.push({
        kind: 'receipt',
        groupTitle: 'Receipts',
        indexInGroup: i,
        href: r.studentId ? `/admin/students/${r.studentId}/receipts` : '/admin/receipts',
        label: `Receipt ${r.receiptNumber}`,
      });
    });

    return rows;
  }, [searchResults]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    const onResize = () => {
      if (window.innerWidth >= 768) setDrawerOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (!showGlobalSearch) return;

    const onDocClick = (e: MouseEvent) => {
      if (!searchWrapRef.current) return;
      if (!searchWrapRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showGlobalSearch]);

  useEffect(() => {
    if (!showGlobalSearch || !searchOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSearchOpen(false);
        setFocusedRowIndex(-1);
        return;
      }

      if (!flattenedRows.length) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedRowIndex((prev) => {
          if (prev < 0) return 0;
          return Math.min(prev + 1, flattenedRows.length - 1);
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedRowIndex((prev) => {
          if (prev <= 0) return 0;
          return prev - 1;
        });
      } else if (e.key === 'Enter') {
        if (focusedRowIndex >= 0 && focusedRowIndex < flattenedRows.length) {
          e.preventDefault();
          const target = flattenedRows[focusedRowIndex];
          setSearchOpen(false);
          setFocusedRowIndex(-1);
          navigate(target.href);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showGlobalSearch, searchOpen, flattenedRows, focusedRowIndex, navigate]);

  useEffect(() => {
    if (!showGlobalSearch) return;

    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      setSearchError(null);
      setSearchLoading(false);
      setSearchOpen(false);
      return;
    }

    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
    setSearchLoading(true);
    setSearchOpen(true);
    setFocusedRowIndex(-1);

    debounceTimerRef.current = window.setTimeout(async () => {
      try {
        const results = await searchAdmin(q);
        setSearchResults(results);
        setSearchError(null);
      } catch (err: any) {
        setSearchResults(null);
        setSearchError(err?.response?.data?.message || err?.message || 'Search failed');
      } finally {
        setSearchLoading(false);
        if (debounceTimerRef.current !== null) {
          window.clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
      }
    }, 300);

    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [showGlobalSearch, searchQuery]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onGlobalSearch?.(searchQuery.trim());
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults(null);
    setSearchError(null);
    setSearchOpen(false);
    setFocusedRowIndex(-1);
  };

  const sidebarContent = (
    <aside
      className="h-full w-[256px] shrink-0 bg-white border-r border-gray-200 flex flex-col"
    >
      <div className="p-4 shrink-0">
        <div className="flex items-center gap-2">
          <BrandIcon className={`h-4 w-4 ${styles.accent}`} />
          <span className="text-xl font-bold text-gray-900 truncate">{brand}</span>
        </div>
        <div className={`mt-1 text-xs uppercase tracking-wide ${styles.accent} font-semibold`}>
          {ROLE_LABEL[role]}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto pb-4 pr-1 scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent">
        {visibleNavGroups.length === 0 ? (
          <div className="px-4 pt-6 pb-4">
            <div
              role="alert"
              className="rounded-xl border border-amber-200 bg-amber-50 text-amber-900 px-4 py-3 text-sm"
            >
              <div className="font-semibold mb-1">No menu items available</div>
              <p className="text-xs leading-relaxed text-amber-800">
                No menu items available for your role. Contact an administrator to request additional permissions.
              </p>
            </div>
          </div>
        ) : (
          visibleNavGroups.map((group, gi) => (
            <div key={gi}>
              {group.title && (
                <div className="px-4 pt-4 pb-2">
                  <div className="flex items-center gap-2">
                    {group.headingIcon && <group.headingIcon className="h-3.5 w-3.5 text-gray-400" />}
                    <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                      {group.title}
                    </span>
                  </div>
                </div>
              )}
              <div>
                {group.visibleItems.map((item, ii) => (
                  <NavItemRow
                    key={`${gi}-${ii}`}
                    item={item}
                    role={role}
                    activePath={activePath}
                    onItemClick={() => setDrawerOpen(false)}
                  />
                ))}
              </div>
            </div>
          ))
        )}

        <div className="pt-4 mt-2 border-t border-gray-100">
          <NavItemRow
            item={logoutItem}
            role={role}
            activePath={activePath}
            onItemClick={() => setDrawerOpen(false)}
          />
        </div>
      </nav>
    </aside>
  );

  const hasAnyResults = searchResults && (
    searchResults.students.length > 0 ||
    searchResults.payments.length > 0 ||
    searchResults.receipts.length > 0
  );

  return (
    <div className="min-h-screen h-screen bg-gray-50 flex overflow-hidden">
      <div className="hidden md:flex shrink-0 sticky top-0 h-screen">
        {sidebarContent}
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute left-0 top-0 h-full z-50">
            {sidebarContent}
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        <header className="h-14 bg-white border-b border-gray-200 flex items-center px-4 gap-3 shrink-0 sticky top-0 z-20 shadow-sm">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="md:hidden p-2 -ml-2 rounded-lg hover:bg-gray-100"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4 text-gray-700" />
          </button>

          {showGlobalSearch && (
            <div ref={searchWrapRef} className="flex-1 max-w-xl mx-auto relative">
              <form onSubmit={handleSearchSubmit}>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onFocus={() => {
                      if (searchQuery.trim() && (searchResults || searchError)) {
                        setSearchOpen(true);
                      }
                    }}
                    placeholder={i18n.sidebar.searchPlaceholder}
                    className="w-full h-9 pl-9 pr-9 rounded-lg border border-gray-200 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-300 focus:ring-1 focus:ring-gray-200"
                    aria-expanded={searchOpen}
                    aria-haspopup="listbox"
                    aria-controls="global-search-dropdown"
                    autoComplete="off"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={clearSearch}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-gray-100"
                      aria-label="Clear search"
                    >
                      <X className="h-3.5 w-3.5 text-gray-400" />
                    </button>
                  )}
                </div>
              </form>

              {searchOpen && (
                <div
                  id="global-search-dropdown"
                  role="listbox"
                  className="absolute left-0 right-0 top-full mt-1 rounded-lg border border-gray-200 bg-white shadow-lg z-50 overflow-hidden max-h-[70vh] overflow-y-auto"
                >
                  {searchLoading && (
                    <div className="px-4 py-6 text-center">
                      <div className="inline-flex items-center gap-2 text-sm text-gray-500">
                        <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Searching…
                      </div>
                    </div>
                  )}

                  {!searchLoading && searchError && (
                    <div className="px-4 py-6 text-center">
                      <p className="text-sm text-red-600">{searchError}</p>
                    </div>
                  )}

                  {!searchLoading && !searchError && !hasAnyResults && (
                    <div className="px-4 py-6 text-center">
                      <p className="text-sm text-gray-500">No results for "{searchQuery.trim()}".</p>
                      <p className="text-xs text-gray-400 mt-1">Try a matric number, email, student name, payment reference, or receipt number.</p>
                    </div>
                  )}

                  {!searchLoading && !searchError && hasAnyResults && searchResults && (
                    <div className="py-2">
                      {searchResults.students.length > 0 && (
                        <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-50/60">
                          Students
                        </div>
                      )}
                      {searchResults.students.map((student, si) => {
                        const name = getStudentName(student);
                        const firstActionIdx = flattenedRows.findIndex(
                          (r) => r.kind === 'student-action' && r.studentIndex === si && r.indexInGroup === 0
                        );
                        return (
                          <div
                            key={`s-${student.id}`}
                            className={`px-3 py-2.5 ${firstActionIdx === focusedRowIndex ? 'bg-gray-50' : ''}`}
                          >
                            <div className="flex items-start justify-between gap-3 min-w-0">
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium text-gray-900 truncate">{name}</div>
                                <div className="text-xs text-gray-500 truncate mt-0.5">
                                  {student.matricNumber && <span className="font-mono">{student.matricNumber}</span>}
                                  {student.matricNumber && student.email && <span className="mx-1.5 text-gray-300">·</span>}
                                  {student.email && <span>{student.email}</span>}
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <div className="text-xs text-gray-400">Total Paid</div>
                                <div className="text-sm font-semibold text-emerald-700">
                                  {formatNGN(student.totalPaid || 0)}
                                </div>
                              </div>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1">
                              {STUDENT_ACTIONS.map((a, ai) => {
                                const flatIdx = flattenedRows.findIndex(
                                  (r) => r.kind === 'student-action' && r.studentIndex === si && r.indexInGroup === ai
                                );
                                const isFocused = flatIdx === focusedRowIndex;
                                const actionHref = `/admin/students/${student.id}${a.suffix}`;
                                return (
                                  <Link
                                    key={a.key}
                                    to={actionHref}
                                    onClick={() => {
                                      setSearchOpen(false);
                                      setFocusedRowIndex(-1);
                                    }}
                                    onMouseEnter={() => setFocusedRowIndex(flatIdx)}
                                    className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium border ${
                                      isFocused
                                        ? 'bg-blue-600 border-blue-600 text-white'
                                        : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-gray-300'
                                    }`}
                                    title={`${a.label} for ${name}`}
                                  >
                                    <a.Icon className="h-3.5 w-3.5" />
                                    {a.label}
                                  </Link>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}

                      {searchResults.payments.length > 0 && (
                        <>
                          <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-50/60 mt-2">
                            Payments
                          </div>
                          {searchResults.payments.map((p, i) => {
                            const flatIdx = flattenedRows.findIndex(
                              (r) => r.kind === 'payment' && r.indexInGroup === i
                            );
                            const isFocused = flatIdx === focusedRowIndex;
                            return (
                              <Link
                                key={`p-${p.id}`}
                                to={p.studentId ? `/admin/students/${p.studentId}/payments` : '/admin/payments'}
                                onClick={() => {
                                  setSearchOpen(false);
                                  setFocusedRowIndex(-1);
                                }}
                                onMouseEnter={() => setFocusedRowIndex(flatIdx)}
                                className={`block px-3 py-2 ${isFocused ? 'bg-gray-50' : ''}`}
                              >
                                <div className="flex items-center justify-between gap-3 min-w-0">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-mono text-gray-900 truncate">{p.reference}</div>
                                    {p.studentName && (
                                      <div className="text-xs text-gray-500 truncate mt-0.5">{p.studentName}</div>
                                    )}
                                  </div>
                                  <div className="text-right shrink-0">
                                    <div className="text-sm font-semibold text-gray-900">{formatNGN(p.amount)}</div>
                                    <div className={`text-xs font-medium ${
                                      p.status === 'SUCCESS' ? 'text-emerald-600' :
                                      p.status === 'PENDING' ? 'text-amber-600' :
                                      p.status === 'FAILED' ? 'text-red-600' : 'text-gray-500'
                                    }`}>
                                      {p.status}
                                    </div>
                                  </div>
                                </div>
                              </Link>
                            );
                          })}
                        </>
                      )}

                      {searchResults.receipts.length > 0 && (
                        <>
                          <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-50/60 mt-2">
                            Receipts
                          </div>
                          {searchResults.receipts.map((r, i) => {
                            const flatIdx = flattenedRows.findIndex(
                              (rr) => rr.kind === 'receipt' && rr.indexInGroup === i
                            );
                            const isFocused = flatIdx === focusedRowIndex;
                            return (
                              <Link
                                key={`r-${r.id}`}
                                to={r.studentId ? `/admin/students/${r.studentId}/receipts` : '/admin/receipts'}
                                onClick={() => {
                                  setSearchOpen(false);
                                  setFocusedRowIndex(-1);
                                }}
                                onMouseEnter={() => setFocusedRowIndex(flatIdx)}
                                className={`block px-3 py-2 ${isFocused ? 'bg-gray-50' : ''}`}
                              >
                                <div className="flex items-center justify-between gap-3 min-w-0">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-mono text-gray-900 truncate">{r.receiptNumber}</div>
                                    {r.studentName && (
                                      <div className="text-xs text-gray-500 truncate mt-0.5">{r.studentName}</div>
                                    )}
                                  </div>
                                  <div className="text-right shrink-0">
                                    <div className="text-sm font-semibold text-gray-900">{formatNGN(r.amount)}</div>
                                  </div>
                                </div>
                              </Link>
                            );
                          })}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {!showGlobalSearch && <div className="flex-1" />}

          <div className="flex items-center gap-3 shrink-0">
            <div className="hidden sm:flex items-center gap-2">
              <UserCircle2 className="h-4 w-4 text-gray-500" />
              <div className="flex flex-col leading-tight">
                <span className="text-sm text-gray-700 truncate max-w-[10rem]">{userText}</span>
                {userEmail && <span className="text-xs text-gray-400 truncate max-w-[10rem]">{userEmail}</span>}
              </div>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="text-sm text-red-600 hover:text-red-800 font-medium"
            >
              {i18n.sidebar.logout}
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="px-4 sm:px-6 lg:px-8 py-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

export default PortalShell;
