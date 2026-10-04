import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { createBullmqProducerConnection, createBullmqWorkerConnection } from '../config/redis';
import prisma from '../config/database';
import { dispatchReportExport, SyncExportResult } from '../services/reportExport';
import { dispatchEmail } from './emailQueue';
import { computeNextRunAt } from '../config/queue';
import { buildFiltersSummaryString } from '../services/reportExport/pdf';
import type {
  ScheduledReport, ReportType, ReportExportFormat, User,
  ScheduleReportFrequency, ReportExportStatus,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

export const queueCaptures: any[] = [];

let _reportsSchedulerQueue: Queue | null = null;
let _reportsSchedulerProducerRedis: InstanceType<typeof Redis> | null = null;
let _reportsSchedulerWorkerRedis: InstanceType<typeof Redis> | null = null;
let _reportsSchedulerWorker: Worker | null = null;

const LAZY = process.env.REDIS_LAZY_CONNECT === 'true' || process.env.QUEUE_DISABLE_WORKERS === 'true' || process.env.NODE_ENV === 'test';

function ensureSchedulerQueue(): Queue | null {
  if (_reportsSchedulerQueue) return _reportsSchedulerQueue;
  try {
    if (!_reportsSchedulerProducerRedis) {
      _reportsSchedulerProducerRedis = createBullmqProducerConnection({
        maxRetriesPerRequest: LAZY ? 0 : 1,
        enableReadyCheck: !LAZY,
        connectTimeout: LAZY ? 400 : 1500,
        commandTimeout: LAZY ? 600 : 2000,
        lazyConnect: true,
        retryStrategy: () => null,
      });
      if (!LAZY) {
        _reportsSchedulerProducerRedis.connect().catch(() => { /* inline fallback */ });
      }
    }
    const q = new Queue('report.scheduled', {
      connection: _reportsSchedulerProducerRedis,
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
    _reportsSchedulerQueue = q;
    return q;
  } catch {
    return null;
  }
}

export type ScheduledPresetType =
  | 'DAILY_COLLECTION_SUMMARY'
  | 'WEEKLY_COLLECTION'
  | 'MONTHLY_REVENUE'
  | 'MONTHLY_RECONCILIATION'
  | 'OUTSTANDING_PAYMENTS';

export interface DateRange {
  dateFrom: Date;
  dateTo: Date;
  label: string;
}

export function presetToReportType(preset: ScheduledPresetType | string): ReportType {
  switch (String(preset).toUpperCase()) {
    case 'DAILY_COLLECTION_SUMMARY': return 'DAILY_COLLECTIONS';
    case 'WEEKLY_COLLECTION': return 'MONTHLY_COLLECTIONS';
    case 'MONTHLY_REVENUE': return 'REVENUE_BY_BILL';
    case 'MONTHLY_RECONCILIATION': return 'SETTLEMENT';
    case 'OUTSTANDING_PAYMENTS': return 'OUTSTANDING_DEBTORS';
    default: return preset as ReportType;
  }
}

export function computeDateRangeForFrequency(frequency: ScheduleReportFrequency | string, refDate: Date = new Date()): DateRange {
  const d = new Date(refDate);
  const freq = String(frequency).toUpperCase();
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  switch (freq) {
    case 'DAILY': {
      const yesterday = new Date(startOfDay);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayEnd = new Date(endOfDay);
      yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
      const yyyy = yesterday.getFullYear();
      const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
      const dd = String(yesterday.getDate()).padStart(2, '0');
      return { dateFrom: yesterday, dateTo: yesterdayEnd, label: `${yyyy}-${mm}-${dd} (Yesterday)` };
    }
    case 'WEEKLY':
    case 'BIWEEKLY': {
      const lastMonday = new Date(startOfDay);
      const dayOfWeek = lastMonday.getDay() === 0 ? 6 : lastMonday.getDay() - 1;
      lastMonday.setDate(lastMonday.getDate() - dayOfWeek - 7);
      const lastSunday = new Date(lastMonday);
      lastSunday.setDate(lastSunday.getDate() + 6);
      lastSunday.setHours(23, 59, 59, 999);
      return {
        dateFrom: lastMonday, dateTo: lastSunday,
        label: `Week ${lastMonday.toISOString().slice(0, 10)} → ${lastSunday.toISOString().slice(0, 10)}`,
      };
    }
    case 'MONTHLY':
    case 'QUARTERLY': {
      const firstOfPrevMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1, 0, 0, 0, 0);
      const lastOfPrevMonth = new Date(d.getFullYear(), d.getMonth(), 0, 23, 59, 59, 999);
      const yyyy = firstOfPrevMonth.getFullYear();
      const mm = String(firstOfPrevMonth.getMonth() + 1).padStart(2, '0');
      return {
        dateFrom: firstOfPrevMonth, dateTo: lastOfPrevMonth,
        label: `${yyyy}-${mm} (Previous Month)`,
      };
    }
    case 'CUSTOM_CRON':
    default: {
      return { dateFrom: startOfDay, dateTo: endOfDay, label: startOfDay.toISOString().slice(0, 10) };
    }
  }
}

export function resolveReportType(scheduled: ScheduledReport): ReportType {
  const rt = String(scheduled.reportType);
  const presetUpper = rt.toUpperCase();
  if (presetUpper === 'DAILY_COLLECTION_SUMMARY' || presetUpper === 'WEEKLY_COLLECTION'
    || presetUpper === 'MONTHLY_REVENUE' || presetUpper === 'MONTHLY_RECONCILIATION'
    || presetUpper === 'OUTSTANDING_PAYMENTS') {
    return presetToReportType(presetUpper);
  }
  return scheduled.reportType;
}

function formatFiltersHumanReadable(filters: any, dateRange: DateRange): string {
  const base = buildFiltersSummaryString({ ...(filters || {}), dateFrom: dateRange.dateFrom, dateTo: dateRange.dateTo });
  return base || 'No additional filters';
}

function buildEmailBody(params: {
  scheduledName: string;
  dateRangeLabel: string;
  totalRows: number;
  filtersText: string;
}): string {
  const { scheduledName, dateRangeLabel, totalRows, filtersText } = params;
  return `
<p>Good day,</p>
<p>Please find attached your scheduled report from the Bursary Department:</p>
<table cellpadding="8" cellspacing="0" border="0" style="border-collapse:collapse;">
  <tr><td style="background:#f0f4ff;font-weight:bold;width:180px;">Report</td><td>${String(scheduledName).replace(/</g, '&lt;')}</td></tr>
  <tr><td style="background:#f0f4ff;font-weight:bold;">Reporting Period</td><td>${dateRangeLabel.replace(/</g, '&lt;')}</td></tr>
  <tr><td style="background:#f0f4ff;font-weight:bold;">Total Rows</td><td>${totalRows.toLocaleString()}</td></tr>
  <tr><td style="background:#f0f4ff;font-weight:bold;vertical-align:top;">Applied Filters</td><td>${filtersText.replace(/</g, '&lt;').replace(/\n/g, '<br>')}</td></tr>
</table>
<p style="margin-top:16px;color:#666;font-size:12px;">This email was generated automatically by the Bursary scheduled reports service. If you no longer wish to receive these reports, contact the Bursary administrator.</p>
  `.trim();
}

export interface ScheduledAttachment {
  filename: string;
  content: string;
  contentType: string;
  _base64: boolean;
}

async function sendReportEmails(params: {
  recipients: string[];
  subjectLine: string;
  scheduledName: string;
  dateRange: DateRange;
  exportResult: SyncExportResult;
  scheduledReportId: number;
  idemPrefix: string;
}): Promise<void> {
  const { recipients, subjectLine, scheduledName, dateRange, exportResult, scheduledReportId, idemPrefix } = params;
  const todayDate = new Date().toISOString().slice(0, 10);
  const fullSubject = `[Bursary] ${subjectLine || scheduledName} — ${todayDate}`;
  const filtersText = buildFiltersSummaryString({
    ...((exportResult as any).filters || {}),
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
  });
  const bodyHtml = buildEmailBody({
    scheduledName,
    dateRangeLabel: dateRange.label,
    totalRows: exportResult.rowCount,
    filtersText,
  });
  const bodyText = `Scheduled Report: ${scheduledName}\nPeriod: ${dateRange.label}\nTotal Rows: ${exportResult.rowCount}\nFilters: ${filtersText}\n\nAttachment: ${exportResult.contentDisposition}`;

  const attachmentBuffer = exportResult.buffer;
  const attachmentNameMatch = exportResult.contentDisposition.match(/filename="([^"]+)"/);
  const attachmentFilename = attachmentNameMatch ? attachmentNameMatch[1] : `scheduled-report-${scheduledReportId}-${todayDate}.xlsx`;
  const attachment: ScheduledAttachment = {
    filename: attachmentFilename,
    content: attachmentBuffer.toString('base64'),
    contentType: exportResult.contentType,
    _base64: true,
  };

  for (let i = 0; i < recipients.length; i++) {
    const to = recipients[i];
    try {
      await dispatchEmail({
        emailType: 'OTHER',
        to,
        reference: `sched-${scheduledReportId}-${todayDate}-${i}`,
        idempotencyKey: `${idemPrefix}:${to}:${i}`,
        payload: {
          subject: fullSubject,
          body: bodyHtml,
          message: bodyText,
          _attachments: [attachment],
        } as any,
      });
    } catch (emailErr: any) {
      try {
        console.warn('[reportsScheduler] single-recipient email failed for scheduledReportId=', scheduledReportId, 'to=', to, ':', (emailErr as Error)?.message?.slice(0, 120));
      } catch { /* swallow */ }
    }
  }
}

async function emailCreatorOn3Strike(params: {
  scheduled: ScheduledReport;
  creator: User;
  errorMsg: string;
  strikeCount: number;
}): Promise<void> {
  const { scheduled, creator, errorMsg, strikeCount } = params;
  const subject = `[Bursary] Scheduled Report FAILED ×${strikeCount} — ${scheduled.name}`;
  const body = `
<p>Dear Administrator,</p>
<p>Your scheduled report <strong>${String(scheduled.name).replace(/</g, '&lt;')}</strong> (ID: ${scheduled.id}) has failed ${strikeCount} consecutive times.</p>
<p style="background:#fff2f2;padding:10px;border-left:3px solid #c0392b;"><strong>Last error:</strong><br>${String(errorMsg).replace(/</g, '&lt;').slice(0, 1600)}</p>
<p>Please review the scheduled report configuration and underlying data. The processor will continue attempting to run this schedule until manually paused.</p>
<p>— Bursary Scheduled Reports</p>
  `;
  try {
    await dispatchEmail({
      emailType: 'OTHER',
      to: creator.email,
      recipientId: creator.id,
      reference: `sched-fail-${scheduled.id}-${strikeCount}`,
      idempotencyKey: `sched-fail:${scheduled.id}:${strikeCount}:${Date.now()}`,
      payload: {
        subject,
        body,
        message: `Scheduled report ${scheduled.name} (ID:${scheduled.id}) failed ${strikeCount}x.\nLast error:\n${errorMsg}`,
      } as any,
    });
  } catch {
    /* swallow — failure notification failure is non-fatal */
  }
}

async function createFailedReportExport(params: {
  scheduled: ScheduledReport;
  dateRange: DateRange;
  errorMsg: string;
  filtersSnap: any;
  reportType: ReportType;
}): Promise<void> {
  const { scheduled, dateRange, errorMsg, filtersSnap, reportType } = params;
  try {
    await prisma.reportExport.create({
      data: {
        reportUuid: uuidv4(),
        reportType,
        reportName: scheduled.name?.slice(0, 199) || `Scheduled Report #${scheduled.id}`,
        format: (scheduled.format as ReportExportFormat) || 'XLSX',
        status: 'FAILED' as ReportExportStatus,
        generatedById: scheduled.createdById,
        dateRangeStart: dateRange.dateFrom,
        dateRangeEnd: dateRange.dateTo,
        filters: filtersSnap || {},
        rowCount: 0,
        scheduledReportId: scheduled.id,
        errorMessage: String(errorMsg).slice(0, 2000),
      },
    });
  } catch {
    /* audit write failure is best-effort */
  }
}

export async function runScheduledReport(scheduledReportId: number): Promise<{ ok: boolean; error?: string; rowCount?: number }> {
  const scheduled = await prisma.scheduledReport.findUnique({
    where: { id: scheduledReportId },
    include: { createdBy: true },
  });
  if (!scheduled) {
    return { ok: false, error: `ScheduledReport ${scheduledReportId} not found` };
  }
  if (!scheduled.isActive) {
    return { ok: true, rowCount: 0 };
  }

  const dateRange = computeDateRangeForFrequency(scheduled.frequency);
  const baseFilters: any = (scheduled.filters && typeof scheduled.filters === 'object')
    ? { ...(scheduled.filters as any) }
    : {};
  baseFilters.dateFrom = dateRange.dateFrom;
  baseFilters.dateTo = dateRange.dateTo;

  const reportType = resolveReportType(scheduled);
  const filtersSnap = JSON.parse(JSON.stringify(baseFilters));

  const creator = scheduled.createdBy as User | null;
  const generatedBy = {
    id: scheduled.createdById,
    name: creator ? `${creator.firstName} ${creator.lastName}`.trim() || 'Bursary Admin' : 'Bursary Admin',
    email: creator?.email || 'bursary@bellsuniversity.edu.ng',
  };

  try {
    const formatNarrow: 'XLSX' | 'PDF' = (scheduled.format === 'PDF' ? 'PDF' : 'XLSX');
    const exportResult = await dispatchReportExport({
      reportType,
      reportName: scheduled.name?.slice(0, 120) || `Scheduled_Report_${scheduled.id}`,
      format: formatNarrow,
      filters: baseFilters,
      generatedBy,
      scheduledReportId: scheduled.id,
    });

    let rowCount = 0;
    if (exportResult.mode === 'sync') {
      rowCount = exportResult.rowCount;
      const recipientsArr: string[] = Array.isArray(scheduled.recipients)
        ? (scheduled.recipients as any[]).map((r) => String(r)).filter(Boolean)
        : [];
      if (recipientsArr.length > 0) {
        await sendReportEmails({
          recipients: recipientsArr,
          subjectLine: scheduled.subjectLine || scheduled.name,
          scheduledName: scheduled.name,
          dateRange,
          exportResult,
          scheduledReportId: scheduled.id,
          idemPrefix: `sched-email:${scheduled.id}:${new Date().toISOString().slice(0, 10)}`,
        });
      }
    }

    const nextRunAt = computeNextRunAt(scheduled.frequency, scheduled.cronExpression || undefined) || undefined;
    await prisma.scheduledReport.update({
      where: { id: scheduled.id },
      data: {
        lastRunAt: new Date(),
        nextRunAt,
      },
    });

    if (scheduled.createdById) {
      try {
        await prisma.scheduledReport.update({
          where: { id: scheduled.id },
          data: { /* consecutive failure reset handled via ReportExport status transitions below; placeholder */ } as any,
        });
      } catch { /* noop */ }
    }

    return { ok: true, rowCount };
  } catch (err: any) {
    const errorMsg = String(err?.message || err).slice(0, 1900);
    await createFailedReportExport({
      scheduled, dateRange, errorMsg, filtersSnap, reportType,
    });
    try {
      const nextRunAt = computeNextRunAt(scheduled.frequency, scheduled.cronExpression || undefined) || undefined;
      await prisma.scheduledReport.update({
        where: { id: scheduled.id },
        data: { lastRunAt: new Date(), nextRunAt },
      });
    } catch { /* noop */ }

    try {
      const recentFailed = await prisma.reportExport.count({
        where: {
          scheduledReportId: scheduled.id,
          status: 'FAILED' as ReportExportStatus,
          createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) },
        },
        orderBy: { createdAt: 'desc' },
      });
      const recentWindow = await prisma.reportExport.findMany({
        where: { scheduledReportId: scheduled.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { status: true, createdAt: true },
      });
      let consecutiveFailures = 0;
      for (const row of recentWindow) {
        if (row.status === 'FAILED') {
          consecutiveFailures++;
        } else if (row.status === 'COMPLETED') {
          break;
        }
      }
      if (consecutiveFailures > 0 && consecutiveFailures % 3 === 0 && creator) {
        await emailCreatorOn3Strike({
          scheduled,
          creator,
          errorMsg,
          strikeCount: consecutiveFailures,
        });
      }
    } catch { /* swallow — 3-strike notification best effort */ }

    return { ok: false, error: errorMsg };
  }
}

export async function processScheduledJob(scheduledReportId: number): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    queueCaptures.push({
      scheduledReportId,
      at: new Date().toISOString(),
    });
  }
  const res = await runScheduledReport(scheduledReportId);
  if (!res.ok && process.env.NODE_ENV !== 'test') {
    try { console.warn('[reportsScheduler] scheduled job failed id=', scheduledReportId, ':', res.error?.slice(0, 120)); } catch { /* swallow */ }
  }
}

function createSchedulerWorker(): Worker | null {
  if (process.env.NODE_ENV === 'test' || process.env.QUEUE_DISABLE_WORKERS === 'true') {
    return null;
  }
  try {
    if (!_reportsSchedulerWorkerRedis) {
      _reportsSchedulerWorkerRedis = createBullmqWorkerConnection({
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 200, 2000),
      });
      _reportsSchedulerWorkerRedis.connect().catch(() => { /* worker retries via events */ });
    }
    const worker = new Worker('report.scheduled', async (job) => {
      const data = job.data || {};
      const schedId = Number(data.scheduledReportId);
      if (!Number.isFinite(schedId) || schedId <= 0) {
        return;
      }
      await processScheduledJob(schedId);
    }, {
      connection: _reportsSchedulerWorkerRedis,
      concurrency: 2,
      attempts: 1,
    } as any);
    worker.on('failed', (job, err) => {
      try { console.error('[reportsScheduler] worker failed jobId=', job?.id, ':', err?.message?.slice(0, 120) ?? String(err).slice(0, 120)); } catch { /* swallow */ }
    });
    _reportsSchedulerWorker = worker;
    return worker;
  } catch {
    return null;
  }
}

let _workerRef = createSchedulerWorker();
void _workerRef;

export async function resyncAllScheduledJobs(): Promise<void> {
  try {
    const { scheduleRecurring } = await import('../config/queue');
    const rows = await prisma.scheduledReport.findMany({
      where: { isActive: true },
      select: { id: true, frequency: true, cronExpression: true },
    });
    for (const row of rows) {
      try {
        await scheduleRecurring(
          `scheduled-report:${row.id}`,
          row.frequency,
          row.cronExpression || undefined,
          { scheduledReportId: row.id },
        );
      } catch { /* per-row best effort */ }
    }
  } catch { /* queue layer best effort */ }
}

export async function shutdownReportsSchedulerQueue(): Promise<void> {
  if (_reportsSchedulerWorker) {
    const w = _reportsSchedulerWorker;
    _reportsSchedulerWorker = null;
    try { await w.close(); } catch { /* ignore */ }
  }
  if (_reportsSchedulerQueue) {
    const q = _reportsSchedulerQueue;
    _reportsSchedulerQueue = null;
    try { await q.close(); } catch { /* ignore */ }
  }
  if (_reportsSchedulerWorkerRedis) {
    const c = _reportsSchedulerWorkerRedis;
    _reportsSchedulerWorkerRedis = null;
    try { await c.quit(); } catch { try { c.disconnect(false); } catch { /* ignore */ } }
  }
  if (_reportsSchedulerProducerRedis) {
    const c = _reportsSchedulerProducerRedis;
    _reportsSchedulerProducerRedis = null;
    try { await c.quit(); } catch { try { c.disconnect(false); } catch { /* ignore */ } }
  }
}

export function clearSchedulerCapturesForTests(): void {
  queueCaptures.length = 0;
}
