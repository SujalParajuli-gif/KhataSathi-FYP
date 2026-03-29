// src/modules/admin/backup.ts — Backup endpoint (admin only)
import { Router, Request, Response } from "express";
import { spawn, spawnSync } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import prisma from "../../db/prisma";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard);
router.use(requireRole("ADMIN"));

function resolveCommandOnPath(command: string): string | null {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const result = spawnSync(locator, [command], {
        encoding: "utf8",
        windowsHide: true,
    });

    if (result.status !== 0) {
        return null;
    }

    const match = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);

    return match || null;
}

function findMysqldumpInDirectory(root: string): string | null {
    if (!existsSync(root)) {
        return null;
    }

    const directCandidates = [
        path.join(root, "mysqldump.exe"),
        path.join(root, "mysqldump"),
        path.join(root, "bin", "mysqldump.exe"),
        path.join(root, "bin", "mysqldump"),
    ];

    for (const candidate of directCandidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    try {
        const childDirs = readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);

        for (const childDir of childDirs) {
            const nestedCandidates = [
                path.join(root, childDir, "mysqldump.exe"),
                path.join(root, childDir, "mysqldump"),
                path.join(root, childDir, "bin", "mysqldump.exe"),
                path.join(root, childDir, "bin", "mysqldump"),
            ];

            for (const candidate of nestedCandidates) {
                if (existsSync(candidate)) {
                    return candidate;
                }
            }
        }
    } catch {
        return null;
    }

    return null;
}

function resolveMysqldumpPath(): string | null {
    const overridePath = process.env.MYSQLDUMP_PATH?.trim();
    if (overridePath && existsSync(overridePath)) {
        return overridePath;
    }

    const pathMatch = resolveCommandOnPath(
        process.platform === "win32" ? "mysqldump.exe" : "mysqldump",
    );
    if (pathMatch) {
        return pathMatch;
    }

    if (process.platform !== "win32") {
        return null;
    }

    const candidateRoots = [
        process.env.MYSQL_BIN_DIR,
        process.env.MYSQL_HOME ? path.join(process.env.MYSQL_HOME, "bin") : undefined,
        "C:\\Program Files\\MySQL",
        "C:\\Program Files\\MariaDB",
        "C:\\xampp\\mysql\\bin",
        "C:\\wamp64\\bin\\mysql",
    ].filter(Boolean) as string[];

    for (const root of candidateRoots) {
        const match = findMysqldumpInDirectory(root);
        if (match) {
            return match;
        }
    }

    return null;
}

/**
 * POST /api/admin/backup
 * Triggers a mysqldump and saves to a timestamped file.
 */
router.post("/backup", async (req: Request, res: Response) => {
    try {
        const dbUrl = process.env.DATABASE_URL || "";
        if (!dbUrl) {
            res.status(500).json({ error: "DATABASE_URL is not configured for backup." });
            return;
        }

        let parsedUrl: URL;
        try {
            parsedUrl = new URL(dbUrl);
        } catch {
            res.status(500).json({ error: "Cannot parse DATABASE_URL for backup." });
            return;
        }

        if (parsedUrl.protocol !== "mysql:") {
            res.status(500).json({ error: "Only MySQL backups are supported by this backup route." });
            return;
        }

        const user = decodeURIComponent(parsedUrl.username);
        const password = decodeURIComponent(parsedUrl.password);
        const host = parsedUrl.hostname;
        const port = parsedUrl.port || "3306";
        const database = parsedUrl.pathname.replace(/^\//, "");

        if (!user || !host || !database) {
            res.status(500).json({ error: "DATABASE_URL is missing required backup connection details." });
            return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `backup_${timestamp}.sql`;
        const filepath = path.resolve(__dirname, "../../../backups", filename);

        mkdirSync(path.dirname(filepath), { recursive: true });

        const mysqldumpPath = resolveMysqldumpPath();
        if (!mysqldumpPath) {
            res.status(500).json({
                error: "Backup failed",
                detail:
                    "mysqldump was not found. Add MySQL bin to PATH or set MYSQLDUMP_PATH in backend/.env.",
            });
            return;
        }

        const output = createWriteStream(filepath, { encoding: "utf8" });
        const dump = spawn(
            mysqldumpPath,
            [
                `--host=${host}`,
                `--port=${port}`,
                `--user=${user}`,
                `--password=${password}`,
                database,
            ],
            { windowsHide: true },
        );

        let stderr = "";
        let responded = false;

        dump.stdout.pipe(output);
        dump.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        dump.on("error", (error) => {
            console.error("Backup error:", error);
            output.destroy();
            if (!responded) {
                responded = true;
                res.status(500).json({ error: "Backup failed", detail: error.message });
            }
        });

        dump.on("close", async (code) => {
            output.end();

            if (responded) {
                return;
            }

            if (code !== 0) {
                console.error("Backup error:", stderr || `mysqldump exited with code ${code}`);
                responded = true;
                res.status(500).json({
                    error: "Backup failed",
                    detail: stderr || `mysqldump exited with code ${code}`,
                });
                return;
            }

            try {
                await prisma.auditLog.create({
                    data: {
                        actorId: req.user!.id,
                        action: "DATABASE_BACKUP",
                        entityType: "System",
                        entityId: "backup",
                        meta: { filename, filepath },
                    },
                });
            } catch (auditError) {
                console.error("Backup audit log error:", auditError);
            }

            responded = true;
            res.json({
                message: "Backup created successfully",
                filename,
                filepath,
                createdAt: new Date().toISOString(),
            });
        });
    } catch (err) {
        console.error("Backup error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
