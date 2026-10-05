-- CreateIndex
CREATE INDEX `Invoice_manual_bill_queue_idx` ON `Invoice`(`status`, `billingChannel`, `billRecordStatus`, `cancelledAt`, `deletedAt`, `finalizedAt`, `id`);

-- CreateIndex
CREATE INDEX `Invoice_external_reference_idx` ON `Invoice`(`externalDocumentType`, `externalBillNo`, `externalBillDate`);

-- CreateIndex
CREATE INDEX `Document_sales_review_idx` ON `Document`(`documentType`, `saleRecoveryStatus`, `createdAt`, `id`);
