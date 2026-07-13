import { z } from "zod";
import { optionalSafeText, safeText } from "../../lib/requestValidation";

export const adjustStockBodySchema = z
  .object({
    productId: safeText("Product ID", 120).min(1, "Product ID is required"),
    qtyDelta: z
      .number({ message: "Quantity delta must be a number" })
      .finite("Quantity delta must be a finite number")
      .refine((value) => value !== 0, {
        message: "Quantity delta cannot be 0",
      }),
    reason: optionalSafeText("Reason", 240),
  })
  .strict();
