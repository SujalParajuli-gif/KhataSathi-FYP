import { Router } from "express";
import {
  approveDiscountRequest,
  create,
  createDiscountedByCashier,
  createDiscountRequest,
  deactivate,
  deleteDiscount,
  getDiscountDeleteSafety,
  getOne,
  list,
  listDiscountRequests,
  rejectDiscountRequest,
  update,
} from "./controller";
import { authGuard } from "../../middleware/auth";
import { denyStaff, requireRole } from "../../middleware/rbac";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard); // all customer routes require authentication

router.get("/", list); // any authenticated user can view the customer list
router.use(denyStaff);
router.post("/cashier-discounted", createDiscountedByCashier); // authorized cashiers can create discounted customers
router.get("/discount-requests", listDiscountRequests); // admin sees all requests; cashiers see their own requests
router.post("/discount-requests", createDiscountRequest); // cashiers can request admin approval for discounts
router.patch("/discount-requests/:id/approve", requireRole("ADMIN", "MANAGER"), approveDiscountRequest);
router.patch("/discount-requests/:id/reject", requireRole("ADMIN", "MANAGER"), rejectDiscountRequest);
router.get("/:id/discounts/:discountType/delete-safety", requireRole("ADMIN", "MANAGER"), getDiscountDeleteSafety);
router.delete("/:id/discounts/:discountType", requireRole("ADMIN", "MANAGER"), deleteDiscount);
router.get("/:id", getOne); // fetching a single customer by ID
router.post("/", requireRole("ADMIN", "MANAGER"), create); // admin and managers can create new customers
router.put("/:id", requireRole("ADMIN", "MANAGER"), update); // admin and managers can update customer info
router.patch("/:id/deactivate", requireRole("ADMIN", "MANAGER"), deactivate); // admin and managers can deactivate a customer

export default router;
