import { Router } from "express";
import { authGuard } from "../../middleware/auth";
import { denyStaff, requireRole } from "../../middleware/rbac";
import { approve, create, list, reject, reverse } from "./controller";

const router = Router();

router.use(authGuard);
router.use(denyStaff);

router.get("/", list);
router.post("/", requireRole("CASHIER", "MANAGER", "ADMIN"), create);
router.patch("/:id/approve", requireRole("ADMIN", "MANAGER"), approve);
router.patch("/:id/reject", requireRole("ADMIN", "MANAGER"), reject);
router.patch("/:id/reverse", requireRole("ADMIN", "MANAGER"), reverse);

export default router;
