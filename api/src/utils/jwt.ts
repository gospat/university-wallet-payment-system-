/**
 * Module 2 + others — JSON Web Token helpers.
 */
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";
const ACCESS_TTL = Number(process.env.JWT_ACCESS_TTL_SEC ?? 900);
const REFRESH_TTL = Number(process.env.JWT_REFRESH_TTL_SEC ?? 604_800);

export interface AccessClaims {
  userId: number;
  role: string;
  permissions: string[];
  type: "access";
}
export interface RefreshClaims {
  userId: number;
  type: "refresh";
}

export function signAccess(payload: Omit<AccessClaims, "type">): string {
  return jwt.sign({ ...payload, type: "access" as const }, JWT_SECRET, {
    expiresIn: ACCESS_TTL,
  });
}
export function signRefresh(payload: Omit<RefreshClaims, "type">): string {
  return jwt.sign({ ...payload, type: "refresh" as const }, JWT_SECRET, {
    expiresIn: REFRESH_TTL,
  });
}
export function verifyAccess(token: string): AccessClaims {
  return jwt.verify(token, JWT_SECRET) as AccessClaims;
}
export function verifyRefresh(token: string): RefreshClaims {
  return jwt.verify(token, JWT_SECRET) as RefreshClaims;
}
