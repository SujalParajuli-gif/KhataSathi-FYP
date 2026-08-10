import { Router } from "express";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import {
  createProductAlias,
  createSynonym,
  listProductAliases,
  listSynonyms,
  rebuildDocuments,
  updateProductAlias,
  updateSynonym,
  searchInsights,
  searchAliasProductOptions,
} from "./searchAliasController";

const router: ReturnType<typeof Router> = Router();

router.use(authGuard);
router.use(requireRole("ADMIN"));

router.get("/synonyms", listSynonyms);
router.post("/synonyms", createSynonym);
router.put("/synonyms/:id", updateSynonym);
router.get("/product-aliases", listProductAliases);
router.post("/product-aliases", createProductAlias);
router.put("/product-aliases/:id", updateProductAlias);
router.post("/documents/rebuild", rebuildDocuments);
router.get("/insights", searchInsights);
router.get("/product-options", searchAliasProductOptions);

export default router;
