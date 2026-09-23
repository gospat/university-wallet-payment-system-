import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type BrandingPayload = {
  name: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  bankName: string;
  bankAccount: string;
  bursarName: string | null;
  bursarTitle: string | null;
  bursarSignatureUrl: string | null;
  receiptFooterText: string | null;
  receiptPrefix: string;
  paymentRefPrefix: string;
};

type CtxState = {
  brand: BrandingPayload | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

const BrandingContext = createContext<CtxState | null>(null);

function getApiBase(): string {
  const fromVite = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '');
  if (fromVite) return fromVite;
  const proto = window.location.protocol;
  const host = window.location.hostname;
  const port = window.location.port;
  const apiPort = port === '5174' || port === '5173' ? '3001' : port;
  return `${proto}//${host}${apiPort ? ':' + apiPort : ''}/api/v1`;
}

function setFavicon(faviconUrl: string | null | undefined) {
  let link: HTMLLinkElement | null = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    document.head.appendChild(link);
  }
  link.href = faviconUrl && faviconUrl.trim().length ? faviconUrl : '/vite.svg';
}

function setAppTitle(name: string | null | undefined) {
  const suffix = 'Payment Portal';
  document.title = name && name.trim().length ? `${name.trim()} — ${suffix}` : suffix;
}

export const BrandingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [brand, setBrand] = useState<BrandingPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fallbackName = (import.meta.env.VITE_UNIVERSITY_NAME as string | undefined) || 'University Payment Platform';

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/public/branding`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data: BrandingPayload = json?.data;
      if (!data) throw new Error('empty branding payload');
      setBrand(data);
      setAppTitle(data.name);
      setFavicon(data.faviconUrl);
    } catch (e: any) {
      setError(e?.message || 'Failed to load branding');
      setAppTitle(fallbackName);
      setFavicon(null);
      setBrand({
        name: fallbackName,
        logoUrl: null,
        faviconUrl: null,
        address: null,
        phone: null,
        email: null,
        website: (import.meta.env.VITE_UNIVERSITY_WEBSITE as string | null) || null,
        bankName: '',
        bankAccount: '',
        bursarName: null,
        bursarTitle: null,
        bursarSignatureUrl: null,
        receiptFooterText: null,
        receiptPrefix: 'REC',
        paymentRefPrefix: 'PAY',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<CtxState>(() => ({ brand, loading, error, reload }), [brand, loading, error, reload]);
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
};

export function useBranding(): CtxState {
  const ctx = useContext(BrandingContext);
  if (!ctx) throw new Error('useBranding must be used within BrandingProvider');
  return ctx;
}
