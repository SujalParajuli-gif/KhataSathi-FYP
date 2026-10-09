"""Validate standing local feature-migration authority. Never executes SQL."""
import hashlib
import re
from tools.ks_supervisor.repo import parse_checkpoint


def validate_feature_migration(config, host, database, sql, reviewed_sha256, *, owned_disposable=False,
                               prior_document_types=()):
    authority = parse_checkpoint(config.checkpoint_path).raw_fields.get("FEATURE_MIGRATION_STANDING_AUTHORIZATION", "")
    if not authority or hashlib.sha256(sql.encode()).hexdigest() != reviewed_sha256:
        raise ValueError("Missing standing authority or reviewed SQL fingerprint")
    if host not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Production/unknown migration target remains gated")
    configured = database == "khatasathi_vps_copy_20261003" and database in authority
    disposable = owned_disposable and re.fullmatch(r"ks_verify_phase4_[a-z0-9_]+", database) and "disposable" in authority
    if not (configured or disposable):
        raise ValueError("Target is outside scoped standing migration authorization")
    clean = re.sub(r"--[^\n]*|/\*.*?\*/", "", sql, flags=re.S)
    actions_removed = re.sub(r"\bON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|NO ACTION|SET NULL)\b", "", clean, flags=re.I)
    if re.search(r"\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|REPLACE|RENAME)\b", actions_removed, re.I):
        raise ValueError("Destructive/backfill SQL requires separate approval")
    for statement in filter(str.strip, clean.split(";")):
        if re.search(r"\b(?:SELECT|LIKE)\b", statement, re.I):
            raise ValueError("Data-copy/backfill shape requires separate approval")
        if re.search(r"REFERENCES\s+(?:`[^`]+`|\w+)\s*\.", statement, re.I):
            raise ValueError("Cross-schema target remains gated")
        if re.match(r"\s*CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s", statement, re.I):
            if not (re.match(r"\s*CREATE TABLE `[^`]+`\s*\(", statement, re.I)
                    or re.match(r"\s*CREATE (?:UNIQUE )?INDEX `[^`]+`\s+ON `[^`]+`\s*\(", statement, re.I)):
                raise ValueError("Unclassified/cross-schema CREATE remains gated")
            continue
        if not re.match(r"\s*ALTER\s+TABLE\s+`[^`]+`\s+(?:ADD|MODIFY)\b", statement, re.I):
            raise ValueError("Unclassified migration shape remains gated")
        if re.search(r"\bMODIFY\b", statement, re.I):
            values = re.findall(r"'([^']+)'", statement)
            if (not prior_document_types or values != list(prior_document_types) + ["PURCHASE_BILL"]
                    or not re.match(r"\s*ALTER TABLE `Document` MODIFY `documentType` ENUM\(", statement)):
                raise ValueError("Only reviewed append-only document enum extension is preapproved")
        elif not re.search(r"\bADD\b", statement, re.I):
            raise ValueError("Unclassified ALTER remains gated")
        elif re.search(r"\bADD\s+(?:COLUMN\s+)?`[^`]+`[^,]*\bNOT NULL\b", statement, re.I):
            raise ValueError("Historical NOT NULL column change requires explicit review/approval")
    return {"authorized": True, "target": database, "sql_sha256": reviewed_sha256,
            "scope": "reviewed non-destructive feature migration; no configured synthetic writes"}
