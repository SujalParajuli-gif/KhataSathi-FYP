import { Router, Request, Response } from "express";
import { spawn, spawnSync } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import prisma from "../../db/prisma";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard);
router.use(requireRole("ADMIN")); // only admin can trigger database backups

// checking if a command (like mysqldump) exists in the system PATH
// on Windows we use "where.exe" and on Linux/Mac we use "which"
function resolveCommandOnPath(command: string): string | null {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const result = spawnSync(locator, [command], {
        encoding: "utf8",
        windowsHide: true, // hiding the console window on Windows
    });

    if (result.status !== 0) {
        return null; // command not found on PATH
    }

    // taking the first line of output which is the full path to the command
    const match = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);

    return match || null;
}

// searching for mysqldump binary in a directory and its immediate subdirectories
// we check both the root and a "bin" subfolder since MySQL installs put it in different places
function findMysqldumpInDirectory(root: string): string | null {
    if (!existsSync(root)) {
        return null;
    }

    // checking common locations where mysqldump might be placed
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

    // if not found directly, scanning one level deeper (for versioned directories like "MySQL 8.0")
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

// finding the mysqldump binary on the system — we try multiple strategies:
// 1. first check if MYSQLDUMP_PATH is set in the environment
// 2. then check if mysqldump is on the system PATH
// 3. on Windows, scan common MySQL installation directories
function resolveMysqldumpPath(): string | null {
    // checking the override env variable first — the user can set this if mysqldump is in a custom location
    const overridePath = process.env.MYSQLDUMP_PATH?.trim();
    if (overridePath && existsSync(overridePath)) {
        return overridePath;
    }

    // trying to find mysqldump on the system PATH
    const pathMatch = resolveCommandOnPath(
        process.platform === "win32" ? "mysqldump.exe" : "mysqldump",
    );
    if (pathMatch) {
        return pathMatch;
    }

    // on non-Windows systems, we stop here since the common directories are Windows-specific
    if (process.platform !== "win32") {
        return null;
    }

    // scanning known Windows MySQL installation directories
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

// --

// handling the database backup request — uses mysqldump to export the entire database to a SQL file
// the backup is saved in the backend/backups/ directory with a timestamped filename
router.post("/backup", async (req: Request, res: Response) => {
    try {
        // parsing the MySQL connection details from the DATABASE_URL environment variable
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

        // only MySQL backups are supported — Prisma might use other databases but our backup only works with MySQL
        if (parsedUrl.protocol !== "mysql:") {
            res.status(500).json({ error: "Only MySQL backups are supported by this backup route." });
            return;
        }

        // extracting individual connection details from the URL
        const user = decodeURIComponent(parsedUrl.username);
        const password = decodeURIComponent(parsedUrl.password);
        const host = parsedUrl.hostname;
        const port = parsedUrl.port || "3306"; // defaulting to MySQL's standard port
        const database = parsedUrl.pathname.replace(/^\//, ""); // removing the leading slash from the path

        if (!user || !host || !database) {
            res.status(500).json({ error: "DATABASE_URL is missing required backup connection details." });
            return;
        }

        // creating a timestamped filename and making sure the backups directory exists
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `backup_${timestamp}.sql`;
        const filepath = path.resolve(__dirname, "../../../backups", filename);

        mkdirSync(path.dirname(filepath), { recursive: true }); // creating the directory if it does not exist

        const mysqldumpPath = resolveMysqldumpPath();
        if (!mysqldumpPath) {
            res.status(500).json({
                error: "Backup failed",
                detail:
                    "mysqldump was not found. Add MySQL bin to PATH or set MYSQLDUMP_PATH in backend/.env.",
            });
            return;
        }

        // spawning mysqldump as a child process and piping its output directly to a file
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

        let stderr = ""; // collecting any error output from mysqldump
        let responded = false; // tracking whether we have already sent a response

        dump.stdout.pipe(output); // piping the SQL dump directly to the output file
        dump.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        // handling spawn errors (e.g., mysqldump binary not executable)
        dump.on("error", (error) => {
            console.error("Backup error:", error);
            output.destroy();
            if (!responded) {
                responded = true;
                res.status(500).json({ error: "Backup failed", detail: error.message });
            }
        });

        // handling the process exit — checking if the backup was successful
        dump.on("close", async (code) => {
            output.end();

            if (responded) {
                return; // we already sent an error response from the "error" handler
            }

            // non-zero exit code means mysqldump failed (wrong credentials, missing database, etc.)
            if (code !== 0) {
                console.error("Backup error:", stderr || `mysqldump exited with code ${code}`);
                responded = true;
                res.status(500).json({
                    error: "Backup failed",
                    detail: stderr || `mysqldump exited with code ${code}`,
                });
                return;
            }

            // creating an audit log entry so the admin can see when backups were taken and by whom
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
                // we do not fail the backup response if the audit log fails — the backup itself succeeded
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
