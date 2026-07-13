import { z } from "zod";
import { optionalSafeText } from "../../lib/requestValidation";

export const voidPaymentBodySchema = z
  .object({
    overridePin: optionalSafeText("Override PIN", 20),
  })
  .strict();
