/**
 * Authentication middleware — decodes bearer JWT and attaches user to req.
 * Also hydrates role + permissions from DB (allows real-time RBAC updates vs JWT age).
 */
import { Request, Response, NextFunction } from "express";
import prisma from "../config/prisma";
import { UnauthorizedError } from "../utils/AppError";
import { verifyAccess } from "../utils/jwt";

export interface ReqUser {
  userId: number;
  role: string;
  permissions: string[];
}
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: ReqUser;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractToken(req);
    if (!token) return next(new UnauthorizedError("Missing authorization bearer token"));
    const claims = verifyAccess(token);
    if (!claims || claims.type !== "access") throw new UnauthorizedError("Invalid access token");

    const user = await prisma.user.findUnique({
      where: { id: claims.userId },
      include: {
        refreshTokens: false,
      },
    });
    if (!user || user.accountStatus !== "ACTIVE") throw new UnauthorizedError("User disabled or not found");

    // Hydrate permissions from DB (via role).
    const rolePerms = await prisma.rolePermission.findMany({
      where: { role: user.role as any },
      include: { permission: true },
    });
    const permissions: string[] =
      rolePerms.map((rp: any) => rp.permission.key).filter(Boolean) ?? [];

    req.user = {
      userId: user.id,
      role: user.role,
      permissions,
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return next();
  return authenticate(req, _res, next);
}
