/**
 * Module 5 — Log Hygiene
 * Winston logger with DailyRotateFile: max 20 MB per file, 7-day retention.
 */
import winston from "winston";
import "winston-daily-rotate-file";
import path from "node:path";

const LOG_DIR = process.env.LOG_DIR || "/tmp/upg-api/logs";
const isProd = process.env.NODE_ENV === "production";
import fs from "node:fs";
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const fileTransport = new winston.transports.DailyRotateFile({
  dirname: LOG_DIR,
  filename: "application-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  maxSize: "20m", // 20 MB per file
  maxFiles: "7d", // keep last 7 days
  zippedArchive: true,
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
});

const errorFileTransport = new winston.transports.DailyRotateFile({
  dirname: LOG_DIR,
  filename: "error-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  maxSize: "20m",
  maxFiles: "7d",
  zippedArchive: true,
  level: "error",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
});

const consoleTransport = new winston.transports.Console({
  level: isProd ? "warn" : "debug",
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ level, message, timestamp, stack, ...rest }) => {
      const extras = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
      return `${timestamp} [${level}]: ${stack ?? message}${extras}`;
    })
  ),
});

const logger = winston.createLogger({
  level: isProd ? "info" : "debug",
  defaultMeta: { service: "upg-api" },
  transports: [consoleTransport, fileTransport, errorFileTransport],
  exceptionHandlers: [fileTransport, errorFileTransport],
  rejectionHandlers: [fileTransport, errorFileTransport],
  exitOnError: false,
});

export default logger;
