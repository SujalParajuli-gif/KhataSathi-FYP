import { Router } from "express";
import { authGuard } from "../../middleware/auth";
import { denyStaff } from "../../middleware/rbac";
import { addEvent, close, getCurrent, list, open } from "./controller";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard);
router.use(denyStaff);

router.get("/current", getCurrent);
router.get("/", list);
router.post("/open", open);
router.post("/:id/events", addEvent);
router.post("/:id/close", close);

export default router;
