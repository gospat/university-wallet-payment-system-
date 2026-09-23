import { Queue, Worker } from 'bullmq';
import redisProxy from '../config/redis';
import { JobTopic } from '../config/queue';

export const queueCaptures: any[] = [];

const _seen = new Set<string>();

export function clearCapturesForTests(): void {
  queueCaptures.length = 0;
  _seen.clear();
}

let _emailQueue: Queue | null = null;

function ensureQueue(): Queue | null {
  if (_emailQueue) return _emailQueue;
  try {
    const q = new Queue('emails', {
      connection: redisProxy as any,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: { count: 5 },
      },
    });
    _emailQueue = q;
    return q;
  } catch {
    return null;
  }
}

export interface DispatchEmailArgs {
  emailType: string;
  recipientId?: number | string;
  reference?: string;
  to: string;
  payload: any;
  idempotencyKey?: string;
}

export async function dispatchEmail(args: DispatchEmailArgs): Promise<void> {
  const { emailType, recipientId, reference, to, payload } = args;
  const idempotencyKey =
    args.idempotencyKey ?? `${emailType}:${reference || 'noref'}:${recipientId || to}`;

  if (process.env.NODE_ENV === 'test') {
    if (_seen.has(idempotencyKey)) {
      return;
    }
    _seen.add(idempotencyKey);
    queueCaptures.push({
      idempotencyKey,
      emailType,
      recipientId,
      reference,
      to,
      payload,
      at: new Date().toISOString(),
    });
    return;
  }

  try {
    const q = ensureQueue();
    if (q) {
      await q.add(
        'dispatch',
        { emailType, recipientId, reference, to, payload },
        {
          jobId: idempotencyKey,
          removeOnComplete: true,
          removeOnFail: { count: 5 },
        },
      );
    }
  } catch (err) {
    console.warn('[emailQueue] enqueue failed (no Redis? queue.add threw):', (err as Error)?.message);
  }
}

function createWorker(): Worker | null {
  if (process.env.NODE_ENV === 'test' || process.env.QUEUE_DISABLE_WORKERS === 'true') {
    return null;
  }
  try {
    const worker = new Worker('emails', async (job) => {
      const { emailType, to, payload } = job.data;
      // Scaffold: register handler via config/queue registerHandler pattern.
      // eslint-disable-next-line no-console
      console.log('[emailQueue] worker scaffold received jobId=', job.id, 'emailType=', emailType, 'to=', to, 'payload=', typeof payload);
      // Actual sendEmail call will be wired to services/email.ts in production bootstrap.
      void payload;
    }, {
      connection: redisProxy as any,
      concurrency: 4,
    } as any);
    worker.on('failed', (job, err) => {
      // eslint-disable-next-line no-console
      console.error('[emailQueue] worker failed jobId=', job?.id, ':', err?.message ?? err);
    });
    return worker;
  } catch {
      return null;
  }
}

let _workerRef = createWorker();
void _workerRef;

export const EMAIL_TOPIC: JobTopic = 'email.send';
