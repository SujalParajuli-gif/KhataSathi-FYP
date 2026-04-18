import { Router } from "express";
import { list, getRead, markRead, markAllRead, markUnread } from "./controller";
import { authGuard } from "../../middleware/auth";

const router = Router();
router.use(authGuard); // all alert routes require authentication

router.get("/", list); // fetching active alerts (low stock, etc.) for the current user
router.get("/read", getRead); // fetching the list of alert keys the current user has already read
router.post("/read", markRead); // marking a single alert as read
router.post("/read-all", markAllRead); // marking multiple alerts as read at once
router.delete("/read", markUnread); // marking an alert as unread again

export default router;
