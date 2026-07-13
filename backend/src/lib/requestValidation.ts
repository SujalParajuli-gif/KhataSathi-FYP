import { z } from "zod";

const HTML_TAG_PATTERN = /<[^>]*>/;

export function safeText(label: string, maxLength = 240) {
  return z
    .string()
    .max(maxLength, `${label} must be ${maxLength} characters or fewer`)
    .refine((value) => !HTML_TAG_PATTERN.test(value), {
      message: `${label} cannot contain HTML tags`,
    });
}

export function optionalSafeText(label: string, maxLength = 240) {
  return safeText(label, maxLength).optional().nullable();
}

export function formatZodIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "body",
    message: issue.message,
  }));
}
