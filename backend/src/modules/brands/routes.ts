import { Router } from "express";
import { list, getOne, create, update, deactivate } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard); // all brand routes require authentication

router.get("/", list); // any authenticated user can view brands
router.get("/:id", getOne); // fetching a single brand with its linked products

router.post("/", requireRole("ADMIN"), create); // only admin can create new brands
router.put("/:id", requireRole("ADMIN"), update); // only admin can update brand name or status
router.patch("/:id/deactivate", requireRole("ADMIN"), deactivate); // only admin can deactivate a brand

export default router;
