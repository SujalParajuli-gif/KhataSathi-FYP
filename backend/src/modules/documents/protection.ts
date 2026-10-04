export class SaleEvidenceProtectedError extends Error {
  readonly code = "SALE_EVIDENCE_PROTECTED" as const;
  readonly status = 409 as const;

  constructor(
    message = "Sales bill evidence cannot be changed or deleted through general document operations.",
  ) {
    super(message);
    this.name = "SaleEvidenceProtectedError";
  }
}

export function isSaleEvidenceDocumentType(type: unknown): boolean {
  return type === "SALE_BILL";
}

export function assertNotSaleEvidenceDocument(
  docOrType: { documentType?: unknown } | unknown,
  actionDescription?: string,
): void {
  const type =
    docOrType && typeof docOrType === "object" && "documentType" in docOrType
      ? (docOrType as { documentType: unknown }).documentType
      : docOrType;

  if (isSaleEvidenceDocumentType(type)) {
    throw new SaleEvidenceProtectedError(
      actionDescription
        ? `Sales bill evidence cannot be ${actionDescription} through general document operations.`
        : undefined,
    );
  }
}

export function isSaleEvidenceSnapshot(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  return (snapshot as Record<string, unknown>).documentType === "SALE_BILL";
}
