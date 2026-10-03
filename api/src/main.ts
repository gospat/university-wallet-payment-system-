import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import logger from "./config/logger";
import { errorHandler } from "./middleware/error";
import v1Router from "./routes/v1";
import { startCleanupCron } from "./services/cleanupService";

import "./workers/emailWorker";
import "./workers/studentImportWorker";
import { redisConnection } from "./config/queue";

const PORT = Number(process.env.PORT_API ?? 3001);
const NODE_ENV = (process.env.NODE_ENV ?? "development").toLowerCase();
const DB_USERNAME = process.env.DB_USERNAME ?? "root";
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

if (NODE_ENV === "production" && DB_USERNAME === "root") {
  // Security: refuse to boot with root DB credentials in production.
  // See user profile: "Prevent production boot with DB root credentials at the code level."
  const msg =
    "[SECURITY BLOCK] Refusing to boot in NODE_ENV=production with DB_USERNAME='root'. " +
    "Create a minimal-privilege DB user and update DB_USERNAME / DATABASE_URL before starting.";
  console.error(msg);
  process.exit(87);
}

async function bootstrap() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false }));

  const corsOrigins =
    NODE_ENV === "production"
      ? (APP_URL.split(",").map((s) => s.trim()).filter(Boolean) as string[])
      : true;
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));

  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests", code: "RATE_LIMITED" },
  });
  app.use(globalLimiter);

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    message: { error: "Too many auth attempts", code: "AUTH_RATE_LIMITED" },
  });
  app.use("/api/v1/auth/login", authLimiter);
  app.use("/api/v1/auth/refresh", authLimiter);

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", uptime: process.uptime(), ts: new Date().toISOString() });
  });

  app.use("/api/v1", v1Router);

  app.use((req, res) => {
    res.status(404).json({ error: "Not found", path: req.path });
  });

  app.use(errorHandler);

  try {
    await redisConnection.connect().catch((e: any) => {
      logger.warn(`Redis connect failed (will retry): ${e.message}`);
    });
  } catch (_) {
    // noop — ioredis retries.
  }

  startCleanupCron();

  app.listen(PORT, () => {
    logger.info(`UPG API listening on port ${PORT} (NODE_ENV=${NODE_ENV})`);
  });
}

bootstrap().catch((err) => {
  logger.error("Failed to bootstrap API", { err });
  process.exit(1);
});

