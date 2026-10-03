/**
 * Module 5 — Disk Hygiene: Temp CSV cleanup cron.
 *   - deletes files in api/tmp/uploads older than 24h
 *   - deletes *.log files in api/tmp/* older than 7 days
 */
import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
import logger from "../config/logger";

const ROOT = process.env.CLEANUP_ROOT || "/tmp/upg-api";
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(ROOT, "tmp", "uploads");
const TMP_DIR = path.resolve(ROOT, "tmp");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

export function cleanTempUploads(): void {
  if (!fs.existsSync(UPLOAD_DIR)) return;
  const threshold = Date.now() - ONE_DAY_MS;
  const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(UPLOAD_DIR, e.name);
    try {
      const { mtimeMs } = fs.statSync(full);
      if (mtimeMs < threshold) {
        fs.unlinkSync(full);
        logger.info(`[cleanup] removed old upload: ${e.name}`);
      }
    } catch (err) {
      logger.warn(`[cleanup] stat/delete failed for ${e.name}`, { err });
    }
  }
}

export function cleanOldTempLogs(): void {
  if (!fs.existsSync(TMP_DIR)) return;
  const threshold = Date.now() - SEVEN_DAYS_MS;
  const walk = (dir: string, depth = 0) => {
    if (depth > 3) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile() && e.name.endsWith(".log")) {
          const { mtimeMs } = fs.statSync(full);
          if (mtimeMs < threshold) {
            fs.unlinkSync(full);
            logger.info(`[cleanup] removed old temp log: ${full}`);
          }
        }
      } catch (err) {
        logger.warn(`[cleanup] error on ${full}`, { err });
      }
    }
  };
  walk(TMP_DIR, 0);
}

export function runCleanupOnce(): void {
  try {
    cleanTempUploads();
    cleanOldTempLogs();
  } catch (err) {
    logger.error("[cleanup] runCleanupOnce failed", { err });
  }
}

export function startCleanupCron(): void {
  const enabled = process.env.CRON_CLEANUP_ENABLED !== "false";
  if (!enabled) {
    // NOTE: cron disabled by platform; external scheduler MUST ensure
    // api/tmp/uploads files older than 24h are removed and stale *.log purged.
    logger.info(
      "[cleanup] cron disabled by CRON_CLEANUP_ENABLED=false; ensure platform cron removes api/tmp/uploads within 24h."
    );
    return;
  }
  // Run immediately on startup to address yesterday's leftovers.
  runCleanupOnce();
  // Schedule daily at 03:00.
  cron.schedule("0 3 * * *", () => {
    logger.info("[cleanup] scheduled run starting");
    runCleanupOnce();
  });
  logger.info("[cleanup] daily cron registered (03:00)");
}
