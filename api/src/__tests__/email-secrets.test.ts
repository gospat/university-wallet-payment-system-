import {
  renderPaymentSuccessful,
  renderPaymentInitiated,
  renderPaymentFailed,
  renderPaymentReversed,
  renderRefundStatusChanged,
  renderPasswordReset,
  renderStudentAccountCreated,
  renderPaymentReminder,
  sentCaptures,
  sendEmail,
  RenderedEmail,
} from '../services/email';
import {
  dispatchEmail,
  queueCaptures,
  clearCapturesForTests,
} from '../queues/emailQueue';

const noSecretsRegex = (str: string) => {
  expect(str).not.toMatch(/sk_/);
  expect(str).not.toMatch(/pk_/);
  expect(str).not.toMatch(/JWT_/);
  expect(str).not.toMatch(/SMTP_PASS/);
  expect(str).not.toMatch(/\$2[aby]?\$\d{2}\$/);
};

describe('8 email templates render', () => {
  it('renderPaymentSuccessful renders', () => {
    const r = renderPaymentSuccessful({
      studentName: 'Adebola Johnson',
      feeName: 'School Fees 2025/2026',
      amountNgnNumber: 120000,
      reference: 'PAY-ABC-12345',
      receiptNumber: 'RCT-2025-00001',
      receiptDownloadUrl: 'https://example.com/receipt/1',
    });
    expect(r.subject).toContain('Payment Successful');
    expect(r.subject).toContain('PAY-ABC-12345');
    expect(typeof r.html).toBe('string');
    expect(typeof r.text).toBe('string');
    expect(r.html.length).toBeGreaterThan(100);
    expect(r.text.length).toBeGreaterThan(50);
  });

  it('renderPaymentInitiated renders', () => {
    const r = renderPaymentInitiated({
      studentName: 'Adebola Johnson',
      feeName: 'School Fees 2025/2026',
      amountNgnNumber: 120000,
      reference: 'PAY-INIT-001',
    });
    expect(r.subject).toContain('Payment Initiated');
    expect(r.subject).toContain('PAY-INIT-001');
    expect(typeof r.html).toBe('string');
    expect(typeof r.text).toBe('string');
    expect(r.html.length).toBeGreaterThan(50);
    expect(r.text.length).toBeGreaterThan(20);
  });

  it('renderPaymentFailed renders', () => {
    const r = renderPaymentFailed({
      studentName: 'Adebola Johnson',
      reference: 'PAY-FAIL-001',
      attemptDate: '2025-01-15 12:00:00',
    });
    expect(r.subject).toContain('Not Successful');
    expect(r.subject).toContain('PAY-FAIL-001');
    expect(typeof r.html).toBe('string');
    expect(typeof r.text).toBe('string');
    expect(r.html.length).toBeGreaterThan(50);
    expect(r.text.length).toBeGreaterThan(20);
  });

  it('renderPaymentReversed renders', () => {
    const r = renderPaymentReversed({
      studentName: 'Adebola Johnson',
      reference: 'PAY-REV-001',
      amountNgnNumber: 50000,
      reversedAt: '2025-01-15 12:00:00',
    });
    expect(r.subject).toContain('Payment Reversed');
    expect(r.subject).toContain('PAY-REV-001');
    expect(typeof r.html).toBe('string');
    expect(typeof r.text).toBe('string');
    expect(r.html.length).toBeGreaterThan(50);
    expect(r.text.length).toBeGreaterThan(20);
  });

  it('renderRefundStatusChanged renders', () => {
    const r = renderRefundStatusChanged({
      studentName: 'Adebola Johnson',
      reference: 'PAY-REFUND-001',
      refundStatus: 'APPROVED',
      amountNgnNumber: 50000,
    });
    expect(r.subject).toContain('Refund');
    expect(r.subject).toContain('APPROVED');
    expect(r.subject).toContain('PAY-REFUND-001');
    expect(typeof r.html).toBe('string');
    expect(typeof r.text).toBe('string');
    expect(r.html.length).toBeGreaterThan(50);
    expect(r.text.length).toBeGreaterThan(20);
  });

  it('renderPasswordReset renders', () => {
    const r = renderPasswordReset({
      userFirstname: 'Adebola',
      resetUrl: 'https://example.com/reset?token=abc123',
      expiresMinutes: 60,
    });
    expect(r.subject).toBe('Reset your password');
    expect(typeof r.html).toBe('string');
    expect(typeof r.text).toBe('string');
    expect(r.html.length).toBeGreaterThan(50);
    expect(r.text.length).toBeGreaterThan(20);
  });

  it('renderStudentAccountCreated renders', () => {
    const r = renderStudentAccountCreated({
      studentName: 'Adebola Johnson',
      matricNumber: 'UG/2025/0001',
      email: 'adebola@university.edu.ng',
      temporaryPassword: 'TempPass123!',
      portalLoginUrl: 'https://portal.university.edu.ng/login',
    });
    expect(r.subject).toContain('Student Account has been created');
    expect(typeof r.html).toBe('string');
    expect(typeof r.text).toBe('string');
    expect(r.html.length).toBeGreaterThan(50);
    expect(r.text.length).toBeGreaterThan(20);
  });

  it('renderPaymentReminder renders', () => {
    const r = renderPaymentReminder({
      studentName: 'Adebola Johnson',
      feeName: 'School Fees 2025/2026',
      amountNgnNumber: 120000,
      dueDate: '2025-02-01',
      invoiceUrl: 'https://example.com/invoice/1',
      daysLeft: 7,
    });
    expect(r.subject).toContain('Reminder');
    expect(r.subject).toContain('due in 7 days');
    expect(typeof r.html).toBe('string');
    expect(typeof r.text).toBe('string');
    expect(r.html.length).toBeGreaterThan(50);
    expect(r.text.length).toBeGreaterThan(20);
  });
});

describe('secret-leak audit (AC-B2)', () => {
  let templates: RenderedEmail[];

  beforeAll(() => {
    templates = [
      renderPaymentSuccessful({
        studentName: 'Adebola Johnson',
        feeName: 'School Fees',
        amountNgnNumber: 100000,
        reference: 'REF-1',
        receiptNumber: 'RCT-1',
        receiptDownloadUrl: 'https://example.com/r/1',
      }),
      renderPaymentInitiated({
        studentName: 'Adebola Johnson',
        feeName: 'School Fees',
        amountNgnNumber: 100000,
        reference: 'REF-2',
      }),
      renderPaymentFailed({
        studentName: 'Adebola Johnson',
        reference: 'REF-3',
        attemptDate: '2025-01-15',
      }),
      renderPaymentReversed({
        studentName: 'Adebola Johnson',
        reference: 'REF-4',
        amountNgnNumber: 50000,
        reversedAt: '2025-01-15',
      }),
      renderRefundStatusChanged({
        studentName: 'Adebola Johnson',
        reference: 'REF-5',
        refundStatus: 'PENDING',
        amountNgnNumber: 50000,
      }),
      renderPasswordReset({
        userFirstname: 'Adebola',
        resetUrl: 'https://example.com/reset',
      }),
      renderStudentAccountCreated({
        studentName: 'Adebola Johnson',
        matricNumber: 'UG/1',
        email: 'a@b.c',
        temporaryPassword: 'Temp123!',
        portalLoginUrl: 'https://example.com/login',
      }),
      renderPaymentReminder({
        studentName: 'Adebola Johnson',
        feeName: 'School Fees',
        amountNgnNumber: 100000,
        dueDate: '2025-02-01',
        invoiceUrl: 'https://example.com/i/1',
        daysLeft: 5,
      }),
    ];
  });

  it.each(Array.from({ length: 8 }).map((_, i) => [`template ${i + 1}`, i] as const))(
    '%s does not contain secret patterns (sk_ / pk_ / JWT_ / SMTP_PASS / bcrypt)',
    (_, idx) => {
      const r = templates[idx];
      const combined = r.subject + r.html + r.text;
      noSecretsRegex(combined);
    },
  );

  it('sendEmail aborts when injected sk_test_ secret is in payload', async () => {
    const rendered = renderPasswordReset({
      userFirstname: 'Adebola',
      resetUrl: 'https://example.com/reset?token=sk_test_abcdef123456_injected',
    });

    await expect(
      sendEmail({
        to: 'victim@example.com',
        rendered,
      }),
    ).rejects.toThrow(/Email body may contain secrets/);
  });

  it('sendEmail aborts when bcrypt hash pattern is present', async () => {
    const rendered = renderPasswordReset({
      userFirstname: 'Adebola $2a$10$SomeBcryptHashThatShouldNotBeHerexxxxxxxxxxxxxxxxxxxx',
      resetUrl: 'https://example.com/reset',
    });

    await expect(
      sendEmail({
        to: 'victim@example.com',
        rendered,
      }),
    ).rejects.toThrow(/Email body may contain secrets/);
  });

  it('sendEmail captures success for normal templates (json transport)', async () => {
    const beforeCount = sentCaptures.length;
    const rendered = renderPaymentSuccessful({
      studentName: 'Jane Doe',
      feeName: 'Library Fee',
      amountNgnNumber: 5000,
      reference: 'CLEAN-REF-001',
      receiptNumber: 'CLEAN-RCT-001',
      receiptDownloadUrl: 'https://example.com/receipt/clean1',
    });
    const result = await sendEmail({
      to: 'jane@example.com',
      rendered,
    });
    expect(result.success).toBe(true);
    expect(sentCaptures.length).toBeGreaterThan(beforeCount);
  });
});

describe('idempotency (B3.1 NFR-6)', () => {
  beforeEach(() => {
    clearCapturesForTests();
  });

  it('dispatchEmail deduplicates within test env with same idempotency key', async () => {
    const common = {
      emailType: 'payment.successful',
      recipientId: 123,
      reference: 'REF-IDEM-1',
      to: 'student@example.com',
      payload: { foo: 'bar' },
    };

    await dispatchEmail(common);
    await dispatchEmail(common);

    expect(queueCaptures.length).toBe(1);
  });

  it('dispatchEmail allows two different keys through', async () => {
    await dispatchEmail({
      emailType: 'payment.successful',
      recipientId: 1,
      reference: 'REF-A',
      to: 'a@example.com',
      payload: { a: 1 },
    });
    await dispatchEmail({
      emailType: 'payment.successful',
      recipientId: 2,
      reference: 'REF-B',
      to: 'b@example.com',
      payload: { b: 2 },
    });
    expect(queueCaptures.length).toBe(2);
  });
});
