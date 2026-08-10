import { Router } from "express";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import {
  accept,
  cancel,
  complete,
  create,
  getOne,
  list,
  markViewed,
  reject,
  resolveAccepted,
  update,
} from "./controller";

const router = Router();

router.use(authGuard);

router.get("/", requireRole("ADMIN", "MANAGER", "CASHIER", "STAFF"), list);
router.post("/", requireRole("STAFF"), create);
router.get("/:id", requireRole("ADMIN", "MANAGER", "CASHIER", "STAFF"), getOne);
router.patch("/:id/viewed", requireRole("CASHIER"), markViewed);
router.put("/:id", requireRole("ADMIN", "MANAGER", "STAFF"), update);
router.patch("/:id/cancel", requireRole("ADMIN", "MANAGER", "STAFF"), cancel);
router.patch("/:id/accept", requireRole("ADMIN", "MANAGER", "CASHIER"), accept);
router.patch("/:id/reject", requireRole("ADMIN", "MANAGER", "CASHIER"), reject);
router.patch("/:id/complete", requireRole("ADMIN", "MANAGER", "CASHIER"), complete);
router.patch(
  "/:id/resolve-accepted",
  requireRole("ADMIN", "MANAGER", "CASHIER"),
  resolveAccepted,
);

export default router;
