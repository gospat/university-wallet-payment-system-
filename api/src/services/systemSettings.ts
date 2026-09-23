import { Prisma, SystemSettings, PaymentGateway } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';

const JSON_DB_NULL = Prisma.JsonNull;

export type SystemSettingsPatch = Partial<
  Omit<SystemSettings, 'id' | 'createdAt' | 'updatedAt'>
>;

const SEED_DATA: SystemSettingsPatch = {
  universityName: 'University Payment Platform',
  universityLogoUrl: null,
  universityFaviconUrl: null,
  universityAddress: null,
  universityPhone: null,
  universityEmail: null,
  universityWebsite: null,
  paystackLiveEnabled: false,
  activePaymentGateway: PaymentGateway.ALATPAY,
  largePaymentThreshold: new Prisma.Decimal(500000),
  importErrorThreshold: 10,
  receiptFooterText: null,
  receiptBursarName: null,
  receiptBursarTitle: null,
  receiptBursarSignatureUrl: null,
  receiptPrefix: 'REC',
  paymentRefPrefix: 'PAY',
  updatedById: null,
};

export function validateActivePaymentGatewayValue(val: unknown): PaymentGateway {
  if (val === 'PAYSTACK' || val === 'ALATPAY') return val;
  if (val === 0 || val === 1 || typeof val === 'number') {
    return val === 1 ? PaymentGateway.ALATPAY : PaymentGateway.PAYSTACK;
  }
  if (val !== undefined && val !== null) {
    const s = String(val).trim().toUpperCase();
    if (s === 'PAYSTACK' || s === 'ALATPAY') return s as PaymentGateway;
  }
  throw new AppError('activePaymentGateway must be PAYSTACK or ALATPAY', 400);
}

export class SystemSettingsService {
  private static ensurePlainTypes(row: any): SystemSettings {
    if (!row) return row;
    const out: any = { ...row };
    if (out.largePaymentThreshold !== null && out.largePaymentThreshold !== undefined) {
      out.largePaymentThreshold = new Prisma.Decimal(out.largePaymentThreshold);
    }
    return out as SystemSettings;
  }

  static async get(): Promise<SystemSettings> {
    let row = await prisma.systemSettings.findUnique({ where: { id: 1 } });
    if (!row) {
      row = await prisma.systemSettings.upsert({
        where: { id: 1 },
        update: {},
        create: {
          id: 1,
          universityName: SEED_DATA.universityName!,
          universityLogoUrl: SEED_DATA.universityLogoUrl ?? undefined,
          universityAddress: SEED_DATA.universityAddress ?? undefined,
          universityPhone: SEED_DATA.universityPhone ?? undefined,
          universityEmail: SEED_DATA.universityEmail ?? undefined,
          universityWebsite: SEED_DATA.universityWebsite ?? undefined,
          paystackLiveEnabled: SEED_DATA.paystackLiveEnabled!,
          activePaymentGateway: SEED_DATA.activePaymentGateway!,
          largePaymentThreshold: SEED_DATA.largePaymentThreshold ?? undefined,
          importErrorThreshold: SEED_DATA.importErrorThreshold!,
          receiptFooterText: SEED_DATA.receiptFooterText ?? undefined,
          receiptPrefix: SEED_DATA.receiptPrefix!,
          paymentRefPrefix: SEED_DATA.paymentRefPrefix!,
        },
      });
    }
    if (row && !row.activePaymentGateway) {
      // Legacy DB rows (pre-gateway feature) — default to WEMA / ALAT Pay
      row = await prisma.systemSettings.update({
        where: { id: 1 },
        data: { activePaymentGateway: PaymentGateway.ALATPAY },
      });
    }
    return this.ensurePlainTypes(row);
  }

  static async update(
    patch: SystemSettingsPatch,
    opts?: { updatedById?: number },
  ): Promise<SystemSettings> {
    // Validate activePaymentGateway explicitly (if in patch) — reject 400
    if ('activePaymentGateway' in patch && patch.activePaymentGateway !== undefined) {
      patch.activePaymentGateway = validateActivePaymentGatewayValue(patch.activePaymentGateway);
    }
    const before = await this.get();

    const changedKeys: string[] = [];
    const oldValue: Record<string, any> = {};
    const newValue: Record<string, any> = {};

    for (const key of Object.keys(patch) as Array<keyof SystemSettingsPatch>) {
      const val = (patch as any)[key];
      if (val === undefined) continue;
      const beforeVal = (before as any)[key];
      const beforeStr =
        beforeVal instanceof Prisma.Decimal ? beforeVal.toString() : JSON.stringify(beforeVal);
      const valStr = val instanceof Prisma.Decimal ? val.toString() : JSON.stringify(val);
      if (beforeStr !== valStr) {
        changedKeys.push(key);
        (oldValue as any)[key] = beforeVal instanceof Prisma.Decimal ? Number(beforeVal) : beforeVal;
        (newValue as any)[key] = val instanceof Prisma.Decimal ? Number(val) : val;
      }
    }

    const data: any = {};
    for (const k of changedKeys) {
      (data as any)[k] = (patch as any)[k];
    }
    if (opts?.updatedById !== undefined) {
      data.updatedById = opts.updatedById;
    }

    if (Object.keys(data).length === 0) {
      return before;
    }

    const updated = await prisma.systemSettings.update({
      where: { id: 1 },
      data,
    });

    if (changedKeys.length > 0) {
      try {
        await prisma.auditLog.create({
          data: {
            action: 'SYSTEM_SETTINGS_UPDATED',
            entityType: 'SYSTEM_SETTINGS',
            entityId: '1',
            userId: opts?.updatedById ?? null,
            oldValue: changedKeys.length ? (oldValue as Prisma.InputJsonValue) : JSON_DB_NULL,
            newValue: changedKeys.length ? (newValue as Prisma.InputJsonValue) : JSON_DB_NULL,
            details: { changedFields: changedKeys } as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        console.warn('[SystemSettings] audit log failed:', (err as Error)?.message);
      }
    }

    return this.ensurePlainTypes(updated);
  }

  static async getLargePaymentThreshold(): Promise<number> {
    const s = await this.get();
    return s.largePaymentThreshold ? Number(s.largePaymentThreshold) : 500000;
  }

  static async getImportErrorThreshold(): Promise<number> {
    const s = await this.get();
    return s.importErrorThreshold ?? 10;
  }
}

export default SystemSettingsService;
