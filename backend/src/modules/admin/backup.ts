// src/modules/admin/backup.ts — Backup endpoint (admin only)
import { Router, Request, Response } from "express";
import { exec } from "child_process";
import path from "path";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import prisma from "../../db/prisma";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard);
router.use(requireRole("ADMIN"));

/**
 * POST /api/admin/backup
 * Triggers a mysqldump and saves to a timestamped file.
 */
router.post("/backup", async (req: Request, res: Response) => {
    try {
        // Extract DB connection info from DATABASE_URL
        const dbUrl = process.env.DATABASE_URL || "";
        const match = dbUrl.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);

        if (!match) {
            res.status(500).json({ error: "Cannot parse DATABASE_URL for backup" });
            return;
        }

        const [, user, password, host, port, database] = match;

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `backup_${timestamp}.sql`;
        const filepath = path.resolve(__dirname, "../../../backups", filename);

        // Ensure backups directory exists
        const { mkdirSync } = await import("fs");
        mkdirSync(path.dirname(filepath), { recursive: true });

        const cmd = `mysqldump -u ${user} -p${password} -h ${host} -P ${port} ${database} > "${filepath}"`;

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error("Backup error:", error);
                res.status(500).json({ error: "Backup failed", detail: error.message });
                return;
            }

            // Log the backup action
            prisma.auditLog.create({
                data: {
                    actorId: req.user!.id,
                    action: "DATABASE_BACKUP",
                    entityType: "System",
                    entityId: "backup",
                    meta: { filename, filepath },
                },
            }).catch(console.error);

            res.json({ message: "Backup created", filename, filepath });
        });
    } catch (err) {
        console.error("Backup error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
