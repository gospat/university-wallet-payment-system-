import api from './api';

export interface SearchStudentRow {
  id: number;
  firstName: string;
  lastName: string;
  middleName?: string | null;
  matricNumber?: string | null;
  email: string;
  totalOutstanding?: number | string | null;
  totalPaid?: number | string | null;
}

export interface SearchPaymentRow {
  id: number;
  reference: string;
  amount: number | string;
  status: string;
  studentName?: string;
  studentId?: number;
  createdAt?: string;
}

export interface SearchReceiptRow {
  id: number;
  receiptNumber: string;
  amount: number | string;
  studentName?: string;
  studentId?: number;
  createdAt?: string;
}

export interface AdminSearchResponse {
  students: SearchStudentRow[];
  payments: SearchPaymentRow[];
  receipts: SearchReceiptRow[];
}

export const searchAdmin = async (q: string): Promise<AdminSearchResponse> => {
  const res = await api.get<{ data: AdminSearchResponse }>('/admin/search', { params: { q } });
  return res.data.data;
};
