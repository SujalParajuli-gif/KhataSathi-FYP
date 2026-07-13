import { Router, Request, Response } from "express";
import { spawn, spawnSync } from "child_process";
import {
    createReadStream,
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
} from "fs";
import path from "path";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import prisma from "../../db/prisma";
import { logger } from "../../lib/logger";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard);
router.use(requireRole("ADMIN"));

const BACKUP_SETTINGS_ID = 1;
const BACKUP_ROOT = path.resolve(__dirname, "../../../backups");

type MySqlTool = "mysql" | "mysqldump";
type BackupActor = { id: string; isSystem?: boolean };

type DbConfig = {
    user: string;
    password: string;
    host: string;
    port: string;
    database: string;
};

function resolveCommandOnPath(command: string): string | null {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const result = spawnSync(locator, [command], {
        encoding: "utf8",
        windowsHide: true,
    });

    if (result.status !== 0) return null;

    return (
        result.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean) || null
    );
}

function findToolInDirectory(root: string, tool: MySqlTool): string | null {
    if (!existsSync(root)) return null;

    const names =
        process.platform === "win32" ? [`${tool}.exe`, tool] : [tool, `${tool}.exe`];
    const directCandidates = names.flatMap((name) => [
        path.join(root, name),
        path.join(root, "bin", name),
    ]);

    for (const candidate of directCandidates) {
        if (existsSync(candidate)) return candidate;
    }

    try {
        const childDirs = readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);

        for (const childDir of childDirs) {
            for (const name of names) {
                const nestedCandidates = [
                    path.join(root, childDir, name),
                    path.join(root, childDir, "bin", name),
                ];
                for (const candidate of nestedCandidates) {
                    if (existsSync(candidate)) return candidate;
                }
            }
        }
    } catch {
        return null;
    }

    return null;
}

function resolveMySqlToolPath(tool: MySqlTool): string | null {
    const override =
        tool === "mysqldump"
            ? process.env.MYSQLDUMP_PATH?.trim()
            : process.env.MYSQL_PATH?.trim();
    if (override && existsSync(override)) return override;

    const pathMatch = resolveCommandOnPath(
        process.platform === "win32" ? `${tool}.exe` : tool,
    );
    if (pathMatch) return pathMatch;

    if (process.platform !== "win32") return null;

    const candidateRoots = [
        process.env.MYSQL_BIN_DIR,
        process.env.MYSQL_HOME ? path.join(process.env.MYSQL_HOME, "bin") : undefined,
        "C:\\Program Files\\MySQL",
        "C:\\Program Files\\MariaDB",
        "C:\\xampp\\mysql\\bin",
        "C:\\wamp64\\bin\\mysql",
    ].filter(Boolean) as string[];

    for (const root of candidateRoots) {
        const match = findToolInDirectory(root, tool);
        if (match) return match;
    }

    return null;
}

function parseDatabaseConfig(): DbConfig {
    const dbUrl = process.env.DATABASE_URL || "";
    if (!dbUrl) throw new Error("DATABASE_URL is not configured.");

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(dbUrl);
    } catch {
        throw new Error("Cannot parse DATABASE_URL.");
    }

    if (parsedUrl.protocol !== "mysql:") {
        throw new Error("Only MySQL backup and restore are supported.");
    }

    const user = decodeURIComponent(parsedUrl.username);
    const password = decodeURIComponent(parsedUrl.password);
    const host = parsedUrl.hostname;
    const port = parsedUrl.port || "3306";
    const database = parsedUrl.pathname.replace(/^\//, "");

    if (!user || !host || !database) {
        throw new Error("DATABASE_URL is missing required connection details.");
    }

    return { user, password, host, port, database };
}

function mysqlArgs(config: DbConfig) {
    return [
        `--host=${config.host}`,
        `--port=${config.port}`,
        `--user=${config.user}`,
        `--password=${config.password}`,
        config.database,
    ];
}

function timestampedBackupFile() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `backup_${timestamp}.sql`;
}

function safeBackupPath(filepath: string) {
    const resolvedRoot = path.resolve(BACKUP_ROOT);
    const resolvedPath = path.resolve(filepath);
    const relative = path.relative(resolvedRoot, resolvedPath);

    if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        path.extname(resolvedPath).toLowerCase() !== ".sql"
    ) {
        throw new Error("Backup file path is not allowed.");
    }

    if (!existsSync(resolvedPath)) throw new Error("Backup file no longer exists.");
    return resolvedPath;
}

async function findSystemBackupActor() {
    const admin = await prisma.user.findFirst({
        where: { role: "ADMIN", isActive: true },
        orderBy: { createdAt: "asc" },
        select: { id: true },
    });
    return admin?.id || null;
}

export async function getBackupSettings() {
    return prisma.backupSettings.upsert({
        where: { id: BACKUP_SETTINGS_ID },
        update: {},
        create: {
            id: BACKUP_SETTINGS_ID,
            enabled: false,
            frequency: "DAILY",
            timeOfDay: "02:00",
        },
    });
}

function normalizeTimeOfDay(value: unknown) {
    const raw = String(value || "").trim();
    if (!/^\d{2}:\d{2}$/.test(raw)) {
        throw new Error("Backup time must use HH:mm format.");
    }
    const [hour, minute] = raw.split(":").map(Number);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        throw new Error("Backup time must be a valid 24-hour time.");
    }
    return raw;
}

function shouldRunSchedule(settings: Awaited<ReturnType<typeof getBackupSettings>>) {
    if (!settings.enabled) return false;

    const now = new Date();
    const [hour, minute] = settings.timeOfDay.split(":").map(Number);
    const dueToday = new Date(now);
    dueToday.setHours(hour, minute, 0, 0);

    if (now < dueToday) return false;
    if (settings.frequency === "WEEKLY" && settings.dayOfWeek !== null) {
        if (now.getDay() !== settings.dayOfWeek) return false;
    }
    if (!settings.lastRunAt) return true;

    const lastRun = new Date(settings.lastRunAt);
    const sameDate =
        lastRun.getFullYear() === now.getFullYear() &&
        lastRun.getMonth() === now.getMonth() &&
        lastRun.getDate() === now.getDate();

    if (settings.frequency === "DAILY") return !sameDate;

    const oneWeekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    return lastRun.getTime() < oneWeekAgo;
}

export async function runBackupJob(actor: BackupActor, source: "MANUAL" | "SCHEDULED") {
    const config = parseDatabaseConfig();
    const mysqldumpPath = resolveMySqlToolPath("mysqldump");
    const filename = timestampedBackupFile();
    const filepath = path.resolve(BACKUP_ROOT, filename);
    mkdirSync(BACKUP_ROOT, { recursive: true });

    const backupJob = await prisma.backupJob.create({
        data: {
            type: "BACKUP",
            status: "RUNNING",
            filename,
            filepath,
            message: `${source === "SCHEDULED" ? "Scheduled" : "Manual"} backup started`,
            createdById: actor.id,
        },
    });

    if (!mysqldumpPath) {
        const detail =
            "mysqldump was not found. Add MySQL bin to PATH or set MYSQLDUMP_PATH in backend/.env.";
        const failed = await prisma.backupJob.update({
            where: { id: backupJob.id },
            data: {
                status: "FAILED",
                message: "mysqldump was not found",
                detail,
                completedAt: new Date(),
            },
            include: { createdBy: { select: { id: true, name: true, email: true, role: true } } },
        });
        throw Object.assign(new Error(detail), { backup: failed });
    }

    return new Promise<any>((resolve, reject) => {
        const output = createWriteStream(filepath, { encoding: "utf8" });
        const dump = spawn(mysqldumpPath, mysqlArgs(config), { windowsHide: true });
        let stderr = "";
        let settled = false;

        dump.stdout.pipe(output);
        dump.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        dump.on("error", async (error) => {
            output.destroy();
            if (settled) return;
            settled = true;
            const failed = await prisma.backupJob.update({
                where: { id: backupJob.id },
                data: {
                    status: "FAILED",
                    message: "Backup process could not start",
                    detail: error.message,
                    completedAt: new Date(),
                },
                include: { createdBy: { select: { id: true, name: true, email: true, role: true } } },
            });
            reject(Object.assign(error, { backup: failed }));
        });

        dump.on("close", async (code) => {
            output.end();
            if (settled) return;
            settled = true;

            if (code !== 0) {
                const detail = stderr || `mysqldump exited with code ${code}`;
                const failed = await prisma.backupJob.update({
                    where: { id: backupJob.id },
                    data: {
                        status: "FAILED",
                        message: "mysqldump failed",
                        detail,
                        completedAt: new Date(),
                    },
                    include: { createdBy: { select: { id: true, name: true, email: true, role: true } } },
                });
                reject(Object.assign(new Error(detail), { backup: failed }));
                return;
            }

            const sizeBytes = statSync(filepath).size;
            const completed = await prisma.backupJob.update({
                where: { id: backupJob.id },
                data: {
                    status: "SUCCESS",
                    sizeBytes,
                    message: `${source === "SCHEDULED" ? "Scheduled" : "Manual"} backup created successfully`,
                    completedAt: new Date(),
                },
                include: { createdBy: { select: { id: true, name: true, email: true, role: true } } },
            });

            await prisma.auditLog.create({
                data: {
                    actorId: actor.id,
                    action: source === "SCHEDULED" ? "DATABASE_BACKUP_SCHEDULED" : "DATABASE_BACKUP",
                    entityType: "System",
                    entityId: "backup",
                    meta: { backupJobId: backupJob.id, filename, filepath, sizeBytes },
                },
            }).catch((auditError) => {
                logger.error("Backup audit log error", auditError);
            });

            resolve(completed);
        });
    });
}

async function runRestoreJob(backupId: string, actorId: string, confirmation: string) {
    const source = await prisma.backupJob.findUnique({
        where: { id: backupId },
    });
    if (!source || source.type !== "BACKUP" || source.status !== "SUCCESS") {
        throw new Error("Select a successful backup to restore.");
    }
    if (!source.filepath || !source.filename) {
        throw new Error("Backup file details are missing.");
    }
    if (confirmation !== `RESTORE ${source.filename}`) {
        throw new Error(`Type RESTORE ${source.filename} to confirm database restore.`);
    }

    const config = parseDatabaseConfig();
    const mysqlPath = resolveMySqlToolPath("mysql");
    const restorePath = safeBackupPath(source.filepath);
    const restoreJob = await prisma.backupJob.create({
        data: {
            type: "RESTORE",
            status: "RUNNING",
            filename: source.filename,
            filepath: restorePath,
            message: "Restore started",
            createdById: actorId,
        },
    });

    if (!mysqlPath) {
        const detail =
            "mysql client was not found. Add MySQL bin to PATH or set MYSQL_PATH in backend/.env.";
        return prisma.backupJob.update({
            where: { id: restoreJob.id },
            data: { status: "FAILED", message: "mysql was not found", detail, completedAt: new Date() },
            include: { createdBy: { select: { id: true, name: true, email: true, role: true } } },
        }).then((failed) => {
            throw Object.assign(new Error(detail), { backup: failed });
        });
    }

    return new Promise<any>((resolve, reject) => {
        const restore = spawn(mysqlPath, mysqlArgs(config), { windowsHide: true });
        const input = createReadStream(restorePath, { encoding: "utf8" });
        let stderr = "";
        let settled = false;

        input.pipe(restore.stdin);
        restore.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        restore.on("error", async (error) => {
            if (settled) return;
            settled = true;
            const failed = await prisma.backupJob.update({
                where: { id: restoreJob.id },
                data: {
                    status: "FAILED",
                    message: "Restore process could not start",
                    detail: error.message,
                    completedAt: new Date(),
                },
                include: { createdBy: { select: { id: true, name: true, email: true, role: true } } },
            });
            reject(Object.assign(error, { backup: failed }));
        });
        restore.on("close", async (code) => {
            if (settled) return;
            settled = true;

            if (code !== 0) {
                const detail = stderr || `mysql exited with code ${code}`;
                const failed = await prisma.backupJob.update({
                    where: { id: restoreJob.id },
                    data: { status: "FAILED", message: "Restore failed", detail, completedAt: new Date() },
                    include: { createdBy: { select: { id: true, name: true, email: true, role: true } } },
                });
                reject(Object.assign(new Error(detail), { backup: failed }));
                return;
            }

            const completed = await prisma.backupJob.update({
                where: { id: restoreJob.id },
                data: {
                    status: "SUCCESS",
                    message: "Restore completed successfully",
                    completedAt: new Date(),
                },
                include: { createdBy: { select: { id: true, name: true, email: true, role: true } } },
            });
            await prisma.auditLog.create({
                data: {
                    actorId,
                    action: "DATABASE_RESTORE",
                    entityType: "System",
                    entityId: "restore",
                    meta: { backupJobId: source.id, restoreJobId: restoreJob.id, filename: source.filename },
                },
            }).catch((auditError) => {
                logger.error("Restore audit log error", auditError);
            });
            resolve(completed);
        });
    });
}

export async function runDueScheduledBackup() {
    const settings = await getBackupSettings();
    if (!shouldRunSchedule(settings)) return { ran: false };

    const actorId = settings.updatedById || (await findSystemBackupActor());
    if (!actorId) {
        logger.error("Scheduled backup skipped because no admin actor exists");
        return { ran: false, error: "No admin actor exists." };
    }

    try {
        const backup = await runBackupJob({ id: actorId, isSystem: true }, "SCHEDULED");
        await prisma.backupSettings.update({
            where: { id: BACKUP_SETTINGS_ID },
            data: { lastRunAt: new Date() },
        });
        return { ran: true, backup };
    } catch (error) {
        logger.error("Scheduled backup failed", error);
        await prisma.auditLog.create({
            data: {
                actorId,
                action: "SCHEDULED_BACKUP_FAILED",
                entityType: "BackupJob",
                entityId: (error as any)?.backup?.id || "scheduled-backup",
                meta: {
                    backupJobId: (error as any)?.backup?.id || null,
                    message: (error as any)?.backup?.message || null,
                    error: error instanceof Error ? error.message : String(error || ""),
                },
            },
        }).catch((auditError) => {
            logger.error("Scheduled backup failure audit log error", auditError);
        });
        await prisma.backupSettings.update({
            where: { id: BACKUP_SETTINGS_ID },
            data: { lastRunAt: new Date() },
        }).catch(() => undefined);
        return { ran: true, error };
    }
}

router.get("/backups", async (_req: Request, res: Response) => {
    try {
        const backups = await prisma.backupJob.findMany({
            orderBy: { createdAt: "desc" },
            take: 50,
            include: {
                createdBy: { select: { id: true, name: true, email: true, role: true } },
            },
        });
        res.json({ backups });
    } catch (err) {
        logger.error("List backup history error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/backup-schedule", async (_req: Request, res: Response) => {
    try {
        res.json(await getBackupSettings());
    } catch (err) {
        logger.error("Get backup schedule error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.put("/backup-schedule", async (req: Request, res: Response) => {
    try {
        const frequency = String(req.body?.frequency || "DAILY").toUpperCase();
        if (frequency !== "DAILY" && frequency !== "WEEKLY") {
            res.status(400).json({ error: "frequency must be DAILY or WEEKLY." });
            return;
        }

        const dayOfWeek =
            frequency === "WEEKLY" ? Math.max(0, Math.min(6, Number(req.body?.dayOfWeek ?? 1))) : null;
        const settings = await prisma.backupSettings.upsert({
            where: { id: BACKUP_SETTINGS_ID },
            update: {
                enabled: Boolean(req.body?.enabled),
                frequency,
                timeOfDay: normalizeTimeOfDay(req.body?.timeOfDay),
                dayOfWeek,
                updatedById: req.user!.id,
            },
            create: {
                id: BACKUP_SETTINGS_ID,
                enabled: Boolean(req.body?.enabled),
                frequency,
                timeOfDay: normalizeTimeOfDay(req.body?.timeOfDay),
                dayOfWeek,
                updatedById: req.user!.id,
            },
        });

        await prisma.auditLog.create({
            data: {
                actorId: req.user!.id,
                action: "BACKUP_SCHEDULE_UPDATED",
                entityType: "BackupSettings",
                entityId: String(settings.id),
                meta: settings,
            },
        });

        res.json(settings);
    } catch (err: any) {
        if (err.message?.includes("Backup time")) {
            res.status(400).json({ error: err.message });
            return;
        }
        logger.error("Update backup schedule error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/backup", async (req: Request, res: Response) => {
    try {
        const backup = await runBackupJob({ id: req.user!.id }, "MANUAL");
        res.json({
            message: "Backup created successfully",
            filename: backup.filename,
            filepath: backup.filepath,
            backup,
            createdAt: backup.createdAt,
        });
    } catch (err: any) {
        logger.error("Backup error", err);
        res.status(500).json({
            error: "Backup failed",
            detail: err.message || "Internal server error",
            backup: err.backup,
        });
    }
});

router.post("/backups/:id/restore", async (req: Request, res: Response) => {
    try {
        const restore = await runRestoreJob(
            String(req.params.id),
            req.user!.id,
            String(req.body?.confirmation || ""),
        );
        res.json({ message: "Restore completed successfully", backup: restore });
    } catch (err: any) {
        const known =
            err.message?.includes("RESTORE") ||
            err.message?.includes("backup") ||
            err.message?.includes("Backup") ||
            err.message?.includes("mysql") ||
            err.message?.includes("allowed");
        res.status(known ? 400 : 500).json({
            error: known ? err.message : "Restore failed",
            detail: known ? undefined : err.message,
            backup: err.backup,
        });
    }
});

export default router;
