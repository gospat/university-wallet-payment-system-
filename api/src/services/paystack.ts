import axios from 'axios';
import { AppError } from '../utils/AppError';

export class PaystackService {
  private static readonly SECRET_KEY = process.env.PAYSTACK_SECRET_KEY as string;
  private static readonly BASE_URL = 'https://api.paystack.co';

  static async initializeTransaction(email: string, amount: number, metadata: any = {}) {
    // Platform charges logic
    const SERVICE_CHARGE = 2000; // Fixed University Charge
    
    // As requested: Fixed Gateway fee of N2000 instead of calculating percentages
    const paystackFee = 2000;
    
    // Total amount the student needs to pay
    const totalAmount = amount + SERVICE_CHARGE + paystackFee;

    // We pass the breakdown in metadata so we can track it later
    const enhancedMetadata = {
      ...metadata,
      fees: {
        tuition: amount,
        serviceCharge: SERVICE_CHARGE,
        paystackFee: paystackFee,
        total: totalAmount
      }
    };

    try {
      const response = await axios.post(
        `${this.BASE_URL}/transaction/initialize`,
        {
          email,
          amount: Math.ceil(totalAmount * 100), // Convert total to kobo
          metadata: enhancedMetadata,
          reference: metadata.reference,
          // Redirect to Frontend Dashboard to handle verification
          callback_url: process.env.PAYSTACK_CALLBACK_URL || 'http://localhost:5173/student/dashboard',
        },
        {
          headers: {
            Authorization: `Bearer ${this.SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return { ...response.data.data, reference: metadata.reference, feeBreakdown: enhancedMetadata.fees };
    } catch (error: any) {
      throw new AppError(
        `Paystack Initialization Error: ${error.response?.data?.message || error.message}`,
        500
      );
    }
  }

  static async verifyTransaction(reference: string) {
    try {
      const response = await axios.get(
        `${this.BASE_URL}/transaction/verify/${reference}`,
        {
          headers: {
            Authorization: `Bearer ${this.SECRET_KEY}`,
          },
        }
      );

      return response.data.data;
    } catch (error: any) {
      throw new AppError(
        `Paystack Verification Error: ${error.response?.data?.message || error.message}`,
        500
      );
    }
  }
}
