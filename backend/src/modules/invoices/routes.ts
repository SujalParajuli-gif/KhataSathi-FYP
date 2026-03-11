// src/modules/invoices/routes.ts — Invoice routes
import { Router } from "express";
import { createDraft, list, getOne, addItem, updateItem, removeItem, finalize } from "./controller";
import { authGuard } from "../../middleware/auth";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard);

// POST /api/invoices — create draft
router.post("/", createDraft);

// GET /api/invoices — list with filters
router.get("/", list);

// GET /api/invoices/:id — get detail
router.get("/:id", getOne);

// POST /api/invoices/:id/items — add item
router.post("/:id/items", addItem);

// PUT /api/invoices/:id/items/:itemId — update item qty
router.put("/:id/items/:itemId", updateItem);

// DELETE /api/invoices/:id/items/:itemId — remove item
router.delete("/:id/items/:itemId", removeItem);

// POST /api/invoices/:id/finalize — lock invoice
router.post("/:id/finalize", finalize);

export default router;
