import type { Request } from 'express';

type ReqLike = Pick<Request, 'headers' | 'ip'>;

export function reqIp(req: ReqLike): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || undefined;
}

export function reqUa(req: ReqLike): string | undefined {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : undefined;
}
