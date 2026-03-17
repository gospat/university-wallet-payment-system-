import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User, Role } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';

const signToken = (id: number, role: Role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET || 'secret', {
    expiresIn: '90d',
  });
};

export class AuthService {
  static async signup(data: any) {
    const { email, password, firstName, lastName, matricNumber, role } = data;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new AppError('Email already exists', 400);
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // Atomic User + Wallet Creation
    const result = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email,
          password: hashedPassword,
          firstName,
          lastName,
          matricNumber,
          role: role || 'STUDENT',
        },
      });

      // Create Wallet for the user
      await tx.wallet.create({
        data: {
          userId: newUser.id,
          balance: 0.0,
        },
      });

      return newUser;
    });

    const token = signToken(result.id, result.role);

    return { user: result, token };
  }

  static async login(data: any) {
    const { email, password } = data;

    if (!email || !password) {
      throw new AppError('Please provide email and password', 400);
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new AppError('Incorrect email or password', 401);
    }

    const token = signToken(user.id, user.role);

    return { user, token };
  }
}
