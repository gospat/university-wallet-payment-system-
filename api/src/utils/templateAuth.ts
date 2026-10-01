import { Request } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';

const DEFAULT_FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

export async function assertCanManageTemplates(
  req: Request,
  allowedRoles: string[],
  opts?: { frontendUrl?: string }
): Promise<{ ok: boolean; html?: string }> {
  const frontendUrl = opts?.frontendUrl || DEFAULT_FRONTEND_URL;
  let token: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
  if (!token && typeof (req.query as any).access_token === 'string') {
    token = (req.query as any).access_token as string;
  }
  let userId: number | null = null;
  let userRole: string | null = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
      if (typeof decoded?.id === 'number') {
        const u = await prisma.user.findUnique({ where: { id: decoded.id }, select: { id: true, role: true, accountStatus: true } });
        if (u && u.accountStatus === 'ACTIVE') { userId = u.id; userRole = u.role; }
      }
    } catch { /* ignore invalid token — fallback to html login link */ }
  }
  if (!userId || !userRole || !allowedRoles.includes(userRole)) {
    const redirect = encodeURIComponent(req.originalUrl);
    const html = `<html><head><title>Login Required</title></head><body style="font-family:system-ui,-apple-system,sans-serif;padding:40px;max-width:600px;margin:auto"><h2 style="color:#b91c1c">Login Required</h2><p>Your session expired. Please <a href="${frontendUrl}/login?redirect=${redirect}" style="color:#2563eb;font-weight:600">click here to log in</a>.</p></body></html>`;
    return { ok: false, html };
  }
  (req as any).user = { id: userId, role: userRole };
  return { ok: true };
}

export default { assertCanManageTemplates };
