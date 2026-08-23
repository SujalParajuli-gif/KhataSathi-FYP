import type { Request, Response } from "express";
import * as searchAliases from "./searchAliasService";
import * as productService from "./service";
import { getProductSearchInsights } from "./searchLogging";

function sendSearchAliasError(res: Response, error: any) {
  if (error?.code === "P2002") {
    res.status(409).json({ error: "That normalized alias already exists." });
    return;
  }
  const status = Number(error?.statusCode || 0);
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: error.message });
    return;
  }
  console.error("Product search alias error:", error);
  res.status(500).json({ error: "Product search aliases could not be updated." });
}

export async function listSynonyms(_req: Request, res: Response) {
  try {
    res.json({ synonyms: await searchAliases.listSearchSynonyms() });
  } catch (error) {
    sendSearchAliasError(res, error);
  }
}

export async function createSynonym(req: Request, res: Response) {
  try {
    const synonym = await searchAliases.createSearchSynonym(
      { alias: req.body.alias, canonicalTerm: req.body.canonicalTerm },
      req.user!.id,
    );
    res.status(201).json(synonym);
  } catch (error) {
    sendSearchAliasError(res, error);
  }
}

export async function previewSynonymPromotion(req: Request, res: Response) {
  try {
    const context = await searchAliases.getSearchSynonymPromotionContext({
      alias: req.query.alias,
      canonicalTerm: req.query.canonicalTerm,
    });
    const result = await productService.listProducts({
      search: context.prepared.canonicalTerm,
      isActive: true,
      page: 1,
      pageSize: 6,
    });
    res.json({
      alias: context.prepared.alias,
      canonicalTerm: context.prepared.canonicalTerm,
      normalizedCanonicalTerm: context.prepared.normalizedCanonicalTerm,
      totalMatches: result.total,
      products: result.products.map((product) => ({
        id: product.id,
        name: product.name,
        sku: product.sku,
        imageUrl: product.imageUrl,
        thumbnailUrl: product.thumbnailUrl,
        brand: product.brand,
        category: product.category,
      })),
      existingSynonym: context.existingSynonym,
      linkedProductAliases: context.linkedProductAliases.map((alias) => ({
        id: alias.id,
        product: alias.product,
      })),
    });
  } catch (error) {
    sendSearchAliasError(res, error);
  }
}

export async function promoteSynonym(req: Request, res: Response) {
  try {
    const matching = await productService.listProducts({
      search: String(req.body.canonicalTerm || "").trim(),
      isActive: true,
      page: 1,
      pageSize: 1,
    });
    if (matching.total < 1) {
      throw Object.assign(
        new Error("The product type must match at least one active product before this rule can be saved."),
        { statusCode: 400 },
      );
    }
    const result = await searchAliases.promoteSearchSynonym(
      { alias: req.body.alias, canonicalTerm: req.body.canonicalTerm },
      req.user!.id,
    );
    res.status(201).json(result);
  } catch (error) {
    sendSearchAliasError(res, error);
  }
}

export async function updateSynonym(req: Request, res: Response) {
  try {
    const synonym = await searchAliases.updateSearchSynonym(
      String(req.params.id),
      {
        alias: req.body.alias,
        canonicalTerm: req.body.canonicalTerm,
        isEnabled: req.body.isEnabled,
      },
      req.user!.id,
    );
    res.json(synonym);
  } catch (error) {
    sendSearchAliasError(res, error);
  }
}

export async function listProductAliases(req: Request, res: Response) {
  try {
    const productId = String(req.query.productId || "").trim() || undefined;
    res.json({ aliases: await searchAliases.listProductSearchAliases(productId) });
  } catch (error) {
    sendSearchAliasError(res, error);
  }
}

export async function createProductAlias(req: Request, res: Response) {
  try {
    const alias = await searchAliases.createProductSearchAlias(
      { productId: req.body.productId, alias: req.body.alias },
      req.user!.id,
    );
    res.status(201).json(alias);
  } catch (error) {
    sendSearchAliasError(res, error);
  }
}

export async function updateProductAlias(req: Request, res: Response) {
  try {
    const alias = await searchAliases.updateProductSearchAlias(
      String(req.params.id),
      { alias: req.body.alias, isEnabled: req.body.isEnabled },
      req.user!.id,
    );
    res.json(alias);
  } catch (error) {
    sendSearchAliasError(res, error);
  }
}

export async function replaceProductAliases(req: Request, res: Response) {
  try {
    const aliases = await searchAliases.replaceProductSearchAliases(
      req.body.productId,
      req.body.aliases,
      req.user!.id,
    );
    res.json({ aliases });
  } catch (error) {
    sendSearchAliasError(res, error);
  }
}

export async function rebuildDocuments(req: Request, res: Response) {
  try {
    const result = await searchAliases.rebuildAllProductSearchDocuments();
    res.json(result);
  } catch (error) {
    sendSearchAliasError(res, error);
  }
}

export async function searchInsights(req: Request, res: Response) {
  try {
    const days = req.query.days ? Number(req.query.days) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await getProductSearchInsights({ days, limit }));
  } catch (error) {
    sendSearchAliasError(res, error);
  }
}

export async function searchAliasProductOptions(req: Request, res: Response) {
  try {
    const query = String(req.query.q || "").trim();
    if (query.length < 2) {
      res.json({ products: [] });
      return;
    }
    const result = await productService.listProducts({
      search: query,
      isActive: true,
      page: 1,
      pageSize: 10,
    });
    res.json({
      products: result.products.map((product) => ({
        id: product.id,
        name: product.name,
        sku: product.sku,
        imageUrl: product.imageUrl,
        thumbnailUrl: product.thumbnailUrl,
        brand: product.brand,
        category: product.category,
      })),
    });
  } catch (error) {
    sendSearchAliasError(res, error);
  }
}
