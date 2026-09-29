import React, { useEffect, useRef, useState, useCallback } from 'react';
import { SessionConfig, mapRoleToLogin, type Role } from '../config/session';
import { useAuth } from '../context/AuthContext';

const CHANNEL_NAME = 'app-session-channel';
const IDLE_EVENT_KEY = 'app-idle-broadcast';

type SessionCtrlEvents =
  | { type: 'keepalive'; ts: number }
  | { type: 'show'; ts: number }
  | { type: 'hide'; ts: number }
  | { type: 'stay'; ts: number }
  | { type: 'expired'; ts: number }
  | { type: 'logout'; ts: number }
  | { type: 'reset'; ts: number };

const isBrowser = typeof window !== 'undefined';

const readLoginAt = (): number | null => {
  if (!isBrowser) return null;
  const raw = localStorage.getItem('login_at');
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const formatTime = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
};

const MEANINGFUL_EVENTS: (keyof WindowEventMap)[] = [
  'mousedown',
  'keydown',
  'touchstart',
  'wheel',
  'pointerdown',
];

const SessionInactivityModal: React.FC = () => {
  const auth = useAuth();
  const [visible, setVisible] = useState(false);
  const [remainingMs, setRemainingMs] = useState(SessionConfig.warningCountdownMs);
  const [staying, setStaying] = useState(false);
  const [stayError, setStayError] = useState<string | null>(null);
  const lastActivityAt = useRef<number>(Date.now());
  const warnedRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const tickTimerRef = useRef<number | null>(null);
  const didFireExpired = useRef(false);

  const resetLastActivity = useCallback(
    (ts?: number, remote = false) => {
      const t = ts ?? Date.now();
      lastActivityAt.current = t;
      warnedRef.current = false;
      didFireExpired.current = false;
      setVisible(false);
      setStayError(null);
      if (!remote && channelRef.current) {
        try {
          channelRef.current.postMessage({ type: 'reset', ts: t } satisfies SessionCtrlEvents);
        } catch (_) {
          /* noop */
        }
      }
    },
    [],
  );

  const onMeaningful = useCallback(
    () => {
      resetLastActivity(Date.now(), false);
    },
    [resetLastActivity],
  );

  // Setup broadcast + storage listener for multi-tab consistency
  useEffect(() => {
    if (!isBrowser) return;

    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel(CHANNEL_NAME);
      channelRef.current = ch;
    } catch {
      ch = null;
    }

    const onMsg = (ev: MessageEvent) => {
      const data = ev.data as SessionCtrlEvents;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
      switch (data.type) {
        case 'reset':
        case 'keepalive':
          resetLastActivity(data.ts, true);
          break;
        case 'stay':
          resetLastActivity(data.ts, true);
          break;
        case 'expired':
        case 'logout':
          if (!didFireExpired.current) {
            didFireExpired.current = true;
            setVisible(false);
          }
          break;
        case 'show':
          if (!visible) {
            setRemainingMs(SessionConfig.warningCountdownMs);
            setVisible(true);
          }
          break;
        case 'hide':
          setVisible(false);
          break;
      }
    };
    ch?.addEventListener('message', onMsg);

    const onStorage = (ev: StorageEvent) => {
      if (ev.key === IDLE_EVENT_KEY && ev.newValue) {
        try {
          const parsed = JSON.parse(ev.newValue) as SessionCtrlEvents & { ts: number };
          if (parsed.type === 'reset' || parsed.type === 'keepalive' || parsed.type === 'stay') {
            resetLastActivity(parsed.ts, true);
          }
        } catch (_) {
          /* noop */
        }
      }
      if (ev.key === 'token' && ev.newValue === null) {
        setVisible(false);
      }
    };
    window.addEventListener('storage', onStorage);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        resetLastActivity(Date.now(), true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const listeners: Array<{ ev: keyof WindowEventMap; fn: EventListener }> = [];
    const addSafe = (ev: keyof WindowEventMap) => {
      const fn: EventListener = () => onMeaningful();
      window.addEventListener(ev, fn, { passive: true, capture: true });
      listeners.push({ ev, fn });
    };
    MEANINGFUL_EVENTS.forEach(addSafe);

    return () => {
      ch?.removeEventListener('message', onMsg);
      try {
        ch?.close();
      } catch {
        /* noop */
      }
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibility);
      listeners.forEach(({ ev, fn }) => window.removeEventListener(ev, fn, true));
    };
  }, [onMeaningful, resetLastActivity, visible]);

  // Main idle countdown + warning timer
  useEffect(() => {
    if (!isBrowser) return;
    const TICK = 1000;
    const run = () => {
      if (!auth.isAuthenticated) {
        setVisible(false);
        return;
      }
      const now = Date.now();
      const loginAt = readLoginAt();
      const absoluteElapsed = loginAt ? now - loginAt : 0;
      const idleElapsed = now - lastActivityAt.current;
      const absoluteRemaining = Math.max(0, SessionConfig.absoluteSessionMs - absoluteElapsed);

      // Absolute lifetime: expire regardless of activity
      if (absoluteRemaining <= 0) {
        if (!didFireExpired.current) {
          didFireExpired.current = true;
          try {
            channelRef.current?.postMessage({ type: 'expired', ts: now } satisfies SessionCtrlEvents);
          } catch (_) {
            /* noop */
          }
          void auth.logout('SESSION_EXPIRED').catch(() => {});
          setVisible(false);
        }
        return;
      }

      const warningStartAt = SessionConfig.idleTimeoutMs - SessionConfig.warningCountdownMs;
      if (idleElapsed >= SessionConfig.idleTimeoutMs) {
        if (!didFireExpired.current) {
          didFireExpired.current = true;
          try {
            channelRef.current?.postMessage({ type: 'expired', ts: now } satisfies SessionCtrlEvents);
          } catch (_) {
            /* noop */
          }
          void auth.logout('SESSION_EXPIRED').catch(() => {});
        }
        setVisible(false);
        return;
      }

      if (idleElapsed >= warningStartAt) {
        const leftMs = Math.max(0, SessionConfig.idleTimeoutMs - idleElapsed);
        setRemainingMs(Math.min(leftMs, absoluteRemaining));
        if (!warnedRef.current) {
          warnedRef.current = true;
          setVisible(true);
          setStayError(null);
          try {
            channelRef.current?.postMessage({ type: 'show', ts: now } satisfies SessionCtrlEvents);
          } catch (_) {
            /* noop */
          }
        }
      } else if (warnedRef.current) {
        // remote tab reset activity
        warnedRef.current = false;
        setVisible(false);
      }
    };
    tickTimerRef.current = window.setInterval(run, TICK);
    const t0 = window.setTimeout(run, 100);
    return () => {
      if (tickTimerRef.current) window.clearInterval(tickTimerRef.current);
      window.clearTimeout(t0);
    };
  }, [auth]);

  const handleStay = useCallback(async () => {
    setStaying(true);
    setStayError(null);
    try {
      const ok = await auth.refresh();
      if (ok) {
        const ts = Date.now();
        resetLastActivity(ts, false);
        try {
          channelRef.current?.postMessage({ type: 'stay', ts } satisfies SessionCtrlEvents);
          if (isBrowser) {
            localStorage.setItem(IDLE_EVENT_KEY, JSON.stringify({ type: 'stay', ts }));
          }
        } catch (_) {
          /* noop */
        }
      } else {
        setStayError('Your session has expired. Please sign in again.');
        await auth.logout('SESSION_EXPIRED');
      }
    } catch {
      setStayError('Unable to renew session. Please sign in again.');
      void auth.logout('SESSION_EXPIRED').catch(() => {});
    } finally {
      setStaying(false);
    }
  }, [auth, resetLastActivity]);

  const handleSignOut = useCallback(async () => {
    setVisible(false);
    const role = (auth.user?.role ?? null) as Role | null;
    const loginUrl = mapRoleToLogin(role);
    try {
      channelRef.current?.postMessage({ type: 'logout', ts: Date.now() } satisfies SessionCtrlEvents);
    } catch (_) {
      /* noop */
    }
    try {
      await auth.logout('LOGOUT');
    } catch {
      if (isBrowser && window.location.pathname !== loginUrl) {
        window.location.assign(`${window.location.origin}${loginUrl}`);
      }
    }
  }, [auth]);

  if (!auth.isAuthenticated) return null;
  if (!visible) return null;

  const timeText = formatTime(remainingMs);
  const titleId = 'session-expiry-title';
  const descId = 'session-expiry-desc';
  const countdownId = 'session-expiry-countdown';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-8 bg-black/60 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={`${descId} ${countdownId}`}
    >
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="p-6 sm:p-8">
          <div className="flex items-start gap-4">
            <div className="shrink-0 rounded-full bg-amber-100 p-3 ring-1 ring-amber-200">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6 text-amber-600" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-xl font-semibold text-gray-900">
                Your session is about to expire
              </h2>
              <p id={descId} className="mt-2 text-sm text-gray-600">
                For your security, you will be signed out shortly due to inactivity.
              </p>
              <div
                id={countdownId}
                aria-live="polite"
                aria-atomic="true"
                className="mt-4 inline-flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900"
              >
                <span className="text-sm font-medium text-amber-800">Your session will expire in</span>
                <span className="font-mono text-2xl font-bold tracking-widest tabular-nums" aria-hidden="false">
                  {timeText}
                </span>
              </div>
              {stayError && (
                <div
                  role="alert"
                  className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                >
                  {stayError}
                </div>
              )}
            </div>
          </div>
          <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end sm:gap-3">
            <button
              type="button"
              onClick={handleSignOut}
              disabled={staying}
              className="mt-3 sm:mt-0 inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-1 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              Sign Out Now
            </button>
            <button
              type="button"
              onClick={handleStay}
              disabled={staying}
              className="inline-flex items-center justify-center rounded-lg bg-[var(--brand-primary,#0e74cc)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--brand-primary-hover,#0b64b0)] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:opacity-70 disabled:cursor-not-allowed shadow-sm"
            >
              {staying ? (
                <span className="inline-flex items-center gap-2">
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  Renewing…
                </span>
              ) : (
                'Stay Signed In'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SessionInactivityModal;
