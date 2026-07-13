import { Router } from "express";
import { list, getOne, create, update, deactivate } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard); // all brand routes require authentication

router.get("/", list); // any authenticated user can view brands
router.get("/:id", getOne); // fetching a single brand with its linked products

router.post("/", requireRole("ADMIN", "MANAGER"), create); // admin and managers can create new brands
router.put("/:id", requireRole("ADMIN", "MANAGER"), update); // admin and managers can update brand name or status
router.patch("/:id/deactivate", requireRole("ADMIN", "MANAGER"), deactivate); // admin and managers can deactivate a brand

export default router;
