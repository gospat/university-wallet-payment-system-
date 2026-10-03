/**
 * RBAC middleware — permission key gate.
 * Uses Permissions enum keys only. Do NOT introduce new keys.
 */
import { Request, Response, NextFunction } from "express";
import { ForbiddenError, UnauthorizedError } from "../utils/AppError";
import { Permissions } from "../types/permissions";

export function requirePermission(key: Permissions) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError("Authentication required"));
    if (!req.user.permissions.includes(key)) {
      return next(new ForbiddenError(`Missing permission: ${key}`));
    }
    next();
  };
}
export function requireAnyRole(roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError("Authentication required"));
    if (!roles.includes(req.user.role)) return next(new ForbiddenError("Role required"));
    next();
  };
}
