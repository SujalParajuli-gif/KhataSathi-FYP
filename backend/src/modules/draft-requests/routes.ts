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
  reject,
  update,
} from "./controller";

const router = Router();

router.use(authGuard);

router.get("/", requireRole("ADMIN", "MANAGER", "CASHIER", "STAFF"), list);
router.post("/", requireRole("STAFF"), create);
router.get("/:id", requireRole("ADMIN", "MANAGER", "CASHIER", "STAFF"), getOne);
router.put("/:id", requireRole("ADMIN", "MANAGER", "STAFF"), update);
router.patch("/:id/cancel", requireRole("ADMIN", "MANAGER", "STAFF"), cancel);
router.patch("/:id/accept", requireRole("ADMIN", "MANAGER", "CASHIER"), accept);
router.patch("/:id/reject", requireRole("ADMIN", "MANAGER", "CASHIER"), reject);
router.patch("/:id/complete", requireRole("ADMIN", "MANAGER", "CASHIER"), complete);

export default router;
