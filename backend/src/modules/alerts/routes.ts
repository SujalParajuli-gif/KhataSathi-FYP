import { Router } from "express";
import { getRead, markRead, markAllRead, markUnread } from "./controller";
import { authGuard } from "../../middleware/auth";

const router = Router();
router.use(authGuard);

router.get("/read", getRead);
router.post("/read", markRead);
router.post("/read-all", markAllRead);
router.delete("/read", markUnread);

export default router;
