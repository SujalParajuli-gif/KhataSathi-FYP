import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { detectDocumentFormat, DocumentValidationError } from "../modules/documents/validation";
import prisma from "../db/prisma";

// Set a temporary isolated storage root before importing the service
const isolatedStorageRoot = path.join(os.tmpdir(), `khatasathi-test-storage-${Date.now()}`);
process.env.DOCUMENT_STORAGE_ROOT = isolatedStorageRoot;

import { createDocuments, getDocumentFilePath } from "../modules/documents/service";
import { uploadDocuments } from "../modules/documents/controller";

const VALID_PDF = Buffer.from("%PDF-1.4\n%äüöß\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n", "utf8");
const VALID_PNG = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001010300000025db56ca00000003504c5445000000a77a3dda0000000174524e530040e6d8660000000a4944415408d76360000000020001e221bc330000000049454e44ae426082", "hex");
const VALID_JPG = Buffer.from("ffd8ffe000104a46494600010101004800480000ffdb004300ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc0000b080001000101011100ffc40014000100000000000000000000000000000000ffda0008010100003f0037ffd9", "hex");
const VALID_WEBP = Buffer.from("5249464614000000574542505650384c080000002f00000010071011118888fe0700", "hex");
const INVALID_CONTENT = Buffer.from("just some random text content that is not an image or pdf", "utf8");

async function withPrismaMocks(run: (context: { createCount: number }) => Promise<void>) {
    const documentDelegate = prisma.document as any;
    const auditDelegate = prisma.auditLog as any;
    const originalCreate = documentDelegate.create;
    const originalUpdate = documentDelegate.update;
    const originalAuditCreate = auditDelegate.create;

    const context = { createCount: 0 };
    const documentsStore: Record<string, any> = {};

    documentDelegate.create = async ({ data }: any) => {
        context.createCount++;
        const id = `doc-${context.createCount}`;
        const record = { id, ...data };
        documentsStore[id] = record;
        return record;
    };
    documentDelegate.update = async ({ data, where }: any) => {
        const id = where.id;
        if (documentsStore[id]) {
            documentsStore[id] = { ...documentsStore[id], ...data };
        }
        return documentsStore[id] || { id, ...data };
    };
    auditDelegate.create = async () => ({});
    try {
        await run(context);
    } finally {
        documentDelegate.create = originalCreate;
        documentDelegate.update = originalUpdate;
        auditDelegate.create = originalAuditCreate;
    }
}

test("detectDocumentFormat accurately identifies genuine files including webp", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-test-"));
    try {
        const pdfPath = path.join(dir, "genuine.pdf");
        await fs.writeFile(pdfPath, VALID_PDF);
        const pdfRes = await detectDocumentFormat(pdfPath);
        assert.deepEqual(pdfRes, { mimeType: "application/pdf", extension: ".pdf" });

        const webpPath = path.join(dir, "genuine.webp");
        await fs.writeFile(webpPath, VALID_WEBP);
        const webpRes = await detectDocumentFormat(webpPath);
        assert.deepEqual(webpRes, { mimeType: "image/webp", extension: ".webp" });
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("createDocuments rejects mismatched claims like PNG claimed as PDF", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-test-service-"));
    try {
        const pngPath = path.join(dir, "sneaky.pdf");
        await fs.writeFile(pngPath, VALID_PNG);

        await assert.rejects(
            createDocuments([
                {
                    originalname: "sneaky.pdf",
                    mimetype: "application/pdf", // mismatched claim
                    size: VALID_PNG.length,
                    path: pngPath,
                }
            ], { documentType: "GENERAL" }, "user1"),
            (err: any) => err instanceof DocumentValidationError && err.message.includes("content mismatch")
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("invalid second file causes zero document DB creates and cleans up", async () => {
    await withPrismaMocks(async (context) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-test-service2-"));
        try {
            const validPath = path.join(dir, "valid.pdf");
            await fs.writeFile(validPath, VALID_PDF);
            const invalidPath = path.join(dir, "invalid.txt");
            await fs.writeFile(invalidPath, INVALID_CONTENT);

            await assert.rejects(
                createDocuments([
                    { originalname: "valid.pdf", mimetype: "application/pdf", size: VALID_PDF.length, path: validPath },
                    { originalname: "invalid.txt", mimetype: "text/plain", size: INVALID_CONTENT.length, path: invalidPath }
                ], { documentType: "GENERAL" }, "user1"),
                (err: any) => err instanceof DocumentValidationError
            );

            assert.equal(context.createCount, 0, "No records should have been created");
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

test("controller cleans all temporary files upon validation rejection", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-test-ctrl-"));
    try {
        const validPath = path.join(dir, "valid.pdf");
        await fs.writeFile(validPath, VALID_PDF);
        const invalidPath = path.join(dir, "invalid.txt");
        await fs.writeFile(invalidPath, INVALID_CONTENT);

        const req: any = {
            files: [
                { originalname: "valid.pdf", mimetype: "application/pdf", size: VALID_PDF.length, path: validPath },
                { originalname: "invalid.txt", mimetype: "text/plain", size: INVALID_CONTENT.length, path: invalidPath }
            ],
            body: { documentType: "GENERAL" },
            user: { id: "user1" }
        };

        let statusSent = 0;
        let jsonSent: any = null;
        const res: any = {
            status: (s: number) => { statusSent = s; return res; },
            json: (j: any) => { jsonSent = j; }
        };

        await uploadDocuments(req, res);

        assert.equal(statusSent, 400);
        assert.match(jsonSent.error, /not allowed/);

        await assert.rejects(fs.access(validPath), /ENOENT/, "First valid temp file should be deleted");
        await assert.rejects(fs.access(invalidPath), /ENOENT/, "Second invalid temp file should be deleted");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("payload.php retains display name but is stored with verified .pdf extension", async () => {
    await withPrismaMocks(async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-test-payload-"));
        try {
            const payloadPath = path.join(dir, "payload.php");
            await fs.writeFile(payloadPath, VALID_PDF);

            let createdFilePath: string | null = null;
            try {
                const [doc] = await createDocuments([
                    {
                        originalname: "payload.php",
                        mimetype: "application/pdf",
                        size: VALID_PDF.length,
                        path: payloadPath,
                    }
                ], { documentType: "GENERAL" }, "test-user-pdf");

                createdFilePath = getDocumentFilePath(doc);

                assert.equal(doc.fileName, "payload.php", "Display name should be payload.php");
                assert.equal(doc.mimeType, "application/pdf");
                assert.ok(doc.storedFileName.endsWith(".pdf"), "Stored filename must end with .pdf");
            } finally {
                if (createdFilePath) {
                    await fs.unlink(createdFilePath).catch(() => {});
                }
                await fs.rm(dir, { recursive: true, force: true });
            }
        } finally {
            // Clean up the isolated storage root
            await fs.rm(isolatedStorageRoot, { recursive: true, force: true }).catch(() => {});
        }
    });
});
