"""Read-only Git path-policy gate. Prints no file contents or credentials."""
import argparse
from pathlib import Path
import re
import subprocess
import sys

POLICY = Path(__file__).resolve().parents[1] / "SKILL.md"
RETIRED = set(re.findall(r"^\s+- `([^`]+)`\s*$", POLICY.read_text(encoding="utf-8"), re.M))
RETIRED = {p.lower() for p in RETIRED}
CANONICAL_WORKFLOW_FILES = {
    "AGENTS.md",
    "GEMINI.md",
    "docs/engineering/ai/README.md",
    "docs/engineering/ai/tasks/TASK_TEMPLATE.md",
    "docs/engineering/ai/reports/IMPLEMENTATION_REPORT_TEMPLATE.md",
    "docs/engineering/ai/reviews/REVIEW_TEMPLATE.md",
    ".agents/skills/repository-commit-hygiene/SKILL.md",
    ".agents/skills/repository-commit-hygiene/scripts/check_hygiene.py",
    ".agents/skills/repository-commit-hygiene/scripts/test_hygiene.py",
    ".agents/skills/khatasathi-workflow-router/SKILL.md",
    ".agents/skills/khatasathi-implementation-planner/SKILL.md",
}
ARTIFACT_DIRS = {".agents", "thingsforai", "node_modules", "dist", "build", "coverage",
                 "test-results", "playwright-report", "__pycache__", ".cache", ".vite",
                 ".react-router", ".playwright-cli", ".impeccable", "uploads", "backups"}


def violation(path):
    normalized = path.replace("\\", "/")
    if normalized in CANONICAL_WORKFLOW_FILES:
        return None
    p = normalized.lower()
    parts = p.split("/")
    name = parts[-1]
    if p == "readme.md":
        return None
    if name.endswith(".md"):
        return "Markdown other than root README"
    if p in RETIRED or p == "backend/check_db.ts":
        return "retired/internal tooling"
    if set(parts[:-1]) & ARTIFACT_DIRS:
        return "local/generated/runtime directory"
    if p.startswith(("scripts/", "document-storage/")):
        return "local workspace or runtime data"
    if name == ".env" or name.startswith(".env.") or name.endswith(".env") or ".env." in name:
        return "environment file"
    if name.endswith((".log", ".sqlite", ".sqlite3", ".db", ".pyc")):
        return "runtime/cache file"
    if p == "frontend/public/.well-known/appspecific/com.chrome.devtools.json":
        return "browser metadata"
    return None


def git(repo, *args, allow_unborn=False):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True)
    if result.returncode:
        if allow_unborn:
            return b""
        raise RuntimeError("git " + " ".join(args) + " failed; verify repository access")
    return result.stdout


def paths(data):
    return {s.decode("utf-8", errors="surrogateescape") for s in data.split(b"\0") if s}


SENSITIVE_CATEGORIES = [
    ("ssh-or-private-key", r"-----BEGIN ([-A-Z0-9_]+ )?PRIVATE KEY( BLOCK)?-----", False),
    ("private-certificate", r"-----BEGIN ([-A-Z0-9_]+ )?CERTIFICATE( BLOCK)?-----", False),
    ("aws-access-key", r"\bAKIA[0-9A-Z]{16}\b", False),
    ("github-token", r"\b(ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{50,})\b", False),
    ("slack-token", r"\bxox[baprs]-[0-9a-zA-Z]{10,}\b", False),
    ("api-key-or-token", r"(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token)\s*[:=]\s*['\"][-a-zA-Z0-9_.]{20,}['\"]", True),
    ("bearer-token", r"Bearer\s+[-a-zA-Z0-9_.]{30,}", True),
    ("jwt-or-session-secret", r"(jwt[_-]?secret|session[_-]?secret|oauth[_-]?secret)\s*[:=]\s*['\"][-a-zA-Z0-9_.]{20,}['\"]", True),
    ("password-assignment", r"(password|passwd|pwd)\s*[:=]\s*['\"][^'\"\s]{8,}['\"]", True),
    ("credential-connection-string", r"(mysql|postgres|postgresql|mongodb|redis|amqp|mssql)://[-a-zA-Z0-9_.]+:[^@]+@", True),
    ("cloud-or-vps-credential", r"(aws_secret_access_key|cloud_api_key|restic_password)\s*[:=]\s*['\"][^'\"\s]+['\"]", True),
    ("database-dump", r"(-- (MySQL|PostgreSQL) dump|INSERT INTO [`\"][a-zA-Z0-9_]+[`\"]\s*VALUES\s*\()", True),
    ("sensitive-card-data", r"\b(4[0-9]{12}([0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b", False),
]

SAFE_VALUE_PREFIXES = (
    "test-", "test_", "dummy-", "dummy_", "mock-", "mock_",
    "placeholder-", "placeholder_", "sample-", "sample_",
    "your-", "your_", "change-me", "changeme",
)


def is_safe_candidate_value(val):
    v = val.strip().lower()
    return v.startswith(SAFE_VALUE_PREFIXES)


def is_safe_value(cat, line_text):
    # Unconditionally blocked categories: no synthetic placeholder exemptions permitted
    if cat in {
        "ssh-or-private-key",
        "private-certificate",
        "aws-access-key",
        "github-token",
        "slack-token",
        "database-dump",
        "sensitive-card-data",
    }:
        return False

    if cat == "bearer-token":
        m = re.search(r"Bearer\s+([-a-zA-Z0-9_.]{30,})", line_text, re.IGNORECASE)
        if not m:
            return False
        return is_safe_candidate_value(m.group(1))

    if cat == "api-key-or-token":
        m = re.search(r"(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token)\s*[:=]\s*['\"]([-a-zA-Z0-9_.]{20,})['\"]", line_text, re.IGNORECASE)
        if not m:
            return False
        return is_safe_candidate_value(m.group(1))

    if cat == "jwt-or-session-secret":
        m = re.search(r"(?:jwt[_-]?secret|session[_-]?secret|oauth[_-]?secret)\s*[:=]\s*['\"]([-a-zA-Z0-9_.]{20,})['\"]", line_text, re.IGNORECASE)
        if not m:
            return False
        val = m.group(1).strip().lower()
        return is_safe_candidate_value(val) or "session-secret" in val or "jwt-secret" in val or val.startswith(("dev-secret-", "session-secret-"))

    if cat == "password-assignment":
        m = re.search(r"(?:password|passwd|pwd)\s*[:=]\s*['\"]([^'\"\s]{8,})['\"]", line_text, re.IGNORECASE)
        if not m:
            return False
        val = m.group(1).strip().lower()
        if is_safe_candidate_value(val):
            return True
        return val in {"password", "secret", "admin", "root", "longpassword", "testpassword"}

    if cat == "cloud-or-vps-credential":
        m = re.search(r"(?:aws_secret_access_key|cloud_api_key|restic_password)\s*[:=]\s*['\"]([^'\"\s]+)['\"]", line_text, re.IGNORECASE)
        if not m:
            return False
        return is_safe_candidate_value(m.group(1))

    if cat == "credential-connection-string":
        m = re.search(r"(?:mysql|postgres|postgresql|mongodb|redis|amqp|mssql)://([-a-zA-Z0-9_.]+):([^@]+)@([^/\s:]+)", line_text, re.IGNORECASE)
        if not m:
            return False
        password = m.group(2).strip().lower()
        host = m.group(3).strip().lower()
        if host in {"localhost", "127.0.0.1", "mysql", "postgres", "redis", "mongodb", "db", "database"}:
            return True
        if is_safe_candidate_value(password) or password in {"password", "root", "secret", "admin", "postgres"}:
            return True
        return False

    return False


def audit(repo, pre_push=False):
    git(repo, "rev-parse", "--show-toplevel")
    indexed = paths(git(repo, "ls-files", "-z"))
    has_head = bool(git(repo, "rev-parse", "--verify", "HEAD", allow_unborn=True))
    head = paths(git(repo, "ls-tree", "-r", "--name-only", "-z", "HEAD")) if has_head else set()
    blocked = 0
    for path in sorted(indexed | head):
        reason = violation(path)
        if not reason:
            continue
        if path in indexed or pre_push:
            blocked += 1
            location = "index" if path in indexed else "HEAD"
            print(f"BLOCK [{location}] {path}: {reason}")
        else:
            print(f"PENDING CLEANUP {path}: removed from index; commit before pushing")

    # Content-level sensitive data and secrets audit (B-1)
    if indexed:
        for cat, pat, ignore_case in SENSITIVE_CATEGORIES:
            cmd = ["git", "-C", str(repo), "grep", "--cached", "-I", "-n", "-E"]
            if ignore_case:
                cmd.append("-i")
            cmd.extend(["-e", pat])
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0 and res.stdout:
                for line in res.stdout.strip().splitlines():
                    parts = line.split(":", 2)
                    if len(parts) >= 3 and is_safe_value(cat, parts[2]):
                        continue
                    if len(parts) >= 2:
                        blocked += 1
                        print(f"BLOCK [index:content] {parts[0]}:{parts[1]}: suspected {cat}. "
                              f"Remediation: Remove sensitive value from tracked files; use environment variables or test fixtures.")

    if pre_push and has_head:
        for cat, pat, ignore_case in SENSITIVE_CATEGORIES:
            cmd = ["git", "-C", str(repo), "grep", "-I", "-n", "-E"]
            if ignore_case:
                cmd.append("-i")
            cmd.extend(["-e", pat, "HEAD"])
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0 and res.stdout:
                for line in res.stdout.strip().splitlines():
                    parts = line.split(":", 2)
                    if len(parts) >= 3 and is_safe_value(cat, parts[2]):
                        continue
                    if len(parts) >= 2:
                        blocked += 1
                        print(f"BLOCK [HEAD:content] {parts[0]}:{parts[1]}: suspected {cat}. "
                              f"Remediation: Remove sensitive value from commit before pushing.")

    if not blocked:
        print(f"PASS: path and content policy ({len(indexed)} indexed files). Staged-content review still required.")
    return 1 if blocked else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--pre-push", action="store_true")
    args = parser.parse_args()
    try:
        sys.exit(audit(args.repo, args.pre_push))
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
