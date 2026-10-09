import { Router } from "express";
import { authGuard } from "../../../middleware/auth";
import { denyStaff, requireRole } from "../../../middleware/rbac";
import { requireBusinessCapability } from "../../settings/capabilities";
import {
  getManualBillRecordHandler,
  getProofFileHandler,
  getProofThumbnailHandler,
  listManualBillQueueHandler,
  markMissingHandler,
  recordReferenceHandler,
  verifyReferenceHandler,
  withdrawReferenceHandler,
} from "./controller";

const router = Router();

router.use(authGuard);
router.use(denyStaff);
router.use(requireBusinessCapability("POS"));

// Queue list
router.get("/queue", requireRole("ADMIN", "MANAGER", "CASHIER"), listManualBillQueueHandler);

// Proof file / thumbnail streaming (invoice-bound)
router.get("/:invoiceId/proofs/:documentId/file", requireRole("ADMIN", "MANAGER", "CASHIER"), getProofFileHandler);
router.get("/:invoiceId/proofs/:documentId/thumbnail", requireRole("ADMIN", "MANAGER", "CASHIER"), getProofThumbnailHandler);

// Invoice manual bill details & history
router.get("/:invoiceId", requireRole("ADMIN", "MANAGER", "CASHIER"), getManualBillRecordHandler);

// Actions
router.post("/:invoiceId/reference", requireRole("ADMIN", "MANAGER", "CASHIER"), recordReferenceHandler);
router.post("/:invoiceId/verify", requireRole("ADMIN", "MANAGER"), verifyReferenceHandler);
router.post("/:invoiceId/missing", requireRole("ADMIN", "MANAGER"), markMissingHandler);
router.post("/:invoiceId/withdraw", requireRole("ADMIN", "MANAGER"), withdrawReferenceHandler);

export default router;
