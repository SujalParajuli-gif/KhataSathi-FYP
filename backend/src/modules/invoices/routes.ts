import { Router } from "express";
import {
  createDraft,
  list,
  getOne,
  addItem,
  updateItem,
  removeItem,
  finalize,
  cancel,
} from "./controller";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";

const router = Router();

router.use(authGuard);

router.get("/", list);
router.get("/:id", getOne);

router.post("/", requireRole("CASHIER"), createDraft);
router.post("/:id/items", requireRole("CASHIER"), addItem);
router.patch("/:id/items/:itemId", requireRole("CASHIER"), updateItem);
router.delete("/:id/items/:itemId", requireRole("CASHIER"), removeItem);
router.post("/:id/finalize", requireRole("CASHIER"), finalize);
router.patch("/:id/cancel", requireRole("CASHIER", "ADMIN"), cancel);

export default router;
