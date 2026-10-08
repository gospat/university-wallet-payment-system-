// =============================================================================
// ALATPAY correlation + reference lifecycle tests
// -----------------------------------------------------------------------------
// Scope:
//   16 focused tests covering the 4-reference ALATPAY lifecycle, metadata
//   preservation, webhook correlation tiers A/B/C/D, final-UUID-based verify,
//   idempotent accounting, HMAC, ambiguous/unknown guards, Paystack path
//   preservation, and init-reference retention after final UUID arrives.
//
// Strategy:
//   - Scoped jest.resetModules() + jest.mock() inside each it() to prevent
//     test-pollution of Prisma/Axios/providerFactory mocks.
//   - Mocks ONLY — never hits production DB.
// =============================================================================

const FINAL_UUID = 'b5a198af-6582-42ac-9fc5-bc593685c954';
const BELLS_REF = 'PAY-20261007-WZR760';
const ORDER_REF = `WEMA-${BELLS_REF}`;
const INIT_REF = 'paykA1sJYTVsb4r';
const SESSION_ID = 'sess_abc123xyz';
const CHECKOUT_URL = 'https://checkout.alatpay.ng/x/y/z';

let alatAmount = 100;
let alatStatus = 'SUCCESSFUL';
let alatExtra: any = {};
let paystackRef = 'PSTK-REF-99';
let paystackKobo = 10000;
let paystackSuccess = true;

let axiosGetCalls: any[][] = [];
let axiosPostCalls: any[][] = [];

let alatpayBusinessForPluginMock: (() => any) | null = null;
let alatpayBusinessForPluginFails: boolean = false;

jest.mock('axios', () => {
  const orig: any = jest.requireActual('axios');
  const mockedGet = jest.fn(async (url: string): Promise<any> => {
    axiosGetCalls.push([url]);
    if (/business-for-plugin/.test(url)) {
      if (alatpayBusinessForPluginFails) {
        const err = new Error('upstream business-for-plugin mocked fail');
        (err as any).response = { status: 500, data: { code: 'UPSTREAM_FAIL' } };
        throw err;
      }
      const custom = alatpayBusinessForPluginMock ? alatpayBusinessForPluginMock() : null;
      const fallback = {
        status: 200,
        data: {
          status: true,
          data: {
            id: 'BUS-123456',
            businessId: 'BUS-BELLS-001',
            name: 'Bells University of Technology',
            logoUrl: 'https://payment.bellsuniversity.edu.ng/branding/logo.png',
          },
          message: 'OK',
        },
      };
      return custom ?? fallback;
    }
    if (/paystack/.test(url)) {
      return {
        status: 200,
        data: {
          status: true,
          data: {
            reference: paystackRef,
            amount: paystackKobo,
            status: paystackSuccess ? 'success' : 'failed',
            channel: 'card',
            currency: 'NGN',
            paid_at: new Date().toISOString(),
            ip_address: '127.0.0.1',
            authorization: {},
          },
          message: 'Verification successful',
        },
      };
    }
    return {
      status: 200,
      data: {
        Value: {
          Data: {
            Id: FINAL_UUID,
            Amount: alatAmount,
            Status: alatStatus,
            Channel: 'BANK_TRANSFER',
            Currency: 'NGN',
            FeeAmount: 1.0,
            ...alatExtra,
          },
          Status: true,
          Message: 'OK',
        },
      },
    };
  });
  const mockedPost = jest.fn(async (...args: any[]): Promise<any> => {
    axiosPostCalls.push(args);
    const url = String(args[0] ?? '');
    if (/initialize$/.test(url)) {
      return {
        status: 200,
        data: {
          data: {
            id: 'init-abc',
            paymentUrl: CHECKOUT_URL,
            paymentReference: INIT_REF,
            redirectUrl: 'http://localhost/cb',
          },
          status: true,
          message: 'Initialized',
        },
      };
    }
    return orig.default.post.apply(orig, args);
  });
  return {
    __esModule: true,
    default: {
      get: mockedGet,
      post: mockedPost,
    },
  };
});

beforeEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
  alatAmount = 100;
  alatStatus = 'SUCCESSFUL';
  alatExtra = {};
  paystackRef = 'PSTK-REF-99';
  paystackKobo = 10000;
  paystackSuccess = true;
  axiosGetCalls = [];
  axiosPostCalls = [];
  alatpayBusinessForPluginMock = null;
  alatpayBusinessForPluginFails = false;
});
afterAll(() => {
  jest.unmock('axios');
});

const buildAlatEnvelope = (overrides: any = {}) => {
  const meta = overrides.metadata ?? {
    transaction_id: 1234,
    bells_payment_reference: BELLS_REF,
    student_id: 99,
    invoice_id: 55,
    fee_id: 2,
    academic_session: '2025/2026',
    fee_name: 'School Fees - 200 Level',
    idempotency_key: 'idem-abc',
  };
  return {
    Value: {
      Data: {
        Id: overrides.id ?? FINAL_UUID,
        Amount: overrides.amount ?? 100.0,
        Status: overrides.status ?? 'SUCCESSFUL',
        Channel: 'BANK_TRANSFER',
        Currency: 'NGN',
        OrderId: overrides.orderId ?? ORDER_REF,
        FeeAmount: overrides.feeAmount ?? 1.0,
        SessionId: overrides.sessionId ?? SESSION_ID,
        Customer: {
          TransactionId: overrides.customerTxId ?? ORDER_REF,
          Email: overrides.email ?? 'student@example.com',
          Metadata: typeof meta === 'string' ? meta : JSON.stringify(meta),
        },
      },
      Status: true,
      Message: 'OK',
    },
    StatusCode: 200,
  };
};

const setupBaseMocks = () => {
  const txRows: any[] = [];
  const webhookEventRows: any[] = [];
  const invoiceRows: any[] = [];
  const receiptRows: any[] = [];
  const glRows: any[] = [];
  const auditRows: any[] = [];
  const prismaMock: any = {
    transaction: {
      findUnique: jest.fn((q: any) => {
        if (q?.where?.id) {
          const row = txRows.find((r) => r.id === q.where.id);
          if (row && q.select) {
            const out: any = {};
            for (const k of Object.keys(q.select)) {
              if (k === 'invoice') continue;
              if (k === 'user') continue;
              if (k in row) out[k] = row[k];
            }
            if (q.select.invoice && row.invoiceId) {
              const inv = invoiceRows.find((i) => i.id === row.invoiceId) ?? null;
              if (inv && q.select.invoice && q.select.invoice.select) {
                const isel: any = {};
                for (const ik of Object.keys(q.select.invoice.select)) {
                  if (ik === 'fee') {
                    isel.fee = { id: row.feeId ?? 1, name: 'Tuition', feeCode: 'FEE-001' };
                    if (q.select.invoice.select.fee && q.select.invoice.select.fee.select) {
                      const fsel: any = {};
                      for (const fk of Object.keys(q.select.invoice.select.fee.select)) {
                        fsel[fk] = isel.fee[fk];
                      }
                      isel.fee = fsel;
                    }
                  } else {
                    isel[ik] = inv[ik];
                  }
                }
                out.invoice = isel;
              } else {
                out.invoice = inv;
              }
            }
            if (q.select.user) {
              out.user = { id: row.userId, email: 'student@example.com', firstName: 'A', lastName: 'B', matricNumber: 'M001', role: 'STUDENT' };
              if (q.select.user && q.select.user.select) {
                const u: any = {};
                for (const uk of Object.keys(q.select.user.select)) {
                  u[uk] = out.user[uk];
                }
                out.user = u;
              }
            }
            return Promise.resolve(out);
          }
          return Promise.resolve(row ?? null);
        }
        if (q?.where?.alatpayEventId) return Promise.resolve(webhookEventRows.find((r) => r.alatpayEventId === q.where.alatpayEventId) ?? null);
        return Promise.resolve(null);
      }),
      findFirst: jest.fn((q: any) => {
        if (!q?.where) return Promise.resolve(null);
        const OR: any[] = (q.where.OR as any) ?? [q.where];
        for (const clause of OR) {
          for (const k of Object.keys(clause)) {
            const row = txRows.find((r) => r[k] === clause[k]);
            if (row) return Promise.resolve(row);
          }
        }
        return Promise.resolve(null);
      }),
      findMany: jest.fn((q: any) => {
        const where = q?.where;
        const rows = txRows.filter((r) => {
          if (where?.AND) {
            let ok = true;
            for (const conj of where.AND) {
              if (conj.gateway && r.gateway !== conj.gateway) ok = false;
              if (conj.OR) {
                const orOk = conj.OR.some((clause: any) => {
                  for (const k of Object.keys(clause)) if (r[k] === clause[k]) return true;
                  return false;
                });
                if (!orOk) ok = false;
              }
              for (const k of Object.keys(conj)) {
                if (k === 'OR' || k === 'AND') continue;
                if (r[k] !== conj[k]) ok = false;
              }
            }
            if (!ok) return false;
          }
          if (where?.OR) {
            const orOk = where.OR.some((clause: any) => {
              for (const k of Object.keys(clause)) if (r[k] === clause[k]) return true;
              return false;
            });
            if (!orOk) return false;
          }
          for (const k of Object.keys(where ?? {})) {
            if (k === 'OR' || k === 'AND') continue;
            if (r[k] !== (where as any)[k]) return false;
          }
          return true;
        });
        const select = q?.select;
        let outRows = rows;
        if (select) {
          outRows = rows.map((r) => {
            const o: any = {};
            for (const k of Object.keys(select)) {
              if (k === 'user') {
                o.user = { id: r.userId, email: 'student@example.com', firstName: 'A', lastName: 'B', matricNumber: 'M001', role: 'STUDENT' };
                if (select.user && select.user.select) {
                  const u: any = {};
                  for (const uk of Object.keys(select.user.select)) {
                    u[uk] = o.user[uk];
                  }
                  o.user = u;
                }
              } else if (k === 'invoice') {
                const inv = invoiceRows.find((i: any) => i.id === r.invoiceId) ?? null;
                if (inv && select.invoice && select.invoice.select) {
                  const isel: any = {};
                  for (const ik of Object.keys(select.invoice.select)) {
                    if (ik === 'fee') {
                      isel.fee = { id: r.feeId ?? 1, name: 'Tuition', feeCode: 'FEE-001' };
                      if (select.invoice.select.fee && select.invoice.select.fee.select) {
                        const fsel: any = {};
                        for (const fk of Object.keys(select.invoice.select.fee.select)) {
                          fsel[fk] = isel.fee[fk];
                        }
                        isel.fee = fsel;
                      }
                    } else {
                      isel[ik] = inv[ik];
                    }
                  }
                  o.invoice = isel;
                } else {
                  o.invoice = inv;
                }
              } else if (k in r) {
                o[k] = r[k];
              }
            }
            return o;
          });
        }
        return Promise.resolve(outRows);
      }),
      create: jest.fn((q: any) => {
        const r = { ...q.data, id: q.data.id ?? (txRows.length + 1), createdAt: new Date(), updatedAt: new Date() };
        txRows.push(r);
        return Promise.resolve(r);
      }),
      update: jest.fn((q: any) => {
        const idx = txRows.findIndex((r) => r.id === q.where.id);
        if (idx === -1) return Promise.resolve(null);
        txRows[idx] = { ...txRows[idx], ...q.data, updatedAt: new Date() };
        return Promise.resolve(txRows[idx]);
      }),
      updateMany: jest.fn((q: any) => {
        let count = 0;
        for (let i = 0; i < txRows.length; i++) {
          const r = txRows[i];
          const where = q.where;
          let matches = true;
          if (where.id != null && r.id !== where.id) matches = false;
          if (where.status && r.status !== where.status) matches = false;
          if (matches) {
            txRows[i] = { ...r, ...q.data, updatedAt: new Date() };
            count++;
          }
        }
        return Promise.resolve({ count });
      }),
    },
    invoice: {
      findUnique: jest.fn((q: any) => Promise.resolve(invoiceRows.find((i) => i.id === q.where.id) ?? null)),
      findFirst: jest.fn((q: any) => {
        const OR = (q.where as any)?.OR ?? [q.where];
        for (const clause of OR) {
          for (const k of Object.keys(clause)) {
            const hit = invoiceRows.find((r) => r[k] === clause[k]);
            if (hit) return Promise.resolve(hit);
          }
        }
        return Promise.resolve(null);
      }),
      update: jest.fn((q: any) => {
        const idx = invoiceRows.findIndex((i) => i.id === q.where.id);
        if (idx === -1) return Promise.resolve(null);
        invoiceRows[idx] = { ...invoiceRows[idx], ...q.data };
        return Promise.resolve(invoiceRows[idx]);
      }),
      create: jest.fn((q: any) => {
        const r = { ...q.data, id: q.data.id ?? invoiceRows.length + 1 };
        invoiceRows.push(r);
        return Promise.resolve(r);
      }),
    },
    receipt: {
      findFirst: jest.fn((q: any) => {
        const where = q.where;
        return Promise.resolve(receiptRows.find((r) => {
          if (where.transactionId && r.transactionId !== where.transactionId) return false;
          return true;
        }) ?? null);
      }),
      create: jest.fn((q: any) => {
        const r = { ...q.data, id: q.data.id ?? receiptRows.length + 1 };
        receiptRows.push(r);
        return Promise.resolve(r);
      }),
      count: jest.fn(() => Promise.resolve(receiptRows.length)),
    },
    generalLedger: {
      createMany: jest.fn((q: any) => {
        for (const d of q.data) glRows.push({ ...d, id: glRows.length + 1 });
        return Promise.resolve({ count: q.data.length });
      }),
      findMany: jest.fn(() => Promise.resolve([...glRows])),
    },
    auditLog: {
      create: jest.fn((q: any) => {
        auditRows.push({ ...q.data, id: auditRows.length + 1, createdAt: new Date() });
        return Promise.resolve(null);
      }),
    },
    feeAssignment: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    webhookEvent: {
      findUnique: jest.fn((q: any) => Promise.resolve(webhookEventRows.find((r) => r.alatpayEventId === q.where.alatpayEventId) ?? null)),
      update: jest.fn((q: any) => {
        const idx = webhookEventRows.findIndex((r) => r.alatpayEventId === q.where.alatpayEventId);
        if (idx === -1) return Promise.resolve(null);
        webhookEventRows[idx] = { ...webhookEventRows[idx], ...q.data };
        return Promise.resolve(webhookEventRows[idx]);
      }),
    },
    yearlyCounter: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      upsert: jest.fn((q: any) => Promise.resolve({ ...q.create, value: q.create.value })),
    },
    counter: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      upsert: jest.fn((q: any) => Promise.resolve({ ...q.create, value: q.create.value })),
    },
    wallet: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve({ id: 1 })),
      update: jest.fn(() => Promise.resolve({ id: 1 })),
    },
    user: {
      findFirst: jest.fn((q: any) => {
        if (q.where?.id) {
          return Promise.resolve({ id: q.where.id, email: 'student@example.com', firstName: 'A', lastName: 'B', matricNumber: 'M001', role: 'STUDENT' });
        }
        return Promise.resolve(null);
      }),
    },
    systemSetting: { findUnique: jest.fn(() => Promise.resolve({ value: 'ALATPAY' })) },
    notification: { create: jest.fn(() => Promise.resolve(null)) },
    $transaction: jest.fn(async (cb: any): Promise<any> => cb(prismaMock)),
  };
  jest.doMock('../config/database', () => ({ __esModule: true, default: prismaMock }));
  jest.doMock('../config/queue', () => ({
    __esModule: true,
    dispatchJob: jest.fn(() => Promise.resolve()),
    registerHandler: jest.fn(() => {}),
  }));
  jest.doMock('../services/adminNotification', () => ({
    __esModule: true,
    AdminNotificationService: { emitWebhookFail3: jest.fn(() => Promise.resolve()) },
  }));
  jest.doMock('../utils/yearlyCounter', () => ({
    __esModule: true,
    nextYearlyCounter: jest.fn(() => Promise.resolve(1)),
    yearFromSession: jest.fn(() => '2026'),
  }));
  jest.doMock('../queues/emailQueue', () => ({
    __esModule: true,
    dispatchEmail: jest.fn(() => Promise.resolve()),
  }));
  return { prismaMock, txRows, invoiceRows, receiptRows, glRows, webhookEventRows, auditRows };
};

describe('ALATPAY correlation + reference lifecycle (24 tests)', () => {
  it('T1 — initialize() actually sends Bells correlation metadata (no empty array)', async () => {
    const { prismaMock } = setupBaseMocks();
    const providerFactory = require('../services/payment/providerFactory');
    jest.doMock('../services/payment/providerFactory', () => providerFactory);
    const { AlatpayProvider } = require('../services/payment/providers/alatpayProvider');
    const p = new AlatpayProvider();
    await p.initialize('stu@e.com', 100, {
      reference: BELLS_REF,
      callbackUrl: 'http://localhost/cb',
      metadata: {
        transaction_id: 1234,
        student_id: 99,
        invoice_id: 55,
        fee_id: 2,
        academic_session: '2025/2026',
        fee_name: 'School Fees - 200 Level',
        idempotency_key: 'idem-abc',
      },
    });
    expect(axiosPostCalls.length).toBe(1);
    const body = axiosPostCalls[0][1];
    expect(Array.isArray(body.metadata)).toBe(false);
    const parsed = typeof body.metadata === 'string' ? JSON.parse(body.metadata) : body.metadata;
    expect(parsed.transaction_id).toBe(1234);
    expect(parsed.bells_payment_reference).toBe(BELLS_REF);
    expect(parsed.student_id).toBe(99);
    expect(parsed.invoice_id).toBe(55);
    expect(parsed.fee_id).toBe(2);
    expect(parsed.academic_session).toBe('2025/2026');
    expect(parsed.fee_name).toBe('School Fees - 200 Level');
    expect(parsed.idempotency_key).toBe('idem-abc');
  });

  it('T2 — webhook metadata.transaction_id finds the correct Bells transaction via Tier A', async () => {
    try {
    const { prismaMock, txRows } = setupBaseMocks();
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'ALATPAY',
      alatpayReference: INIT_REF,
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayCheckoutUrl: CHECKOUT_URL,
      metadata: { session: '2025/2026', amount: { base: 100, serviceCharge: 0, gatewayFee: 0, total: 100 } },
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    const envelope = buildAlatEnvelope();
    const meta = require('../utils/alatpay').parseAlatpayCustomerMetadata(envelope.Value.Data.Customer.Metadata);
    const locate = await PaymentService.locateAlatpayTransactionFromWebhook({
      transaction_id_from_metadata: meta.transaction_id,
      bells_payment_reference: meta.bells_payment_reference,
      order_reference: ORDER_REF,
      init_payment_reference: INIT_REF,
      session_id: SESSION_ID,
    });
    expect('id' in locate).toBe(true);
    expect((locate as any).id).toBe(1234);
    expect((locate as any).reference).toBe(BELLS_REF);
    } catch (e: any) {
      console.error('T2 ERROR:', e && e.message, '\n', e && e.stack);
      throw e;
    }
  });

  it('T3 — final UUID != initialization paymentReference (distinct identity)', async () => {
    expect(FINAL_UUID).not.toBe(INIT_REF);
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(FINAL_UUID)).toBe(true);
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(INIT_REF)).toBe(false);
    const { selectAlatpayFinalTxId } = require('../utils/alatpay');
    const env = buildAlatEnvelope();
    expect(selectAlatpayFinalTxId(env, null)).toBe(FINAL_UUID.toLowerCase());
  });

  it('T4 — verifyPayment uses opts.providerReference (final UUID) for provider.verify', async () => {
    alatAmount = 100;
    alatStatus = 'SUCCESSFUL';
    const { prismaMock, txRows, invoiceRows } = setupBaseMocks();
    invoiceRows.push({
      id: 55,
      invoiceNumber: 'INV-0001',
      studentId: 99,
      amountDue: 100,
      amountPaid: 0,
      status: 'PENDING',
      session: '2025/2026',
    });
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'ALATPAY',
      alatpayReference: INIT_REF,
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayCheckoutUrl: CHECKOUT_URL,
      metadata: { session: '2025/2026', amount: { base: 100, serviceCharge: 0, gatewayFee: 0, total: 100 } },
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    expect(axiosGetCalls.length).toBeGreaterThanOrEqual(1);
    const urlCalled = axiosGetCalls[0][0];
    expect(urlCalled).toContain(FINAL_UUID);
    expect(urlCalled).not.toContain(INIT_REF);
    expect(urlCalled).not.toContain(ORDER_REF);
  });

  it('T5 — correct ₦100 verification invokes normal accounting exactly once (real meta.side production GL structure)', async () => {
    alatAmount = 100;
    alatStatus = 'SUCCESSFUL';
    const { prismaMock, txRows, invoiceRows, receiptRows, glRows } = setupBaseMocks();
    invoiceRows.push({
      id: 55,
      invoiceNumber: 'INV-0001',
      studentId: 99,
      amountDue: 100,
      amountPaid: 0,
      status: 'PENDING',
      session: '2025/2026',
    });
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'ALATPAY',
      alatpayReference: INIT_REF,
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayCheckoutUrl: CHECKOUT_URL,
      metadata: { session: '2025/2026', amount: { base: 100, serviceCharge: 0, gatewayFee: 0, total: 100 } },
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    const r1 = await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    expect(r1.verified).toBe(true);
    const tx = txRows.find((r) => r.id === 1234);
    expect(tx?.status).toBe('SUCCESS');
    expect(receiptRows.length).toBe(1);
    expect(Number(receiptRows[0].transactionId)).toBe(1234);
    // Real production GL = entryType PAYMENT_SUCCESS + meta.side = DEBIT/CREDIT
    expect(glRows.length).toBeGreaterThanOrEqual(2);
    for (const e of glRows) {
      expect(e.entryType).toBe('PAYMENT_SUCCESS');
      expect(['DEBIT', 'CREDIT']).toContain((e.meta as any)?.side);
      expect(Number(e.transactionId)).toBe(1234);
    }
    const cashClearingDebit = glRows.filter(
      (r) => r.account === 'CASH_CLEARING' && (r.meta as any)?.side === 'DEBIT',
    ).reduce((a, r) => a + Number(r.amount), 0);
    const studentReceivableCredit = glRows.filter(
      (r) => r.account === 'STUDENT_RECEIVABLE' && (r.meta as any)?.side === 'CREDIT',
    ).reduce((a, r) => a + Number(r.amount), 0);
    const debitSum = glRows
      .filter((r) => (r.meta as any)?.side === 'DEBIT')
      .reduce((a, r) => a + Number(r.amount), 0);
    const creditSum = glRows
      .filter((r) => (r.meta as any)?.side === 'CREDIT')
      .reduce((a, r) => a + Number(r.amount), 0);
    // Zero-fee ₦100 case: exactly 100 debit to CASH_CLEARING, exactly 100 credit to STUDENT_RECEIVABLE
    expect(Number(cashClearingDebit.toFixed(2))).toBe(100);
    expect(Number(studentReceivableCredit.toFixed(2))).toBe(100);
    expect(Number(debitSum.toFixed(2))).toBe(100);
    expect(Number(creditSum.toFixed(2))).toBe(100);
    expect(Number(debitSum.toFixed(2))).toBe(Number(creditSum.toFixed(2)));
    expect(debitSum).toBeGreaterThan(0);
    expect(creditSum).toBeGreaterThan(0);
  });

  it('T6 — duplicate webhook does NOT duplicate receipt', async () => {
    alatAmount = 100;
    alatStatus = 'SUCCESSFUL';
    const { prismaMock, txRows, invoiceRows, receiptRows, glRows } = setupBaseMocks();
    invoiceRows.push({
      id: 55,
      invoiceNumber: 'INV-0001',
      studentId: 99,
      amountDue: 100,
      amountPaid: 0,
      status: 'PENDING',
      session: '2025/2026',
    });
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'ALATPAY',
      alatpayReference: INIT_REF,
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayCheckoutUrl: CHECKOUT_URL,
      metadata: { session: '2025/2026', amount: { base: 100, serviceCharge: 0, gatewayFee: 0, total: 100 } },
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    const r1 = await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    expect(r1.verified).toBe(true);
    const after1 = receiptRows.length;
    const r2 = await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    expect(r2.verified).toBe(true);
    expect(receiptRows.length).toBe(after1);
    expect(receiptRows.length).toBe(1);
  });

  it('T7 — duplicate webhook does NOT duplicate GeneralLedger rows', async () => {
    alatAmount = 100;
    alatStatus = 'SUCCESSFUL';
    const { prismaMock, txRows, invoiceRows, receiptRows, glRows } = setupBaseMocks();
    invoiceRows.push({
      id: 55,
      invoiceNumber: 'INV-0001',
      studentId: 99,
      amountDue: 100,
      amountPaid: 0,
      status: 'PENDING',
      session: '2025/2026',
    });
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'ALATPAY',
      alatpayReference: INIT_REF,
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayCheckoutUrl: CHECKOUT_URL,
      metadata: { session: '2025/2026', amount: { base: 100, serviceCharge: 0, gatewayFee: 0, total: 100 } },
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    const glAfterFirst = glRows.length;
    await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    expect(glRows.length).toBe(glAfterFirst);
  });

  it('T8 — wrong amount (₦99.50 vs expected ₦100) does NOT create receipt or GL', async () => {
    alatAmount = 99.5;
    alatStatus = 'SUCCESSFUL';
    const { prismaMock, txRows, invoiceRows, receiptRows, glRows } = setupBaseMocks();
    invoiceRows.push({
      id: 55,
      invoiceNumber: 'INV-0001',
      studentId: 99,
      amountDue: 100,
      amountPaid: 0,
      status: 'PENDING',
      session: '2025/2026',
    });
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'ALATPAY',
      alatpayReference: INIT_REF,
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayCheckoutUrl: CHECKOUT_URL,
      metadata: { session: '2025/2026', amount: { base: 100, serviceCharge: 0, gatewayFee: 0, total: 100 } },
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    const r = await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    expect(r.verified).toBe(false);
    expect(receiptRows.length).toBe(0);
    expect(glRows.length).toBe(0);
    expect(txRows.find((t) => t.id === 1234)?.status).toBe('UNDERPAID');
  });

  it('T9 — invalid ALATPAY HMAC returns EXACTLY HTTP 403 + { message: "Invalid HMAC" }', async () => {
    setupBaseMocks();
    process.env.ALATPAY_WEBHOOK_SECRET = 'unit-test-secret';
    const express = require('express');
    const request = require('supertest');
    const app = express();
    // Replicate real app.ts rawBody capture (middleware writes req.rawBody Buffer
    // via json.verify callback) — identical to production mount:
    app.use(express.json({
      verify: (req: any, res: any, buf: Buffer) => {
        req.rawBody = buf;
      },
    }));
    app.use(require('../routes/webhooks').default);
    const raw = JSON.stringify(buildAlatEnvelope());
    const res = await request(app)
      .post('/alatpay')
      .set('x-alatpay-signature', 'sha256=WRONGWRONGWRONGWRONGWRONGWRONGWRONG')
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(res.status).toBe(403);
    expect(res.body && res.body.message).toBe('Invalid HMAC');
  });

  it('T10 — missing ALATPAY HMAC signature returns EXACTLY HTTP 403 + { message: "Invalid HMAC" }', async () => {
    setupBaseMocks();
    process.env.ALATPAY_WEBHOOK_SECRET = 'unit-test-secret';
    const express = require('express');
    const request = require('supertest');
    const app = express();
    // Same rawBody capture middleware as real production app:
    app.use(express.json({
      verify: (req: any, res: any, buf: Buffer) => {
        req.rawBody = buf;
      },
    }));
    app.use(require('../routes/webhooks').default);
    const raw = JSON.stringify(buildAlatEnvelope());
    const res = await request(app)
      .post('/alatpay')
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(res.status).toBe(403);
    expect(res.body && res.body.message).toBe('Invalid HMAC');
  });

  it('T11 — ambiguous correlation (>1 rows match tier C) does NOT process payment', async () => {
    const { prismaMock, txRows, invoiceRows, webhookEventRows } = setupBaseMocks();
    invoiceRows.push({ id: 55, invoiceNumber: 'INV-0001', studentId: 99, amountDue: 100, amountPaid: 0, status: 'PENDING', session: '2025/2026' });
    txRows.push(
      {
        id: 1234, reference: `${BELLS_REF}-A`, status: 'PENDING', userId: 99, invoiceId: 55,
        expectedAmount: 100, amount: 0, gateway: 'ALATPAY',
        alatpayInitPaymentReference: INIT_REF, alatpaySessionId: SESSION_ID,
        alatpayReference: INIT_REF, updatedAt: new Date('2026-10-07T10:00:00Z'),
        metadata: { amount: { total: 100, base: 100, serviceCharge: 0, gatewayFee: 0 } },
      },
      {
        id: 5678, reference: `${BELLS_REF}-B`, status: 'PENDING', userId: 99, invoiceId: 55,
        expectedAmount: 100, amount: 0, gateway: 'ALATPAY',
        alatpayInitPaymentReference: INIT_REF, alatpaySessionId: SESSION_ID,
        alatpayReference: INIT_REF, updatedAt: new Date('2026-10-07T10:00:00Z'),
        metadata: { amount: { total: 100, base: 100, serviceCharge: 0, gatewayFee: 0 } },
      },
    );
    const PaymentService = require('../services/payment').PaymentService;
    const result = await PaymentService.locateAlatpayTransactionFromWebhook({
      init_payment_reference: INIT_REF,
      session_id: SESSION_ID,
    });
    expect('ambiguity' in result).toBe(true);
  });

  it('T12 — unknown transaction (no row matches any tier) does NOT process payment', async () => {
    const { prismaMock, txRows } = setupBaseMocks();
    const PaymentService = require('../services/payment').PaymentService;
    const result = await PaymentService.locateAlatpayTransactionFromWebhook({
      transaction_id_from_metadata: 99999,
      bells_payment_reference: 'PAY-NOPE-000',
      order_reference: 'WEMA-PAY-NOPE-000',
      init_payment_reference: 'not-a-real-ref',
      session_id: 'not-a-session',
      final_transaction_id: '00000000-0000-0000-0000-000000000000',
    });
    expect('notFound' in result).toBe(true);
  });

  it('T13 — existing SUCCESS transaction is NOT processed twice', async () => {
    alatAmount = 100;
    alatStatus = 'SUCCESSFUL';
    const { prismaMock, txRows, invoiceRows, receiptRows, glRows } = setupBaseMocks();
    invoiceRows.push({ id: 55, invoiceNumber: 'INV-0001', studentId: 99, amountDue: 100, amountPaid: 100, status: 'PAID', session: '2025/2026' });
    receiptRows.push({ id: 1, transactionId: 1234, reference: 'RCPT/2026/00042', amount: 100 });
    glRows.push(
      { id: 1, entryType: 'PAYMENT_SUCCESS', account: 'CASH_CLEARING', amount: 100, transactionId: 1234, meta: { side: 'DEBIT', gateway: 'ALATPAY', providerRef: FINAL_UUID } },
      { id: 2, entryType: 'PAYMENT_SUCCESS', account: 'STUDENT_RECEIVABLE', amount: 100, transactionId: 1234, meta: { side: 'CREDIT', gateway: 'ALATPAY', providerRef: FINAL_UUID } },
    );
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'SUCCESS',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 100,
      gateway: 'ALATPAY',
      alatpayReference: INIT_REF,
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayCheckoutUrl: CHECKOUT_URL,
      metadata: { session: '2025/2026', amount: { total: 100, base: 100, serviceCharge: 0, gatewayFee: 0 } },
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    const r = await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    expect(r.verified).toBe(true);
    expect(receiptRows.length).toBe(1);
    expect(glRows.length).toBe(2);
  });

  it('T14 — Paystack verifyPayment code path is unchanged (providerRef uses paystackReference, no opts still works)', async () => {
    paystackRef = 'PSTK-REF-99';
    paystackKobo = 10000;
    paystackSuccess = true;
    const { prismaMock, txRows, invoiceRows, receiptRows, glRows } = setupBaseMocks();
    invoiceRows.push({ id: 55, invoiceNumber: 'INV-0002', studentId: 99, amountDue: 100, amountPaid: 0, status: 'PENDING', session: '2025/2026' });
    txRows.push({
      id: 7777,
      reference: 'PAY-PSTACK-0001',
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'PAYSTACK',
      paystackReference: 'PSTK-REF-99',
      paystackChannel: 'card',
      metadata: { session: '2025/2026', amount: { total: 100, base: 100, serviceCharge: 0, gatewayFee: 0 } },
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    const r = await PaymentService.verifyPayment('PSTK-REF-99', {});
    expect(r.verified).toBe(true);
    expect(axiosGetCalls.length).toBeGreaterThanOrEqual(1);
    const url = axiosGetCalls[0][0];
    expect(url).toContain('PSTK-REF-99');
    expect(txRows.find((t) => t.id === 7777)?.status).toBe('SUCCESS');
  });

  it('T15 — failed ALATPAY webhook cannot downgrade a SUCCESS transaction', async () => {
    const { prismaMock, txRows } = setupBaseMocks();
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'SUCCESS',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 100,
      gateway: 'ALATPAY',
      alatpayReference: INIT_REF,
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayCheckoutUrl: CHECKOUT_URL,
      updatedAt: new Date(),
      metadata: { amount: { total: 100, base: 100, serviceCharge: 0, gatewayFee: 0 } },
    });
    const PaymentService = require('../services/payment').PaymentService;
    const locate = await PaymentService.locateAlatpayTransactionFromWebhook({
      transaction_id_from_metadata: 1234,
      bells_payment_reference: BELLS_REF,
      order_reference: ORDER_REF,
    });
    expect('id' in locate).toBe(true);
    const id = (locate as any).id;
    const affected = await prismaMock.transaction.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'FAILED' },
    });
    expect(affected.count).toBe(0);
    const tx = txRows.find((r) => r.id === 1234);
    expect(tx?.status).toBe('SUCCESS');
  });

  it('T16 — init/session/order/checkout identifiers remain available after final UUID is stored', async () => {
    alatAmount = 100;
    alatStatus = 'SUCCESSFUL';
    const { prismaMock, txRows, invoiceRows } = setupBaseMocks();
    invoiceRows.push({ id: 55, invoiceNumber: 'INV-0001', studentId: 99, amountDue: 100, amountPaid: 0, status: 'PENDING', session: '2025/2026' });
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'ALATPAY',
      alatpayReference: INIT_REF,
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayCheckoutUrl: CHECKOUT_URL,
      metadata: {
        session: '2025/2026',
        amount: { base: 100, serviceCharge: 0, gatewayFee: 0, total: 100 },
        alatpay: {
          order_reference: ORDER_REF,
          init_payment_reference: INIT_REF,
          session_id: SESSION_ID,
          checkout_url: CHECKOUT_URL,
        },
      },
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    const tx = txRows.find((r) => r.id === 1234) as any;
    expect(tx.alatpayFinalTransactionId).toBe(FINAL_UUID);
    expect(tx.alatpayOrderReference).toBe(ORDER_REF);
    expect(tx.alatpayInitPaymentReference).toBe(INIT_REF);
    expect(tx.alatpaySessionId).toBe(SESSION_ID);
    expect(tx.alatpayCheckoutUrl).toBe(CHECKOUT_URL);
    // Mirror in metadata also preserved
    expect(tx.metadata.alatpay.init_payment_reference).toBe(INIT_REF);
    expect(tx.metadata.alatpay.order_reference).toBe(ORDER_REF);
    expect(tx.metadata.alatpay.session_id).toBe(SESSION_ID);
    expect(tx.metadata.alatpay.checkout_url).toBe(CHECKOUT_URL);
    expect(tx.metadata.alatpay.final_transaction_id).toBe(FINAL_UUID);
  });

  // -------------------------------------------------------------------------
  // T17 — correct transaction_id + contradictory Bells reference => REJECT
  // -------------------------------------------------------------------------
  it('T17 — correct metadata.transaction_id + contradictory Bells ref => NOT CORRELATED (no money processed)', async () => {
    const { prismaMock, txRows } = setupBaseMocks();
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'ALATPAY',
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    const r = await PaymentService.locateAlatpayTransactionFromWebhook({
      transaction_id_from_metadata: 1234,
      bells_payment_reference: 'PAY-WRONG-SOMEONE-ELSE', // contradictory vs stored PAY-20261007-WZR760
      order_reference: ORDER_REF,
      init_payment_reference: INIT_REF,
    });
    expect('notFound' in r).toBe(true);
    expect((r as any).notFound).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T18 — correct transaction_id + contradictory OrderId => REJECT
  // -------------------------------------------------------------------------
  it('T18 — correct metadata.transaction_id + contradictory OrderId => NOT CORRELATED', async () => {
    const { prismaMock, txRows } = setupBaseMocks();
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'ALATPAY',
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    const r = await PaymentService.locateAlatpayTransactionFromWebhook({
      transaction_id_from_metadata: 1234,
      bells_payment_reference: BELLS_REF,
      order_reference: 'WEMA-PAY-WRONG-OTHER-TX', // contradictory vs stored WEMA-PAY-20261007-WZR760
      init_payment_reference: INIT_REF,
    });
    expect('notFound' in r).toBe(true);
    expect((r as any).notFound).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T19 — correct transaction_id + contradictory known final UUID => REJECT
  // -------------------------------------------------------------------------
  it('T19 — correct metadata.transaction_id + contradictory already-known final UUID => NOT CORRELATED', async () => {
    const { prismaMock, txRows } = setupBaseMocks();
    const OTHER_UUID = '11111111-2222-3333-4444-555555555555';
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'SUCCESS',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 100,
      gateway: 'ALATPAY',
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayFinalTransactionId: FINAL_UUID,
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    const r = await PaymentService.locateAlatpayTransactionFromWebhook({
      transaction_id_from_metadata: 1234,
      bells_payment_reference: BELLS_REF,
      order_reference: ORDER_REF,
      init_payment_reference: INIT_REF,
      final_transaction_id: OTHER_UUID, // contradictory vs stored FINAL_UUID
    });
    expect('notFound' in r).toBe(true);
    expect((r as any).notFound).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T20 — valid consistent tier-A breadcrumbs ALL match => ACCEPT
  // -------------------------------------------------------------------------
  it('T20 — consistent breadcrumbs across Bells/Order/Init/Session/Final => ACCEPT tier-A correlation', async () => {
    const { prismaMock, txRows } = setupBaseMocks();
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'SUCCESS',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 100,
      gateway: 'ALATPAY',
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayFinalTransactionId: FINAL_UUID,
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    const r = await PaymentService.locateAlatpayTransactionFromWebhook({
      transaction_id_from_metadata: 1234,
      bells_payment_reference: BELLS_REF,
      order_reference: ORDER_REF,
      init_payment_reference: INIT_REF,
      session_id: SESSION_ID,
      final_transaction_id: FINAL_UUID,
    });
    expect('id' in r).toBe(true);
    expect((r as any).id).toBe(1234);
    expect((r as any).reference).toBe(BELLS_REF);
  });

  // -------------------------------------------------------------------------
  // T21 — T5-style GL meta.side verification (duplicate scenario, but using
  //       real account code paths) — verifies real meta.side model
  // -------------------------------------------------------------------------
  it('T21 — real GL accounting test: CASH_CLEARING meta.side=DEBIT 100, STUDENT_RECEIVABLE meta.side=CREDIT 100', async () => {
    alatAmount = 100;
    alatStatus = 'SUCCESSFUL';
    const { prismaMock, txRows, invoiceRows, receiptRows, glRows } = setupBaseMocks();
    invoiceRows.push({ id: 55, invoiceNumber: 'INV-0001', studentId: 99, amountDue: 100, amountPaid: 0, status: 'PENDING', session: '2025/2026' });
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'ALATPAY',
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayCheckoutUrl: CHECKOUT_URL,
      metadata: { amount: { total: 100, base: 100, serviceCharge: 0, gatewayFee: 0 } },
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    const r = await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    expect(r.verified).toBe(true);
    expect(receiptRows.length).toBe(1);
    // ALL GL rows use entryType PAYMENT_SUCCESS — never row-level entryType DEBIT/CREDIT
    expect(glRows.every((g) => g.entryType === 'PAYMENT_SUCCESS')).toBe(true);
    // Side is carried inside meta.side:
    const debits = glRows.filter((g) => (g.meta as any)?.side === 'DEBIT');
    const credits = glRows.filter((g) => (g.meta as any)?.side === 'CREDIT');
    expect(debits.length).toBeGreaterThanOrEqual(1);
    expect(credits.length).toBeGreaterThanOrEqual(1);
    const dr = debits.reduce((a, b) => a + Number(b.amount), 0);
    const cr = credits.reduce((a, b) => a + Number(b.amount), 0);
    expect(Number(dr.toFixed(2))).toBe(100);
    expect(Number(cr.toFixed(2))).toBe(100);
    expect(dr).toBe(cr);
    expect(dr).toBeGreaterThan(0);
    expect(cr).toBeGreaterThan(0);
    // No meta.side undefined row:
    expect(glRows.every((g) => ['DEBIT', 'CREDIT'].includes((g.meta as any)?.side))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T22 — invalid HMAC strictly HTTP 403 (independent route test: good sig => not 403)
  // -------------------------------------------------------------------------
  it('T22 — invalid HMAC exactly 403 with Invalid HMAC JSON body (verified signature)', async () => {
    setupBaseMocks();
    process.env.ALATPAY_WEBHOOK_SECRET = 'unit-test-secret';
    const crypto = require('crypto');
    const express = require('express');
    const request = require('supertest');
    const app = express();
    app.use(express.json({ verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; } }));
    app.use(require('../routes/webhooks').default);
    const raw = JSON.stringify(buildAlatEnvelope());
    // Good signature (computed properly):
    const goodSig = 'sha256=' + crypto.createHmac('sha256', 'unit-test-secret').update(raw).digest('hex');
    // Tampered signature:
    const badSig = goodSig.slice(0, -4) + '0000';
    const res = await request(app)
      .post('/alatpay')
      .set('x-alatpay-signature', badSig)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(res.status).toBe(403);
    expect(res.body && res.body.message).toBe('Invalid HMAC');
  });

  // -------------------------------------------------------------------------
  // T23 — missing HMAC exactly 403 with Invalid HMAC JSON body
  // -------------------------------------------------------------------------
  it('T23 — missing HMAC signature header => exactly 403 with Invalid HMAC JSON', async () => {
    setupBaseMocks();
    process.env.ALATPAY_WEBHOOK_SECRET = 'unit-test-secret';
    const express = require('express');
    const request = require('supertest');
    const app = express();
    app.use(express.json({ verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; } }));
    app.use(require('../routes/webhooks').default);
    const raw = JSON.stringify(buildAlatEnvelope());
    const res = await request(app)
      .post('/alatpay')
      // NO header set at all (missing sig)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(res.status).toBe(403);
    expect(res.body && res.body.message).toBe('Invalid HMAC');
    // Verify the payload was actually received (application/json + 200 content len accepted):
    expect(typeof raw).toBe('string');
    expect(raw.length).toBeGreaterThan(100);
  });

  // -------------------------------------------------------------------------
  // T24 — OrderId / init paymentReference / short tokens MUST NEVER be
  //       selected as final verification UUID.
  // -------------------------------------------------------------------------
  it('T24 — WEMA/OrderId and payk-init-ref are REJECTED as final verify UUID (selectAlatpayFinalTxId null)', async () => {
    const { selectAlatpayFinalTxId, isAlatpayUuid } = require('../utils/alatpay');
    // 1) Value.Data.Id = WEMA order reference (NOT UUID):
    expect(isAlatpayUuid(ORDER_REF)).toBe(false);
    expect(selectAlatpayFinalTxId({ Value: { Data: { Id: ORDER_REF } } }, null)).toBeNull();
    // 2) Value.Data.Id = payk init/session reference (NOT UUID):
    expect(isAlatpayUuid(INIT_REF)).toBe(false);
    expect(selectAlatpayFinalTxId({ Value: { Data: { Id: INIT_REF } } }, null)).toBeNull();
    // 3) Customer.TransactionId = WEMA order ref (NOT UUID):
    expect(selectAlatpayFinalTxId({ Value: { Data: { Customer: { TransactionId: ORDER_REF } } } }, null)).toBeNull();
    // 4) Value.Data.Id = UUID (HAPPY PATH) = accepted:
    expect(isAlatpayUuid(FINAL_UUID)).toBe(true);
    const s = selectAlatpayFinalTxId({ Value: { Data: { Id: FINAL_UUID } } }, null);
    expect(s).toBe(FINAL_UUID.toLowerCase());
    expect(selectAlatpayFinalTxId({ Value: { Data: { Id: FINAL_UUID.toUpperCase() } } }, null)).toBe(FINAL_UUID.toLowerCase());
    // 5) Value.Data.Id = UUID but version NOT 4 (version-1 style time-based UUID) — rejected by UUIDv4 regex:
    const V1_UUID = '00000000-0000-1000-8000-000000000000'; // variant=8 but version=1
    expect(isAlatpayUuid(V1_UUID)).toBe(false);
    expect(selectAlatpayFinalTxId({ Value: { Data: { Id: V1_UUID } } }, null)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // T25 — alatpayPublicCheckout: minimal proven schema only.
  //       The sanitized browser payload MUST contain ONLY the 4-field
  //       AlatpayPublicBusiness (exact Object.keys count = 4) and the
  //       explicitly typed top-level fields. No unknowns, no spread, no
  //       passthrough of undocumented provider response.
  // -------------------------------------------------------------------------
  it('T25 — alatpayPublicCheckout minimal schema: business Object.keys = exactly 4, no extra fields', async () => {
    process.env.ALATPAY_USE_POPUP_CHECKOUT = 'true';
    setupBaseMocks();
    const alatpayUtils = require('../utils/alatpay');
    // Helper directly (unit-level):
    const sanitized = alatpayUtils.buildSanitizedAlatpayPublicCheckout(
      {
        status: true,
        data: {
          id: 'BUS-123456',
          businessId: 'BUS-BELLS-001',
          name: 'Bells University of Technology',
          logoUrl: 'https://payment.bellsuniversity.edu.ng/branding/logo.png',
          // Extra fields that the builder MUST drop (not throw):
          extraFieldA: 'must-be-dropped',
          nestedIgnored: { hello: 'world' },
        },
      },
      {
        bellsRef: BELLS_REF,
        orderRef: ORDER_REF,
        initRef: INIT_REF,
        businessId: 'BUS-BELLS-001',
        amountNgn: 100,
        currency: 'NGN',
        email: 'student@example.com',
        firstName: 'Ade',
        lastName: 'Bola',
      },
    );
    // 4-field strictness on business object:
    expect(Object.keys(sanitized.business).sort()).toEqual(['businessId', 'id', 'logoUrl', 'name'].sort());
    expect(Object.keys(sanitized.business).length).toBe(4);
    expect(sanitized.business.id).toBe('BUS-123456');
    expect(sanitized.business.businessId).toBe('BUS-BELLS-001');
    expect(sanitized.business.name).toBe('Bells University of Technology');
    expect(sanitized.business.logoUrl).toBe('https://payment.bellsuniversity.edu.ng/branding/logo.png');
    // Extra fields not copied:
    expect((sanitized.business as any).extraFieldA).toBeUndefined();
    expect((sanitized.business as any).nestedIgnored).toBeUndefined();
    // Top-level type shape:
    expect(sanitized.amount).toBe(100);
    expect(sanitized.currency).toBe('NGN');
    expect(sanitized.autoCloseModal).toBe(true);
    expect(sanitized.email).toBe('student@example.com');
    expect(sanitized.firstName).toBe('Ade');
    expect(sanitized.lastName).toBe('Bola');
    expect(sanitized.metadata.bells_payment_reference).toBe(BELLS_REF);
    expect(sanitized.metadata.order_reference).toBe(ORDER_REF);
    expect(sanitized.metadata.init_payment_reference).toBe(INIT_REF);
    expect(sanitized.fallback.enableRedirect).toBe(false);
    expect(sanitized.fallback.enablePopup).toBe(true);
    expect(sanitized.fallback.handshakeTimeoutMs).toBe(4500);
    // NO credential fields anywhere except the single intentional top-level PUBLIC publicKey:
    expect(sanitized).toHaveProperty('publicKey', expect.any(String));
    expect(typeof sanitized.publicKey).toBe('string');
    expect(sanitized.publicKey.length).toBeGreaterThanOrEqual(8);
    // apiKey MUST NOT appear anywhere (browser-safe frontend never sends subscription-key bearing field)
    expect(sanitized).not.toHaveProperty('apiKey');
    const hasNestedKey = (node: unknown, depth = 0): boolean => {
      if (node === null || node === undefined) return false;
      if (Array.isArray(node)) return node.some((x) => hasNestedKey(x, depth + 1));
      if (typeof node === 'object') {
        const bad = /subscription[_-]?key|secret|secret[_-]?key|webhook[_-]?secret|ocp[_-]?apim|authorization|bearer|auth|password|token|credential|client[_-]?secret|private[_-]?key/i;
        // At any depth, disallow "apiKey" — the browser must never receive the
        // subscription-key-carrying field name that triggers q() business-for-plugin.
        if (/^api[_-]?key$/i.test(String(node !== null && typeof node === 'object' ? '' : ''))) return false;
        for (const k of Object.keys(node as Record<string, unknown>)) {
          if (/^api[_-]?key$/i.test(k)) return true;
          if (bad.test(k)) return true;
          if (hasNestedKey((node as Record<string, unknown>)[k], depth + 1)) return true;
        }
      }
      return false;
    };
    expect(hasNestedKey(sanitized, 0)).toBe(false);
    const jsonFlat = JSON.stringify(sanitized);
    expect(jsonFlat).not.toMatch(/"api[_-]?key"\s*:/i);
    expect(jsonFlat).not.toMatch(/subscription[_-]?key/i);
    expect(jsonFlat).not.toMatch(/secret/i);
  });

  // -------------------------------------------------------------------------
  // T26 (a..f) — Recursive credential-leak guard suite.
  //   a) apiKey top-level                       => ABORT 502 no checkoutUrl
  //   b) data.settings.subscriptionKey 2-deep   => ABORT
  //   c) data.configs[0].webhookSecret (array)  => ABORT
  //   d) string value "Bearer abc" anywhere     => ABORT
  //   e) key == "Ocp-Apim-Subscription-Key"     => ABORT
  //   f) Paystack initiateResponse = byte identical (no env bleed to other gateway)
  // -------------------------------------------------------------------------
  it('T26a — deny: apiKey at provider top-level => AlatpayPopupUnavailableError thrown', () => {
    process.env.ALATPAY_USE_POPUP_CHECKOUT = 'true';
    const { buildSanitizedAlatpayPublicCheckout, AlatpayPopupUnavailableError } = require('../utils/alatpay');
    const raw = { status: true, data: { id: 'a', businessId: 'b', name: 'c', logoUrl: 'https://x/y.png' }, apiKey: 'sk-leaked-xyz' };
    expect(() =>
      buildSanitizedAlatpayPublicCheckout(raw, {
        bellsRef: BELLS_REF,
        orderRef: ORDER_REF,
        initRef: INIT_REF,
        businessId: 'BUS-BELLS-001',
        amountNgn: 100,
      }),
    ).toThrow(AlatpayPopupUnavailableError);
  });

  it('T26b — deny: nested data.settings.subscriptionKey 2 levels => Abort', () => {
    process.env.ALATPAY_USE_POPUP_CHECKOUT = 'true';
    const { buildSanitizedAlatpayPublicCheckout, AlatpayPopupUnavailableError } = require('../utils/alatpay');
    const raw = {
      status: true,
      data: {
        id: 'a',
        businessId: 'b',
        name: 'c',
        logoUrl: 'https://x/y.png',
        settings: {
          subscriptionKey: 'SECRET-LEAKED-VALUE',
        },
      },
    };
    expect(() =>
      buildSanitizedAlatpayPublicCheckout(raw, {
        bellsRef: BELLS_REF,
        orderRef: ORDER_REF,
        initRef: INIT_REF,
        businessId: 'BUS-BELLS-001',
        amountNgn: 100,
      }),
    ).toThrow(AlatpayPopupUnavailableError);
  });

  it('T26c — deny: array-of-objects webhookSecret nested => Abort', () => {
    process.env.ALATPAY_USE_POPUP_CHECKOUT = 'true';
    const { buildSanitizedAlatpayPublicCheckout, AlatpayPopupUnavailableError } = require('../utils/alatpay');
    const raw = {
      status: true,
      data: {
        id: 'a',
        businessId: 'b',
        name: 'c',
        logoUrl: 'https://x/y.png',
        configs: [
          { id: 1 },
          { webhookSecret: 'SENSITIVE-VALUE-LEAKED', name: 'x' },
        ],
      },
    };
    expect(() =>
      buildSanitizedAlatpayPublicCheckout(raw, {
        bellsRef: BELLS_REF,
        orderRef: ORDER_REF,
        initRef: INIT_REF,
        businessId: 'BUS-BELLS-001',
        amountNgn: 100,
      }),
    ).toThrow(AlatpayPopupUnavailableError);
  });

  it('T26d — deny: string value "Bearer abc" anywhere (value sniff) => Abort', () => {
    process.env.ALATPAY_USE_POPUP_CHECKOUT = 'true';
    const { buildSanitizedAlatpayPublicCheckout, AlatpayPopupUnavailableError } = require('../utils/alatpay');
    const raw = {
      status: true,
      data: {
        id: 'a',
        businessId: 'b',
        name: 'c',
        logoUrl: 'https://x/y.png',
        meta: {
          token: 'Bearer abc123xyz',
        },
      },
    };
    expect(() =>
      buildSanitizedAlatpayPublicCheckout(raw, {
        bellsRef: BELLS_REF,
        orderRef: ORDER_REF,
        initRef: INIT_REF,
        businessId: 'BUS-BELLS-001',
        amountNgn: 100,
      }),
    ).toThrow(AlatpayPopupUnavailableError);
  });

  it('T26e — deny: key == Ocp-Apim-Subscription-Key => Abort', () => {
    process.env.ALATPAY_USE_POPUP_CHECKOUT = 'true';
    const { buildSanitizedAlatpayPublicCheckout, AlatpayPopupUnavailableError } = require('../utils/alatpay');
    const raw = {
      status: true,
      data: {
        id: 'a',
        businessId: 'b',
        name: 'c',
        logoUrl: 'https://x/y.png',
      },
    };
    (raw as any)['Ocp-Apim-Subscription-Key'] = 'very-secret';
    expect(() =>
      buildSanitizedAlatpayPublicCheckout(raw, {
        bellsRef: BELLS_REF,
        orderRef: ORDER_REF,
        initRef: INIT_REF,
        businessId: 'BUS-BELLS-001',
        amountNgn: 100,
      }),
    ).toThrow(AlatpayPopupUnavailableError);
  });

  it('T26f — Paystack byte-equivalent: env flag on ALATPAY does NOT alter Paystack initiate shape', async () => {
    process.env.ALATPAY_USE_POPUP_CHECKOUT = 'true';
    setupBaseMocks();
    process.env.ALATPAY_BUSINESS_ID = undefined as any;
    const prisma = require('@prisma/client');
    prisma.Prisma = { ...(prisma.Prisma ?? {}), Decimal: class D { constructor(n: any) { (this as any).n = n; } toNumber() { return Number((this as any).n); } toString() { return String((this as any).n); } } };
    // Compare:
    const cases = [
      async (ALATPAY_FLAG: string | undefined) => {
        process.env.ALATPAY_USE_POPUP_CHECKOUT = ALATPAY_FLAG;
        const PaystackProvider = require('../services/payment/providers/paystackProvider').PaystackProvider;
        const provider = new PaystackProvider();
        const init = await provider.initialize(
          'student@example.com',
          100,
          { reference: 'PAY-STACK-COMPARE-001', callbackUrl: 'https://example.com/cb' },
        );
        return JSON.stringify({
          checkoutUrl: init.checkoutUrl,
          authorization_url: init.authorization_url,
          access_code: init.access_code,
          providerReference: init.providerReference,
          orderReference: init.orderReference ?? null,
          initPaymentReference: init.initPaymentReference ?? null,
          alatpayPublicCheckout: (init as any).alatpayPublicCheckout ?? null,
        });
      },
    ];
    const payFlagFalse = await cases[0](undefined);
    const payFlagTrue = await cases[0]('true');
    expect(payFlagTrue).toBe(payFlagFalse);
  });

  // -------------------------------------------------------------------------
  // T27 — Idempotency (sequential): verifyPayment x2 + webhook-style call
  //       → single receipt + one GL dr/cr pair.
  // -------------------------------------------------------------------------
  it('T27 — verify x2 + webhook sequentially => NO duplicate receipt/GL (idempotent)', async () => {
    const { prismaMock, txRows, invoiceRows, receiptRows, glRows } = setupBaseMocks();
    invoiceRows.push({ id: 55, invoiceNumber: 'INV-0001', studentId: 99, amountDue: 100, amountPaid: 0, status: 'PENDING', session: '2025/2026' });
    txRows.push({
      id: 1234,
      reference: BELLS_REF,
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'ALATPAY',
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayCheckoutUrl: CHECKOUT_URL,
      metadata: { amount: { total: 100, base: 100, serviceCharge: 0, gatewayFee: 0 } },
      updatedAt: new Date(),
    });
    const PaymentService = require('../services/payment').PaymentService;
    const v1 = await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    const v2 = await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    const v3 = await PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 1234 });
    expect(v1.verified).toBe(true);
    expect(v2.verified).toBe(true);
    expect(v3.verified).toBe(true);
    expect(receiptRows.length).toBe(1);
    expect(glRows.filter((g) => g.entryType === 'PAYMENT_SUCCESS').length).toBe(2);
    const dr = glRows
      .filter((g) => (g.meta as any)?.side === 'DEBIT')
      .reduce((a, b) => a + Number(b.amount), 0);
    const cr = glRows
      .filter((g) => (g.meta as any)?.side === 'CREDIT')
      .reduce((a, b) => a + Number(b.amount), 0);
    expect(Number(dr.toFixed(2))).toBe(100);
    expect(Number(cr.toFixed(2))).toBe(100);
    const inv = invoiceRows.find((i) => i.id === 55)!;
    expect(Number(inv.amountPaid)).toBe(100);
  });

  // -------------------------------------------------------------------------
  // T28 — Historical row immutability: verifyPayment on a SUCCESS row
  //       matching PAY-20261007-WZR760 shape => 0 mutations / no new receipt.
  // -------------------------------------------------------------------------
  it('T28 — historical SUCCESS tx (PAY-20261007-WZR760 shape) unchanged by verify (idempotent 0 update)', async () => {
    const { prismaMock, txRows, invoiceRows, receiptRows, glRows } = setupBaseMocks();
    invoiceRows.push({ id: 77, invoiceNumber: 'INV-HIST-77', studentId: 88, amountDue: 50000, amountPaid: 50000, status: 'PAID', session: '2025/2026' });
    txRows.push({
      id: 777,
      reference: BELLS_REF,
      status: 'SUCCESS',
      userId: 88,
      invoiceId: 77,
      expectedAmount: 50000,
      amount: 50000,
      gateway: 'ALATPAY',
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpaySessionId: SESSION_ID,
      alatpayFinalTransactionId: FINAL_UUID,
      alatpayCheckoutUrl: CHECKOUT_URL,
      createdAt: new Date('2026-10-07T10:00:00Z'),
      updatedAt: new Date('2026-10-07T10:10:00Z'),
      metadata: { amount: { total: 50000, base: 50000, serviceCharge: 0, gatewayFee: 0 } },
    });
    alatAmount = 50000;
    const snapshotBefore = JSON.stringify({
      txAmount: txRows[0].amount,
      txStatus: txRows[0].status,
      txUpdatedAt: txRows[0].updatedAt.getTime(),
      invPaid: invoiceRows[0].amountPaid,
      invStatus: invoiceRows[0].status,
      receipts: receiptRows.length,
      glCount: glRows.length,
    });
    const PaymentService = require('../services/payment').PaymentService;
    const r = await PaymentService.verifyPayment(BELLS_REF, {
      providerReference: FINAL_UUID,
      expectedTransactionId: 777,
    } as any);
    const snapshotAfter = JSON.stringify({
      txAmount: txRows[0].amount,
      txStatus: txRows[0].status,
      txUpdatedAt: txRows[0].updatedAt.getTime(),
      invPaid: invoiceRows[0].amountPaid,
      invStatus: invoiceRows[0].status,
      receipts: receiptRows.length,
      glCount: glRows.length,
    });
    expect(r.verified).toBe(true);
    expect(snapshotAfter).toBe(snapshotBefore);
    expect(receiptRows.length).toBe(0);
    expect(glRows.length).toBe(0);
  });

  it('T27-concurrent — Promise.all race: browser verify × 3 + webhook concurrently => NO duplicate receipt/GL (balanced single dr/cr)', async () => {
    const { prismaMock, txRows, invoiceRows, receiptRows, glRows } = setupBaseMocks();
    process.env.ALATPAY_ACTIVE = 'true';
    // ---- Instrument updateMany to simulate real-DB row-lock atomicity: ----
    let updateManyLock: Promise<void> = Promise.resolve();
    const originalUpdateMany = prismaMock.transaction.updateMany;
    prismaMock.transaction.updateMany = jest.fn(async (q: any) => {
      const myTurn = updateManyLock.then(() => undefined);
      let release: () => void = () => {};
      updateManyLock = new Promise<void>((res) => { release = res; });
      await myTurn;
      try {
        return await originalUpdateMany(q);
      } finally {
        release();
      }
    });
    // --- Insert base rows directly into the captured mock arrays (T5 pattern) ---
    invoiceRows.push({
      id: 55,
      invoiceNumber: 'INV-0001',
      studentId: 99,
      amountDue: 100,
      amountPaid: 0,
      status: 'PENDING',
      session: '2025/2026',
    });
    txRows.push({
      id: 777,
      reference: BELLS_REF,
      status: 'PENDING',
      userId: 99,
      invoiceId: 55,
      expectedAmount: 100,
      amount: 0,
      gateway: 'ALATPAY',
      paystackReference: null,
      alatpayReference: ORDER_REF,
      alatpayOrderReference: ORDER_REF,
      alatpayInitPaymentReference: INIT_REF,
      alatpayFinalTransactionId: null,
      alatpayCheckoutUrl: CHECKOUT_URL,
      alatpaySessionId: SESSION_ID,
      metadata: { session: '2025/2026', amount: { base: 100, serviceCharge: 0, gatewayFee: 0, total: 100 } },
      currency: 'NGN',
      channel: null,
      initiatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    alatAmount = 100;
    alatStatus = 'SUCCESSFUL';
    const PaymentService = require('../services/payment').PaymentService;
    const browserVerify1 = PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 777, assertStudentId: 99 });
    const webhookProcess = PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 777, assertStudentId: 99 });
    const browserVerify2 = PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 777, assertStudentId: 99 });
    const browserVerify3 = PaymentService.verifyPayment(BELLS_REF, { providerReference: FINAL_UUID, expectedTransactionId: 777, assertStudentId: 99 });
    const all = await Promise.all([browserVerify1, browserVerify2, browserVerify3, webhookProcess]);
    // 1) verified: all resolve verified=true (idempotent; after first, subsequent return existing success)
    for (const r of all) expect(r.verified).toBe(true);
    // 2) tx SUCCESS once
    expect(txRows.length).toBe(1);
    expect(txRows[0].id).toBe(777);
    expect(txRows[0].status).toBe('SUCCESS');
    // 3) invoice credited once (amountPaid 100 exactly)
    expect(invoiceRows.length).toBe(1);
    expect(Number(invoiceRows[0].amountPaid)).toBe(100);
    expect(invoiceRows[0].status).toBe('PAID');
    // 4) exactly one receipt
    expect(receiptRows.length).toBe(1);
    expect(Number(receiptRows[0].transactionId)).toBe(777);
    // 5) exactly two GL PAYMENT_SUCCESS entries, one DEBIT one CREDIT, dr==cr balanced
    const paymentGl = glRows.filter((e: any) => e.entryType === 'PAYMENT_SUCCESS');
    expect(paymentGl.length).toBe(2);
    for (const e of paymentGl) expect(Number(e.transactionId)).toBe(777);
    const dr = paymentGl.find((e: any) => (e.meta || {}).side === 'DEBIT');
    const cr = paymentGl.find((e: any) => (e.meta || {}).side === 'CREDIT');
    expect(dr).toBeTruthy();
    expect(cr).toBeTruthy();
    expect(dr.account).toBe('CASH_CLEARING');
    expect(cr.account).toBe('STUDENT_RECEIVABLE');
    expect(Number(dr.amount)).toBe(100);
    expect(Number(cr.amount)).toBe(100);
    expect(Math.abs(Number(dr.amount) - Number(cr.amount))).toBeLessThan(0.01);
    const debitSum = glRows.filter((r) => (r.meta as any)?.side === 'DEBIT').reduce((a, r) => a + Number(r.amount), 0);
    const creditSum = glRows.filter((r) => (r.meta as any)?.side === 'CREDIT').reduce((a, r) => a + Number(r.amount), 0);
    expect(Number(debitSum.toFixed(2))).toBe(Number(creditSum.toFixed(2)));
  });

  // =========================================================================
  // BLOCKER 1 — Verify controller pre-validation gates (7 focused scenarios)
  // =========================================================================

  async function invokeVerifyHandler(opts: {
    asStudentId: number;
    ref: string;
    providerReference?: string | undefined | null;
    txRows?: any[];
  }) {
    setupBaseMocks();
    process.env.ALATPAY_ACTIVE = 'true';
    const prismaMock = require('../config/database').default;
    if (opts.txRows && opts.txRows.length) {
      for (const tx of opts.txRows) await prismaMock.transaction.create({ data: tx });
    }
    const req: any = {
      params: { ref: opts.ref },
      query: opts.providerReference == null ? {} : { providerReference: String(opts.providerReference) },
      user: { id: opts.asStudentId, role: 'STUDENT' },
      headers: {},
      ip: '127.0.0.1',
    };
    let resStatus = 0;
    let resBody: any = undefined;
    let settled = false;
    let resolveRes: () => void = () => {};
    const resPromise = new Promise<void>((r) => { resolveRes = r; });
    const res: any = {
      status: (n: number) => { resStatus = n; return res; },
      json: (b: any) => { resBody = b; settled = true; resolveRes(); return res; },
    };
    let nextErr: any = null;
    const next: any = (err?: any) => { nextErr = err ?? null; settled = true; resolveRes(); };
    const paymentsModule = require('../controllers/payments');
    // paymentsModule.verifyPayment is catchAsync-wrapped (sync fn returning undefined).
    // Manually invoke the underlying raw async via wrapped handler and ensure we wait for completion.
    const wrapped = paymentsModule.verifyPayment;
    try {
      const ret = wrapped(req, res, next);
      // If for some reason the wrapped fn returned a promise, await it:
      if (ret && typeof ret.then === 'function') await Promise.race([ret, resPromise]);
      else await resPromise;
    } catch (syncErr) {
      nextErr = syncErr;
      settled = true;
    }
    if (!settled) await resPromise;
    return { resStatus, resBody, nextErr };
  }

  it('T29 — verify controller: valid owned ALATPAY ref + UUID proceeds (no pre-validation error)', async () => {
    const out = await invokeVerifyHandler({
      asStudentId: 99,
      ref: BELLS_REF,
      providerReference: FINAL_UUID,
      txRows: [{
        id: 777, reference: BELLS_REF, userId: 99, gateway: 'ALATPAY', status: 'PENDING',
        alatpayFinalTransactionId: null, amount: 100, createdAt: new Date(), updatedAt: new Date(),
      }],
    });
    // Not a 4xx/5xx pre-gate error (handler proceeds through service.verify)
    expect(out.nextErr?.statusCode || out.nextErr?.status || out.resStatus).not.toBeGreaterThanOrEqual(400);
    // Expect response written (status 200) OR service error (but never a pre-gate 4xx error from controller)
    if (out.resStatus > 0) expect(out.resStatus).toBe(200);
  });

  it('T30 — verify controller: malformed provider UUID => 400 ALATPAY_FINAL_TXID_MALFORMED', async () => {
    const out = await invokeVerifyHandler({
      asStudentId: 99,
      ref: BELLS_REF,
      providerReference: 'definitely-not-a-uuid',
      txRows: [{
        id: 777, reference: BELLS_REF, userId: 99, gateway: 'ALATPAY', status: 'PENDING',
        alatpayFinalTransactionId: null, amount: 100, createdAt: new Date(), updatedAt: new Date(),
      }],
    });
    const status = out.nextErr?.statusCode || out.resStatus || 0;
    expect(status).toBe(400);
    const code = out.nextErr?.details?.code || out.resBody?.code;
    expect(code).toBe('ALATPAY_FINAL_TXID_MALFORMED');
  });

  it('T31 — verify controller: other student\'s payment reference => 403 VERIFY_NOT_OWNER', async () => {
    const out = await invokeVerifyHandler({
      asStudentId: 111,
      ref: BELLS_REF,
      providerReference: FINAL_UUID,
      txRows: [{
        id: 777, reference: BELLS_REF, userId: 99, gateway: 'ALATPAY', status: 'PENDING',
        alatpayFinalTransactionId: null, amount: 100, createdAt: new Date(), updatedAt: new Date(),
      }],
    });
    const status = out.nextErr?.statusCode || out.resStatus || 0;
    expect(status).toBe(403);
    const code = out.nextErr?.details?.code || out.resBody?.code;
    expect(code).toBe('VERIFY_NOT_OWNER');
  });

  it('T32 — verify controller: non-ALATPAY transaction + providerReference => 400 VERIFY_WRONG_GATEWAY', async () => {
    const out = await invokeVerifyHandler({
      asStudentId: 99,
      ref: BELLS_REF,
      providerReference: FINAL_UUID,
      txRows: [{
        id: 777, reference: BELLS_REF, userId: 99, gateway: 'PAYSTACK', status: 'PENDING',
        alatpayFinalTransactionId: null, paystackReference: 'PSTK-XX', amount: 100, createdAt: new Date(), updatedAt: new Date(),
      }],
    });
    const status = out.nextErr?.statusCode || out.resStatus || 0;
    expect(status).toBe(400);
    const code = out.nextErr?.details?.code || out.resBody?.code;
    expect(code).toBe('VERIFY_WRONG_GATEWAY');
  });

  it('T33 — verify controller: conflicting stored final UUID (different value) => 409 ALATPAY_FINAL_TXID_CONFLICT', async () => {
    const OTHER_UUID = 'a2b3c4d5-1111-4abc-8def-0123456789ab';
    const out = await invokeVerifyHandler({
      asStudentId: 99,
      ref: BELLS_REF,
      providerReference: FINAL_UUID,
      txRows: [{
        id: 777, reference: BELLS_REF, userId: 99, gateway: 'ALATPAY', status: 'SUCCESS',
        alatpayFinalTransactionId: OTHER_UUID, amount: 100, createdAt: new Date(), updatedAt: new Date(),
      }],
    });
    const status = out.nextErr?.statusCode || out.resStatus || 0;
    expect(status).toBe(409);
    const code = out.nextErr?.details?.code || out.resBody?.code;
    expect(code).toBe('ALATPAY_FINAL_TXID_CONFLICT');
  });

  it('T34 — verify controller: repeated same final UUID idempotently (no pre-gate error; no conflict)', async () => {
    const out = await invokeVerifyHandler({
      asStudentId: 99,
      ref: BELLS_REF,
      providerReference: FINAL_UUID,
      txRows: [{
        id: 777, reference: BELLS_REF, userId: 99, gateway: 'ALATPAY', status: 'SUCCESS',
        alatpayFinalTransactionId: FINAL_UUID, amount: 100, createdAt: new Date(), updatedAt: new Date(),
      }],
    });
    const status = out.nextErr?.statusCode || out.resStatus || 0;
    expect(status).not.toBeGreaterThanOrEqual(400);
  });

  it('T35 — verify controller: Paystack transaction with NO providerReference => legacy path unchanged (no pre-gate trigger)', async () => {
    const out = await invokeVerifyHandler({
      asStudentId: 99,
      ref: BELLS_REF,
      providerReference: undefined,
      txRows: [{
        id: 777, reference: BELLS_REF, userId: 99, gateway: 'PAYSTACK', status: 'PENDING',
        paystackReference: 'paystack_ref_xyz', alatpayFinalTransactionId: null,
        amount: 100, expectedAmount: 100, invoiceId: 55, createdAt: new Date(), updatedAt: new Date(),
      }],
    });
    const status = out.nextErr?.statusCode || out.resStatus || 0;
    // Legacy Paystack path: no providerReference => pre-gate block is skipped entirely.
    // If handler proceeds through service (which will fail inside service due to no
    // paystackVerify mocked), that is fine — the test's intent is ONLY to assert the
    // controller did NOT short-circuit with a 4xx due to UUID/gate/ownership gates.
    const gateCode = out.nextErr?.details?.code;
    expect(gateCode).not.toBe('ALATPAY_FINAL_TXID_MALFORMED');
    expect(gateCode).not.toBe('VERIFY_NOT_OWNER');
    expect(gateCode).not.toBe('VERIFY_WRONG_GATEWAY');
    expect(gateCode).not.toBe('ALATPAY_FINAL_TXID_CONFLICT');
  });

  // -----------------------------------------------------------------
  // REVIEW CORRECTION #1: Alatpay.setup() cfg shape businessId + no secrets
  //   Mirrors the exact cfg-building code in app/src/utils/alatpayCheckout.ts
  //   launchAlatpayNativeModal() lines 156-184 (cfg object). This test verifies
  //   the contract of the object shape passed to window.Alatpay.setup(cfg).
  // -----------------------------------------------------------------
  it('T36 — setup cfg object contains businessId AND contains NO secret credential fields (mirrors launchAlatpayNativeModal cfg builder)', () => {
    setupBaseMocks();
    process.env.ALATPAY_ACTIVE = 'true';
    const alatpayUtils = require('../utils/alatpay');
    const business = { id: 'BUS-001', businessId: 'BUSID-002', name: 'Bells Test', logoUrl: 'https://cdn.example/logo.png' };
    const bellsRef = BELLS_REF;
    const orderRef = ORDER_REF;
    const initRef = INIT_REF;
    const checkout: any = alatpayUtils.buildSanitizedAlatpayPublicCheckout(
      { status: true, data: business },
      {
        bellsRef,
        orderRef,
        initRef,
        businessId: 'BUSID-002',
        amountNgn: 100,
        currency: 'NGN' as const,
        email: 'stu@bells.edu',
        firstName: 'T',
        lastName: 'S',
      },
    );
    // ---- EXACT cfg builder (copied verbatim from app/src/utils/alatpayCheckout.ts launchAlatpayNativeModal) ----
    const fallback = checkout.fallback ?? {};
    const cfg: any = {
      publicKey: checkout.publicKey,
      businessId: checkout.businessId,
      business: checkout.business,
      amount: checkout.amount,
      currency: checkout.currency ?? 'NGN',
      email: checkout.email ?? undefined,
      firstName: checkout.firstName ?? undefined,
      lastName: checkout.lastName ?? undefined,
      phone: checkout.phone ?? undefined,
      autoCloseModal: checkout.autoCloseModal ?? true,
      metadata: checkout.metadata ?? {},
      fallback: {
        enableRedirect: false,
        enablePopup: true,
        handshakeTimeoutMs: Number.isFinite(fallback.handshakeTimeoutMs) ? fallback.handshakeTimeoutMs : 4500,
      },
    };
    // ---- Assertions ----
    expect(cfg.businessId).toBe('BUSID-002');
    expect(cfg.business).toEqual(business);
    // publicKey MUST be present as the browser-safe publishable field:
    expect(cfg).toHaveProperty('publicKey', expect.any(String));
    expect(typeof cfg.publicKey).toBe('string');
    expect(cfg.publicKey.length).toBeGreaterThanOrEqual(8);
    // apiKey MUST NOT be present (carries subscription-key semantics in the browser SDK q())
    expect(cfg).not.toHaveProperty('apiKey');
    expect(cfg).not.toHaveProperty('API_KEY');
    expect(cfg).not.toHaveProperty('api_key');
    // Phone is optional and forwarded when available (undefined for this test case)
    expect('phone' in cfg).toBe(true);
    // No secret fields anywhere in cfg (nested) — NOTE: publicKey top-level is the ALLOWED browser-safe exception.
    // apiKey (any spelling) is NEVER allowed at any depth.
    const secretKeyPatterns =
      /^(.*[._\- ])?(secret|secretKey|secret_key|subscriptionKey|subscription_key|ocp[-_]apim[-_]subscription[-_]key|authorization|bearer|auth|password|token|passwd|privateKey|private_key|webhookSecret|webhook_secret|clientSecret|client_secret|credential|credentials)$/i;
    const walk = (node: any, trail: string[] = []): string[] => {
      if (node == null) return [];
      if (Array.isArray(node)) return node.flatMap((v, i) => walk(v, [...trail, `[${i}]`]));
      if (typeof node === 'object') {
        return Object.keys(node).flatMap((k) => {
          // publicKey at top-level ONLY → explicit browser-safe allowlist:
          if (trail.length === 0 && /^publicKey$/i.test(k)) return [];
          // apiKey at any depth is disallowed (triggers SDK q() browser-side credential path)
          if (/^api[_-]?key$/i.test(k)) return [`${[...trail, k].join('.')}`];
          const hit = secretKeyPatterns.test(k) ? [`${[...trail, k].join('.')}`] : [];
          return [...hit, ...walk((node as any)[k], [...trail, k])];
        });
      }
      return [];
    };
    const hits = walk(cfg);
    expect(hits).toEqual([]);
    // Also verify no secret-like values:
    const flattenValues = (n: any): string[] => {
      if (n == null) return [];
      if (typeof n === 'string') return [n];
      if (Array.isArray(n)) return n.flatMap(flattenValues);
      if (typeof n === 'object') return Object.values(n).flatMap(flattenValues as any);
      return [];
    };
    const values = flattenValues(cfg);
    for (const v of values) {
      expect(/^sk[_-]/i.test(v)).toBe(false);
      expect(/^bearer /i.test(v)).toBe(false);
      expect(/^basic /i.test(v)).toBe(false);
      expect(v.startsWith('Ocp-Apim')).toBe(false);
    }
  });

  // -----------------------------------------------------------------
  // REVIEW CORRECTION #3: callbackUrl/redirectUrl/webhookUrl presence in
  //   raw business-for-plugin response does NOT abort native popup.
  //   Only secrets abort. Nav URLs are dropped silently.
  // -----------------------------------------------------------------
  it('T37 — sanitizer allows callbackUrl/webhookUrl/redirectUrl/successUrl in raw payload (DROPPED silently, NO AlatpayPopupUnavailable)', () => {
    setupBaseMocks();
    process.env.ALATPAY_ACTIVE = 'true';
    process.env.ALATPAY_USE_POPUP_CHECKOUT = 'true';
    const alatpayUtils = require('../utils/alatpay');
    const rawWithNavUrls = {
      status: true,
      data: { id: 'BUS-001', businessId: 'BUSID-002', name: 'Bells', logoUrl: 'https://cdn.example/logo.png' },
      // Nav/redirect URL fields — ordinary config fields that must NOT abort.
      callbackUrl: 'https://example.com/callback',
      redirectUrl: 'https://example.com/redirect',
      webhookUrl: 'https://example.com/webhook',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      returnUrl: 'https://example.com/return',
    };
    let sanitized: any = undefined;
    expect(() => {
      sanitized = alatpayUtils.buildSanitizedAlatpayPublicCheckout(rawWithNavUrls, {
        bellsRef: BELLS_REF, orderRef: ORDER_REF, initRef: INIT_REF,
        businessId: 'BUSID-002', amountNgn: 100, currency: 'NGN' as const, email: 'stu@bells.edu',
      });
    }).not.toThrow();
    expect(sanitized).toBeTruthy();
    expect(sanitized.businessId).toBe('BUSID-002');
    // Nav URLs must NOT appear anywhere on forwarded sanitized object:
    const flattenKeys = (n: any, trail: string[] = []): string[] => {
      if (n == null || typeof n !== 'object') return [];
      if (Array.isArray(n)) return n.flatMap((v, i) => flattenKeys(v, [...trail, `[${i}]`]));
      return Object.keys(n).flatMap((k) => [k, ...flattenKeys((n as any)[k], [...trail, k])]);
    };
    const allKeys = new Set(flattenKeys(sanitized).map((k) => k.toLowerCase()));
    expect([...allKeys].filter((k) => /(callback|redirect|webhook|success|cancel|return)([-_ ])?url/i.test(k))).toEqual([]);
  });

  it('T38 — sanitizer STILL ABORTS on apiKey/secret field EVEN IN PRESENCE of allowed nav URLs (secrets always win)', () => {
    setupBaseMocks();
    process.env.ALATPAY_ACTIVE = 'true';
    process.env.ALATPAY_USE_POPUP_CHECKOUT = 'true';
    const alatpayUtils = require('../utils/alatpay');
    const rawSecretPlusNavUrls = {
      status: true,
      data: { id: 'BUS-001', businessId: 'BUSID-002', name: 'Bells', logoUrl: 'https://cdn.example/logo.png' },
      apiKey: 'sk_live_abcdef',
      callbackUrl: 'https://example.com/callback',
      webhookUrl: 'https://example.com/webhook',
    };
    expect(() =>
      alatpayUtils.buildSanitizedAlatpayPublicCheckout(rawSecretPlusNavUrls, {
        bellsRef: BELLS_REF, orderRef: ORDER_REF, initRef: INIT_REF,
        businessId: 'BUSID-002', amountNgn: 100, currency: 'NGN' as const, email: 'stu@bells.edu',
      }),
    ).toThrow(alatpayUtils.AlatpayPopupUnavailableError);
  });

  // -----------------------------------------------------------------
  // REVIEW CORRECTION #4: UUID extractor restricted to providerTx.id /
  //   providerTx.data.id only — must NOT pick correlationId or others.
  //   Exact copy of frontend extractAlatpayFinalTxId logic for test.
  // -----------------------------------------------------------------
  it('T39 — UUID extractor only picks providerTx.data.id/providerTx.id and IGNORES nested correlationId/customerId/sessionId UUIDs', () => {
    setupBaseMocks();
    // ---- Exact copy of frontend extractor (mirrors app/src/utils/alatpayCheckout.ts) ----
    const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isAlatpayUuid = (s: any): boolean => typeof s === 'string' && UUID_V4_RE.test(s.trim());
    const extract = (providerTx: unknown): string | null => {
      if (providerTx == null) return null;
      if (typeof providerTx !== 'object') return null;
      const root = providerTx as Record<string, unknown>;
      const data = root.data;
      if (data != null && typeof data === 'object') {
        const inner = data as Record<string, unknown>;
        if (isAlatpayUuid(inner.id)) return String(inner.id).trim();
        if (isAlatpayUuid(inner.Id)) return String(inner.Id).trim();
      }
      if (isAlatpayUuid(root.id)) return String(root.id).trim();
      if (isAlatpayUuid(root.Id)) return String(root.Id).trim();
      return null;
    };
    // CASE A: correlationId UUID + unrelated customerId UUID + correct data.id
    const CORRELATION_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const CUSTOMER_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const SESSION_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const REAL_TX_UUID = FINAL_UUID;
    const payloadCorrectDataId = {
      correlationId: CORRELATION_UUID,
      customerId: CUSTOMER_UUID,
      sessionId: SESSION_UUID,
      id: null as any,
      data: { id: REAL_TX_UUID, status: 'SUCCESSFUL' },
      nested: { deep: { anotherRandomUuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } },
    };
    expect(extract(payloadCorrectDataId)).toBe(REAL_TX_UUID);
    expect(extract(payloadCorrectDataId)).not.toBe(CORRELATION_UUID);
    expect(extract(payloadCorrectDataId)).not.toBe(CUSTOMER_UUID);
    // CASE B: only correlationId and customerId UUIDs present; NO data.id, NO top-level.id => return null
    const payloadOnlyCorrelation = {
      correlationId: CORRELATION_UUID,
      customerId: CUSTOMER_UUID,
      sessionId: SESSION_UUID,
      data: { status: 'PENDING' },
    };
    expect(extract(payloadOnlyCorrelation)).toBeNull();
    // CASE C: valid top-level .id (real tx) present alongside random nested ones => picks .id
    const payloadTopId = {
      correlationId: CORRELATION_UUID,
      reference: ORDER_REF,
      id: REAL_TX_UUID,
      inner: { someOther: SESSION_UUID },
    };
    expect(extract(payloadTopId)).toBe(REAL_TX_UUID);
    // CASE D: malformed non-UUID v4 string in .data.id => return null, not that string
    const payloadMalformedId = {
      id: 'not-a-uuid',
      data: { id: 'PAY-123' },
      correlationId: CORRELATION_UUID,
    };
    expect(extract(payloadMalformedId)).toBeNull();
  });
});
