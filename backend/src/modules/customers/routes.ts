import { Router } from "express";
import { list, getOne, create, update, deactivate } from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard); // all customer routes require authentication

router.get("/", list); // any authenticated user can view the customer list
router.get("/:id", getOne); // fetching a single customer by ID
router.post("/", requireRole("ADMIN"), create); // only admin can create new customers
router.put("/:id", requireRole("ADMIN"), update); // only admin can update customer info
router.patch("/:id/deactivate", requireRole("ADMIN"), deactivate); // only admin can deactivate a customer

export default router;
