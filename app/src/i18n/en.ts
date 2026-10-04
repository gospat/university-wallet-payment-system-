export const i18n = {
  portals: {
    student: {
      dashboardBrand: 'University Portal',
    },
  },
  payment: {
    processingVia: 'Processing via',
  },
  paymentResult: {
    confirmPayment: {
      heroTitle: 'Confirm Payment',
      heroSubtitle: 'Review the payment details below before proceeding.',
      ctaCancel: 'Cancel',
      ctaProceed: 'Proceed to Pay',
      feeLabel: 'Fee Name',
      sessionLabel: 'Academic Session',
      studentLabel: 'Student Name',
      matricLabel: 'Matric Number',
      amountLabel: 'Amount Due',
    },
  },
};

export type I18nShape = typeof i18n;
