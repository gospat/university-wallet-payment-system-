import { PaymentGateway } from '@prisma/client';
import { IPaymentProvider } from './types';
import { PaystackProvider } from './providers/paystackProvider';
import { AlatpayProvider } from './providers/alatpayProvider';
import prisma from '../../config/database';
import { AppError } from '../../utils/AppError';

const PROVIDER_CACHE: Partial<Record<PaymentGateway, IPaymentProvider>> = {};

export function getPaymentProvider(gateway: PaymentGateway): IPaymentProvider {
  if (PROVIDER_CACHE[gateway]) return PROVIDER_CACHE[gateway]!;
  let instance: IPaymentProvider;
  switch (gateway) {
    case PaymentGateway.PAYSTACK:
      instance = new PaystackProvider();
      break;
    case PaymentGateway.ALATPAY:
      instance = new AlatpayProvider();
      break;
    default:
      throw new AppError(`Unsupported payment gateway: ${gateway}`, 500);
  }
  PROVIDER_CACHE[gateway] = instance;
  return instance;
}

export async function getActiveGatewaySetting(): Promise<PaymentGateway> {
  try {
    const row = await prisma.systemSettings.findUnique({
      where: { id: 1 },
      select: { activePaymentGateway: true },
    });
    if (!row) return PaymentGateway.ALATPAY;
    return row.activePaymentGateway ?? PaymentGateway.ALATPAY;
  } catch {
    return PaymentGateway.ALATPAY;
  }
}

export async function setActiveGatewaySetting(newValue: PaymentGateway, adminId: number): Promise<void> {
  await prisma.systemSettings.upsert({
    where: { id: 1 },
    create: { id: 1, activePaymentGateway: newValue, updatedById: adminId },
    update: { activePaymentGateway: newValue, updatedById: adminId },
  });
}
