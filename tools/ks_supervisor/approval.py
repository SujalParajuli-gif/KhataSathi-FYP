"""Validate explicit canonical Senior approval of manually implemented content."""
from pathlib import Path
import re

from tools.ks_supervisor.repo import compute_file_hash


def approval_mismatch(config, task, checkpoint, review, report, review_path, report_path):
    expected = "APPROVED_AWAITING_CLOSEOUT"
    if task.status.upper() != expected or checkpoint.current_task_status.upper() != expected:
        return "task/checkpoint approval status disagreement"
    rows = []
    if config.task_registry_path.exists():
        for line in config.task_registry_path.read_text(encoding="utf-8").splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if cells and cells[0] == checkpoint.current_task:
                rows.append(cells)
    if len(rows) != 1 or len(rows[0]) < 5 or rows[0][4] != expected:
        return "task/registry approval status disagreement"
    if (not review or review.decision != "APPROVED" or review.blockers
            or not review.blockers_explicitly_empty or review.workflow_state != expected):
        return "latest Senior decision/blockers/workflow state disagree with approval"
    if not report or not report.is_complete or not report_path:
        return "latest implementation completion block missing"
    if report_path.stat().st_mtime_ns > review_path.stat().st_mtime_ns:
        return "implementation report changed after Senior approval"

    # Prefer explicit path/hash pairs. Named application/test hashes may refer to
    # the paths explicitly recorded in the latest implementation correction.
    roles = dict(re.findall(r"\b(Application|Test):\s*`([^`]+)`", report.current_content))
    identities = {}
    for label, digest in re.findall(r"^\s*-?\s*([^:\n]+?) SHA256:\s*`?([a-fA-F0-9]{64})`?", review.current_content, re.M):
        label = label.strip().strip("`")
        if label.startswith(("frontend/", "backend/")):
            relative = label
        else:
            role = "Test" if re.search(r"\b(?:browser|spec|test)\b", label, re.I) else "Application"
            relative = roles.get(role)
        if not relative:
            return "reviewed hash has no unambiguous application/test path"
        if relative in identities and identities[relative] != digest.lower():
            return "contradictory reviewed content identities"
        identities[relative] = digest.lower()
    if not identities:
        return "latest Senior reviewed content hashes missing"
    if roles and not set(roles.values()).issubset(identities):
        return "latest correction includes content not bound by Senior hashes"
    for relative, digest in identities.items():
        path = (config.repo_root / relative).resolve()
        if (not path.is_relative_to(config.repo_root.resolve())
                or not relative.startswith(("frontend/", "backend/"))):
            return "reviewed content path outside application/test scope"
        if compute_file_hash(path) != digest:
            return f"reviewed content hash mismatch: {relative}"

    # A new, unbound source change requires another Senior decision; unrelated
    # Supervisor files and generated build/runtime artifacts are not app edits.
    for directory in ("frontend/app", "frontend/tests", "backend/src"):
        for path in (config.repo_root / directory).rglob("*"):
            if (path.is_file() and path.relative_to(config.repo_root).as_posix() not in identities
                    and path.stat().st_mtime_ns > review_path.stat().st_mtime_ns):
                return f"newer application/test content not reviewed: {path.relative_to(config.repo_root).as_posix()}"
    return ""
