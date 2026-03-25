import { Router } from "express";
import { list, getOne, create, update, deactivate } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard);

router.get("/", list);
router.get("/:id", getOne);
router.post("/", requireRole("ADMIN"), create);
router.put("/:id", requireRole("ADMIN"), update);
router.patch("/:id/deactivate", requireRole("ADMIN"), deactivate);

export default router;
