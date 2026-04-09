import { Router } from "express";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import {
  getBusinessDefaults,
  updateBusinessDefaults,
} from "./controller";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard);

router.get("/business", getBusinessDefaults);
router.put("/business", requireRole("ADMIN"), updateBusinessDefaults);

export default router;
