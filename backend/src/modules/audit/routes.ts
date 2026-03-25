import { Router } from "express";
import { list } from "./controller";
import { authGuard } from "../../middleware/auth";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard);
router.get("/", list);

export default router;