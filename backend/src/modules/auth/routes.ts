// src/modules/auth/routes.ts — Auth routes
import { Router } from "express";
import { login, me } from "./controller";
import { authGuard } from "../../middleware/auth";

const router: ReturnType<typeof Router> = Router();

// POST /api/auth/login — authenticate user
router.post("/login", login);

// GET /api/auth/me — get current user from JWT
router.get("/me", authGuard, me);

export default router;
