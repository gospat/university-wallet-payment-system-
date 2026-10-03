/**
 * /api/v1 router — mounts all feature route modules under versioned prefix.
 *
 * Prefixes:
 *   /api/v1/auth/*                        login, change-password, refresh (Module 2)
 *   /api/v1/admin/users/*                 list + delete gate (Module 3)
 *   /api/v1/admin/students/*              bulk import upload, history, resend (Module 4)
 *   /api/v1/bursary/reconciliation/*      summary + exceptions (Module 1)
 */
import { Router } from "express";
import authRouter from "./auth";
import adminUsersRouter from "./adminUsers";
import studentImportRouter from "./studentImport";
import reconciliationRouter from "./reconciliation";

const v1 = Router();

// Public (login) / authenticated-within routes
v1.use("/auth", authRouter);

// Admin area
v1.use("/admin/users", adminUsersRouter);
v1.use("/admin", studentImportRouter);

// Bursary area
v1.use("/bursary/reconciliation", reconciliationRouter);

// Simple authenticated ping
v1.get("/ping", (req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

export default v1;
