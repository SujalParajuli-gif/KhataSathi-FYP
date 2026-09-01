# KhataSathi Backup and Recovery Learning Guide

## Why this guide exists

KhataSathi stores business data in both MySQL and server files. A professional backup plan must protect both, keep a copy outside the live server, and prove that the backup can actually be restored.

The central rule is:

> A backup is not trusted until an isolated restore test passes.

This document describes the system that is currently implemented, its limitations, and the operating routine for the catalog pilot.

## 1. What data exists

| Data | Examples | Production location |
| --- | --- | --- |
| Database | users, products, prices, permissions, audit logs, document metadata and Bin state | `mysql_data` Docker volume |
| General uploads | product originals, product thumbnails and profile images | `uploads` volume at `/uploads` |
| Protected documents | bills, PDFs, spreadsheets, document images and thumbnails | `document_storage` volume at `/document-storage` |
| SQL export staging | database-only exports made from the admin UI | `backup_staging` volume at `/backups` |
| Recovery work area | temporary dump and manifest used while taking a snapshot | `recovery_staging` volume |
| Recovery status | safe status summary shown to the admin | `backup_status` volume |
| Restic cache | disposable performance cache | `restic_cache` volume |
| Local rehearsal repository | encrypted snapshots used during local testing | `restic_repository` volume |

Mobile phones do not contain the master data. They request authorized data and media from the server over HTTP/HTTPS. Docker volumes on the server hold the persistent copies.

### Local development paths

Without production environment overrides, the backend uses:

- repository `uploads/` for product/profile media;
- `backend/document-storage/` for protected documents;
- `backend/backups/` for SQL exports;
- `backend/backup-status/` for the latest recovery status.

These runtime folders are excluded from Git. Source control is not a business-data backup.

### Production paths

`compose.production.yml` configures:

```text
UPLOADS_ROOT=/uploads
DOCUMENT_STORAGE_ROOT=/document-storage
BACKUP_ROOT=/backups
BACKUP_STATUS_ROOT=/backup-status
```

Containers are replaceable. Their mounted Docker volumes are persistent. Deleting a container normally does not delete its volumes, but `docker compose down -v`, `docker volume prune`, Docker Desktop factory reset, or Clean/Purge Data can delete them.

## 2. Two backup layers

KhataSathi intentionally has two different backup mechanisms.

| Mechanism | Contains | Best use | Missing from it |
| --- | --- | --- | --- |
| Admin database export | MySQL SQL dump | quick checkpoint before risky data/schema work | every uploaded image and document |
| Full Restic snapshot | MySQL dump, uploads, protected documents and manifest | complete recovery | no application-critical area when successful |

Never describe a database-only export as a full application backup.

## 3. Admin database exports

Settings → Backup allows an administrator to create a database export manually or schedule it daily/weekly.

The backend:

1. creates a `BackupJob` with `RUNNING` status;
2. launches `mysqldump`;
3. writes a timestamped `.sql` file under `BACKUP_ROOT`;
4. records the creator, file name, size, outcome and completion time;
5. creates an audit event;
6. reports `SUCCESS` or `FAILED` in the UI.

The backend checks the UI schedule once per minute. It uses `MYSQL_PWD` for the child process so the password is not placed in the command line. Absolute server paths are removed from API responses.

### When to make one manually

- before a migration;
- before a large import or bulk edit;
- before maintenance that changes many records;
- before deliberately testing a database-only restore.

### Database-only restore warning

The UI restore imports into the configured live database. It requires this exact confirmation:

```text
RESTORE exact_backup_filename.sql
```

This operation is destructive and cannot restore missing files. For example, restoring a product record with an old `imageUrl` does not recreate the referenced image. The isolated full-restore verifier is the normal way to test recovery.

## 4. Full Restic recovery snapshot

The host wrapper is:

```sh
deploy/scripts/backup.sh
```

It starts the isolated Compose `recovery` service, which creates:

- `/payload/backup/current/database.sql`;
- `/payload/backup/current/manifest.json`;
- a snapshot of `/payload/uploads`;
- a snapshot of `/payload/documents`.

This includes product originals and thumbnails, profile images, protected document originals and thumbnails, and files belonging to soft-deleted documents still retained in the Bin.

### Backup sequence

1. validate required environment settings and password file;
2. prevent concurrent backup runs;
3. report `RUNNING`;
4. open or initialize the Restic repository;
5. create a transaction-consistent MySQL dump;
6. count upload and document files;
7. write the manifest;
8. encrypt and deduplicate a full snapshot;
9. apply retention and pruning;
10. report `SUCCESS` or a safe failure stage.

### Manifest contents

The JSON manifest records:

- schema version;
- creation time;
- application Git commit;
- database name;
- expected paths;
- database consistency type;
- upload and document counts;
- database dump size.

It lets the verifier detect an incomplete restoration.

### Status stages

| Stage | Meaning |
| --- | --- |
| `initializing` | preparing and validating |
| `repository` | accessing or initializing Restic |
| `database_dump` | dumping MySQL and writing the manifest |
| `snapshot` | encrypting/deduplicating/storing data |
| `retention` | applying history rules |
| `complete` | snapshot finished |

A `RUNNING` status older than two hours becomes `STALE` and requires server investigation.

### Isolation and security

The recovery service:

- exposes no public port;
- uses only the internal data network;
- mounts uploads/documents read-only;
- uses a read-only container root filesystem;
- drops Linux capabilities;
- prevents privilege escalation;
- does not mount the Docker socket;
- reads its Restic password through a Docker secret;
- uses a small in-memory temporary filesystem.

### Consistency limitation

The SQL dump is transaction-consistent. Files are captured while Restic scans them, not at the exact same millisecond as the database dump. For the single-shop pilot, run backups during low activity and avoid bulk imports/deletions around 02:15 Nepal time.

## 5. Restic concepts

### Encryption

Restic encrypts data before writing it to the repository. The repository password is expected locally at:

```text
deploy/secrets/restic-password
```

The secrets folder is Git-ignored.

Rules:

- never paste the password into chat, commits, screenshots or tickets;
- do not reuse an application login password;
- store it in the owner's password manager;
- later keep a protected offline recovery copy;
- test it against the repository.

Losing it makes the encrypted backup unrecoverable.

### Deduplication

Restic stores unchanged chunks once. Each snapshot behaves like a complete restore point while normally adding only changed data.

### Repository

The local rehearsal uses:

```text
RESTIC_REPOSITORY=/repository
RESTIC_AUTO_INIT=true
```

This is a Docker volume on the same computer. It proves the software workflow but is not disaster-safe.

Before using real shop data, configure an independent S3-compatible or Backblaze B2 repository outside the VPS. A VPS plan includes live disk storage; it does not automatically give an independent backup.

Prefer a provider with MFA, restricted backup credentials, versioning/immutability where affordable, and billing/storage alerts.

## 6. Retention

Current settings:

```text
RESTIC_KEEP_DAILY=14
RESTIC_KEEP_WEEKLY=8
RESTIC_KEEP_MONTHLY=6
```

Restic groups snapshots by calendar periods, so this does not simply mean 28 separate snapshots. One snapshot can satisfy daily, weekly and monthly rules. `forget --prune` removes data no longer referenced by retained snapshots.

Measure real storage growth before changing retention.

## 7. Production schedule

The VPS will use:

- `deploy/systemd/khatasathi-backup.timer`;
- `deploy/systemd/khatasathi-backup.service`.

It runs nightly at 02:15 Asia/Kathmandu with a random delay of up to five minutes. `Persistent=true` allows a missed run to be triggered after the timer becomes active again.

Later VPS checks:

```sh
sudo systemctl status khatasathi-backup.timer
sudo systemctl list-timers khatasathi-backup.timer
sudo systemctl start khatasathi-backup.service
sudo journalctl -u khatasathi-backup.service --since today
```

## 8. Isolated restore verification

The verifier handles decrypted database and file data temporarily and manages
isolated Docker resources, so run it as root on Linux/WSL:

```sh
sudo sh deploy/scripts/verify-restore.sh latest
```

or supply a hexadecimal snapshot ID.

The verifier:

1. runs `restic check`;
2. restores into a root-owned temporary directory; only this restore process receives
   the narrowly scoped Linux `CHOWN` capability that Restic needs to recreate file
   ownership metadata;
3. verifies dump, manifest and file areas;
4. compares restored file counts with the manifest;
5. creates a temporary Docker volume and MySQL 8.4 container;
6. imports the restored SQL;
7. verifies database tables plus `User`, `Product` and `Document`;
8. removes the temporary container, volume and directory.

It never overwrites the live volumes.

The normal recovery service and the live application containers continue to run
with their configured capability restrictions. The temporary `CHOWN` allowance
exists only for the `restic restore` invocation and disappears with that container.

A pass proves repository access, password/credentials, decryption, extraction, file counts, SQL importability, and critical table presence. It does not prove that every business value is semantically correct, so a later full application rehearsal must also sample logins, roles, products, images and documents.

## 9. Real disaster recovery

Never immediately overwrite live volumes.

1. stop application writes;
2. preserve the current damaged state for investigation;
3. select and verify the desired snapshot;
4. restore into new empty volumes;
5. start an isolated application against them;
6. test authentication, roles, products, media, documents and audit history;
7. record who approved the recovery and snapshot ID;
8. switch production to the verified recovered volumes;
9. retain old volumes temporarily until the owner confirms success.

There is intentionally no one-click browser button for full-system replacement.

## 10. Integrity report versus backup

Settings → Backup includes a read-only storage integrity report. It checks:

- database references whose files are missing;
- files not referenced by the database;
- temporary document files older than 24 hours;
- inaccessible roots;
- counts and sizes.

It includes inactive products and Bin documents. It does not delete or repair data. Integrity detects mismatches; backup provides a recovery copy.

## 11. Bin behavior

Soft-deleted documents keep their records and retained files during the safety window, so full snapshots include them. Permanent deletion removes the live copy, but older snapshots may retain it until retention expires.

A full snapshot restores a whole captured system state; it is not a single-file undelete control.

## 12. Operating routine

### Daily

- check latest full backup is `SUCCESS`;
- investigate `FAILED`, `STALE` or `UNAVAILABLE`.

### Weekly

- review status and storage growth;
- run/review the integrity report;
- confirm remote repository access.

### Monthly

- run `verify-restore.sh latest`;
- record the date, snapshot ID, result and reviewer.

### Before risky changes

- create a database export;
- create a full snapshot;
- confirm success before proceeding.

### After material migrations/deployments

- verify application health;
- create a full snapshot;
- rerun isolated restore verification.

## 13. Failure examples

| Failure | Protection |
| --- | --- |
| wrong product edit | older database/full restore point; targeted correction preferred |
| missing product image | full snapshot; SQL export is insufficient |
| accidental document deletion | Bin first, full snapshot if needed |
| database corruption | verified SQL dump restored into new volumes |
| VPS disk loss | off-VPS repository |
| local repository loss | none unless another independent copy exists |
| lost Restic password | only the secured password-manager/offline copy |
| malicious repository deletion | provider versioning/immutability and restricted credentials |
| stale backup status | inspect service logs before starting another run |
| retention cleanup failure | snapshot may remain valid; investigate capacity and retry safely |

## 14. RPO and RTO

- **RPO:** acceptable amount of recent data loss. A nightly snapshot gives roughly a one-day worst-case target unless manual snapshots are added.
- **RTO:** acceptable recovery time.

For catalog mode, start with nightly snapshots, manual snapshots before risky changes, and monthly restore rehearsals. Tighten these objectives before enabling real POS/payment workflows.

## 15. Local rehearsal checklist

- [x] Docker Desktop uses WSL 2.
- [x] Docker Engine and Compose work.
- [x] ignored environment and Restic password files exist.
- [x] Compose configuration renders.
- [x] MySQL, backend and web are healthy.
- [x] current database and file data are copied into isolated volumes.
- [x] first full Restic snapshot succeeds.
- [x] isolated restore verification succeeds (snapshot `8886e5d8`, 42 tables,
  15 upload files and 5 document files verified on 2026-08-11).
- [ ] all five approved active accounts are tested manually after the clean-pilot transfer.
- [x] images/documents are sampled in the browser.
- [x] persistence survives container recreation (10 users, 909 products, 3
  documents, 19 uploads and 5 document files retained an identical media
  fingerprint on 2026-08-13).
- [x] resource usage and response time are measured (six concurrent clients,
  zero failures, approximately 542 MiB combined container memory and no
  restarts/OOM events on 2026-08-13).
- [ ] an off-VPS repository is selected and tested.

Do not purchase the VPS merely to discover a local recovery problem. Purchase it after the local restore rehearsal and functional checks pass.

## 16. Implementation map

| File | Responsibility |
| --- | --- |
| `compose.production.yml` | services, storage volumes, networks and secret mount |
| `backend/src/modules/admin/backup.ts` | SQL exports, DB-only restore, schedule and endpoints |
| `backend/src/modules/admin/recoveryBackupStatus.ts` | sanitized full-backup status |
| `backend/src/modules/admin/storageIntegrity.ts` | read-only DB/filesystem comparison |
| `deploy/recovery/Dockerfile` | isolated recovery tool image |
| `deploy/recovery/run-backup.sh` | dump, manifest, Restic and retention logic |
| `deploy/scripts/backup.sh` | host backup wrapper |
| `deploy/scripts/verify-restore.sh` | isolated recovery verification |
| `deploy/systemd/khatasathi-backup.timer` | nightly schedule |
| `deploy/systemd/khatasathi-backup.service` | VPS backup service |
| `deploy/production.env.example` | configuration template |

## 17. Glossary

- **Backup:** a separate recoverable copy.
- **Snapshot:** a named Restic restore point.
- **Repository:** encrypted snapshot storage.
- **Restore:** recreating usable data from a backup.
- **Restore rehearsal:** restoration into isolation without touching live data.
- **Container:** replaceable running package for a service.
- **Volume:** persistent data managed separately from a container.
- **Dump:** SQL representation of database structure/data.
- **Manifest:** expected contents and counts for a snapshot.
- **Deduplication:** storing unchanged chunks once.
- **Retention:** rules for keeping old restore points.
- **Prune:** remove unreferenced repository data.
- **Off-VPS:** storage outside the live server's failure domain.
- **Soft delete:** retaining a hidden record temporarily.
- **Integrity check:** comparison for mismatches; not a backup.

## Official references

- [Docker Desktop installation on Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Docker Desktop WSL 2 backend](https://docs.docker.com/desktop/features/wsl/)
- [Microsoft WSL installation](https://learn.microsoft.com/windows/wsl/install)
- [Restic documentation](https://restic.readthedocs.io/en/stable/)
