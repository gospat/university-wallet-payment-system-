/**
 * Module 2 — Auth routes.
 *
 * POST /auth/login          — issues access/refresh JWTs; returns mustChangePassword flag.
 * POST /auth/change-password — authenticated; if mustChangePassword=true, allow even
 *                              if oldPassword omitted (user doesn't know it). Always flips
 *                              mustChangePassword=false on success.
 * POST /auth/refresh        — uses refresh cookie / body token to issue a new access token.
 *
 * Preserved admin ids 1/2/48 use normal flow; no Module 2 code mutates their password rows.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import prisma from "../../config/prisma";
import { authenticate } from "../../middleware/auth";
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from "../../utils/AppError";
import { verifyPassword, hashPassword } from "../../utils/password";
import { signAccess, signRefresh, verifyRefresh } from "../../utils/jwt";
import crypto from "node:crypto";

async function getUserWithPermissions(userId: number) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  const rolePerms = await prisma.rolePermission.findMany({
    where: { role: user.role as any },
    include: { permission: true },
  });
  const permissions: string[] =
    rolePerms
      .map((rp: { permission: { key: string } }) => rp.permission.key)
      .filter(Boolean) ?? [];
  return { user, permissions };
}

const router = Router();

const LoginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

router.get("/me", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new ForbiddenError();
    const full = await getUserWithPermissions(req.user.userId);
    if (!full) throw new NotFoundError("User not found");
    const { user, permissions } = full;
    return res.json({
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          firstName: user.firstName,
          lastName: user.lastName,
          matricNumber: user.matricNumber,
          mustChangePassword: user.mustChangePassword,
          accountStatus: user.accountStatus,
          createdAt: user.createdAt,
          permissions,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedError("Invalid email or password");
    if (user.accountStatus !== "ACTIVE" || (user.lockedUntil && user.lockedUntil > new Date())) {
      throw new UnauthorizedError("Invalid email or password");
    }
    const ok = await verifyPassword(password, user.password);
    if (!ok) throw new UnauthorizedError("Invalid email or password");

    const rolePerms = await prisma.rolePermission.findMany({
      where: { role: user.role as any },
      include: { permission: true },
    });
    const permissions: string[] =
      rolePerms
        .map((rp: { permission: { key: string } }) => rp.permission.key)
        .filter(Boolean) ?? [];

    const access = signAccess({ userId: user.id, role: user.role, permissions });
    const refreshRaw = crypto.randomBytes(24).toString("hex");
    const refreshJwt = signRefresh({ userId: user.id });
    const ttlDays = Number(process.env.JWT_REFRESH_TTL_SEC ?? 604_800) / 86_400;
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshJwt,
        expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
      },
    });

    const userPublic = {
      id: user.id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      matricNumber: user.matricNumber,
      mustChangePassword: user.mustChangePassword,
      permissions,
    };
    return res.status(200).json({
      accessToken: access,
      refreshToken: refreshJwt,
      tokenType: "Bearer",
      expiresIn: Number(process.env.JWT_ACCESS_TTL_SEC ?? 900),
      user: userPublic,
      data: { user: userPublic },
    });
  } catch (err) {
    next(err);
  }
});

const ChangePasswordSchema = z
  .object({
    oldPassword: z.string().optional(),
    newPassword: z.string().min(6),
    confirmPassword: z.string().min(6),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

router.post(
  "/change-password",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();
      const body = ChangePasswordSchema.parse(req.body);
      const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
      if (!user) throw new NotFoundError("User not found");

      // Module 2 gate: if user.mustChangePassword=true, old password not required
      // (they received initial password via email). Otherwise old password required.
      if (!user.mustChangePassword) {
        if (!body.oldPassword) throw new BadRequestError("oldPassword is required");
        const ok = await verifyPassword(body.oldPassword, user.password);
        if (!ok) throw new BadRequestError("oldPassword is incorrect");
      }

      const newHash = await hashPassword(body.newPassword);
      await prisma.user.update({
        where: { id: user.id },
        data: {
          password: newHash,
          mustChangePassword: false, // Flip flag regardless of starting state
        },
      });
      return res.status(200).json({ success: true, mustChangePassword: false });
    } catch (err) {
      next(err);
    }
  }
);

const RefreshSchema = z.object({ refreshToken: z.string().min(1) });
router.post("/refresh", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = RefreshSchema.parse(req.body);
    const claims = verifyRefresh(refreshToken);
    const stored = await prisma.refreshToken.findFirst({
      where: { userId: claims.userId, token: refreshToken, revokedAt: null },
    });
    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedError("Refresh token invalid or expired");
    }
    const user = await prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user || user.accountStatus !== "ACTIVE" || (user.lockedUntil && user.lockedUntil > new Date())) {
      throw new UnauthorizedError("Refresh token invalid or expired");
    }
    const rolePerms = await prisma.rolePermission.findMany({
      where: { role: user.role as any },
      include: { permission: true },
    });
    const permissions: string[] =
      rolePerms
        .map((rp: { permission: { key: string } }) => rp.permission.key)
        .filter(Boolean) ?? [];
    const access = signAccess({
      userId: user.id,
      role: user.role,
      permissions,
    });

    const newRefreshJwt = signRefresh({ userId: user.id });
    const ttlDays = Number(process.env.JWT_REFRESH_TTL_SEC ?? 604_800) / 86_400;
    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          userId: user.id,
          token: newRefreshJwt,
          expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
        },
      }),
    ]);

    const userPublic = {
      id: user.id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      mustChangePassword: user.mustChangePassword,
      permissions,
    };
    res.json({
      accessToken: access,
      refreshToken: newRefreshJwt,
      tokenType: "Bearer",
      expiresIn: Number(process.env.JWT_ACCESS_TTL_SEC ?? 900),
      user: userPublic,
      data: { user: userPublic },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
