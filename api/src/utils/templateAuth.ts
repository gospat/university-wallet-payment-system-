import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import prisma from '../config/database';
import { isSuperAdmin, resolveEffectivePermissionsForUser } from '../services/permissionResolver';

const DEFAULT_FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

export type TemplateAuthResult = { ok: boolean; html?: string; forbidden?: boolean };

/**
 * Inline authorization for template-download routes that are mounted BEFORE
 * `protect()` (they support an `?access_token=` query-param flow because a bare
 * browser navigation cannot set an Authorization header).
 *
 * Authorization is BOTH:
 *   · a role boundary (`allowedRoles`) — preserved exactly as before, AND
 *   · a granular capability (`requiredPermission`) resolved LIVE from the
 *     authoritative resolver — so a normal ADMIN with a zero-permission
 *     baseline can no longer download a template merely because role === ADMIN.
 *
 * Only a FLAG-AWARE Super Admin (role === ADMIN && isSuperAdmin === true)
 * bypasses the capability check; it is the single centralised bypass.
 */
export async function assertCanManageTemplates(
  req: Request,
  allowedRoles: string[],
  requiredPermission: string,
  opts?: { frontendUrl?: string }
): Promise<TemplateAuthResult> {
  const frontendUrl = opts?.frontendUrl || DEFAULT_FRONTEND_URL;
  let token: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
  if (!token && typeof (req.query as any).access_token === 'string') {
    token = (req.query as any).access_token as string;
  }
  let userId: number | null = null;
  let userRole: string | null = null;
  let superAdmin = false;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
      if (typeof decoded?.id === 'number') {
        const u = await prisma.user.findUnique({
          where: { id: decoded.id },
          select: { id: true, role: true, accountStatus: true, isSuperAdmin: true },
        });
        if (u && u.accountStatus === 'ACTIVE') {
          userId = u.id;
          userRole = u.role;
          superAdmin = isSuperAdmin({
            id: u.id,
            role: u.role as Role,
            isSuperAdmin: (u as any).isSuperAdmin === true,
          });
        }
      }
    } catch { /* ignore invalid token — fallback to html login link */ }
  }
  if (!userId || !userRole || !allowedRoles.includes(userRole)) {
    const redirect = encodeURIComponent(req.originalUrl);
    const html = `<html><head><title>Login Required</title></head><body style="font-family:system-ui,-apple-system,sans-serif;padding:40px;max-width:600px;margin:auto"><h2 style="color:#b91c1c">Login Required</h2><p>Your session expired. Please <a href="${frontendUrl}/login?redirect=${redirect}" style="color:#2563eb;font-weight:600">click here to log in</a>.</p></body></html>`;
    return { ok: false, html };
  }

  // Granular capability enforcement (role boundary alone is insufficient for a
  // normal restricted ADMIN). Super Admin holds the full registry implicitly.
  if (!superAdmin) {
    let effectivePermissions: string[] = [];
    try {
      effectivePermissions = await resolveEffectivePermissionsForUser({
        id: userId,
        role: userRole as Role,
        isSuperAdmin: false,
      });
    } catch {
      effectivePermissions = []; // fail closed
    }
    if (!effectivePermissions.includes(requiredPermission)) {
      return { ok: false, forbidden: true };
    }
    (req as any).user = { id: userId, role: userRole, isSuperAdmin: false, permissions: effectivePermissions };
    return { ok: true };
  }

  (req as any).user = { id: userId, role: userRole, isSuperAdmin: true, permissions: [] };
  return { ok: true };
}

/** Shared failure responder: 403 JSON for a capability denial, 401 HTML otherwise. */
export function sendTemplateAuthFailure(res: Response, auth: TemplateAuthResult): Response {
  if (auth.forbidden) {
    return res.status(403).json({
      status: 'fail',
      message: 'You do not have permission to download this template.',
      code: 'PERMISSION_REQUIRED',
    });
  }
  return res.status(401).type('text/html').send(auth.html!);
}

export default { assertCanManageTemplates, sendTemplateAuthFailure };
