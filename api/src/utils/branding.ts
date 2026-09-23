import { SystemSettingsService } from '../services/systemSettings';

export type Branding = {
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

const DEFAULT_NAME = 'University Payment Platform';

function strOrNull(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function str(v: string | undefined | null, dflt = ''): string {
  if (v === undefined || v === null) return dflt;
  const s = String(v).trim();
  return s.length ? s : dflt;
}

export function brandingEnvOnly(): Branding {
  const e = process.env;
  return {
    name: str(e.UNIVERSITY_NAME, DEFAULT_NAME),
    logoUrl: strOrNull(e.UNIVERSITY_LOGO_URL),
    faviconUrl: strOrNull(e.UNIVERSITY_FAVICON_URL),
    address: strOrNull(e.UNIVERSITY_ADDRESS),
    phone: strOrNull(e.UNIVERSITY_PHONE),
    email: strOrNull(e.UNIVERSITY_EMAIL),
    website: strOrNull(e.UNIVERSITY_WEBSITE),
    bankName: str(e.UNIVERSITY_BANK_NAME),
    bankAccount: str(e.UNIVERSITY_BANK_ACCOUNT),
    bursarName: strOrNull(e.RECEIPT_BURSAR_NAME),
    bursarTitle: strOrNull(e.RECEIPT_BURSAR_TITLE),
    bursarSignatureUrl: strOrNull(e.RECEIPT_BURSAR_SIGNATURE_URL),
    receiptFooterText: strOrNull(e.RECEIPT_FOOTER_TEXT),
    receiptPrefix: str(e.RECEIPT_PREFIX, 'REC'),
    paymentRefPrefix: str(e.PAYMENT_REF_PREFIX, 'PAY'),
  };
}

export function hasBrandingSignature(b: Pick<Branding, 'bursarName' | 'bursarTitle' | 'bursarSignatureUrl'>): boolean {
  return Boolean(b.bursarName || b.bursarTitle || b.bursarSignatureUrl);
}

export async function buildBranding(): Promise<Branding> {
  const envBase = brandingEnvOnly();
  try {
    const row = await SystemSettingsService.get();
    if (!row) return envBase;
    return {
      name: row.universityName || envBase.name,
      logoUrl: row.universityLogoUrl ?? envBase.logoUrl,
      faviconUrl: row.universityFaviconUrl ?? envBase.faviconUrl,
      address: row.universityAddress ?? envBase.address,
      phone: row.universityPhone ?? envBase.phone,
      email: row.universityEmail ?? envBase.email,
      website: row.universityWebsite ?? envBase.website,
      bankName: envBase.bankName,
      bankAccount: envBase.bankAccount,
      bursarName: (row as any).receiptBursarName ?? envBase.bursarName,
      bursarTitle: (row as any).receiptBursarTitle ?? envBase.bursarTitle,
      bursarSignatureUrl: (row as any).receiptBursarSignatureUrl ?? envBase.bursarSignatureUrl,
      receiptFooterText: row.receiptFooterText ?? envBase.receiptFooterText,
      receiptPrefix: row.receiptPrefix || envBase.receiptPrefix,
      paymentRefPrefix: row.paymentRefPrefix || envBase.paymentRefPrefix,
    };
  } catch (err) {
    return envBase;
  }
}
