import { Router } from "express";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { list, purge, restore } from "./controller";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard);
router.use(requireRole("ADMIN"));

router.get("/", list);
router.post("/:id/restore", restore);
router.delete("/:id", purge);

export default router;
