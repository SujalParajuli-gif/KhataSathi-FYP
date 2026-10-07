"""KhataSathi Workflow Supervisor - Repository Artifact & Git Parsers."""
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import re
import subprocess
from typing import TYPE_CHECKING, Dict, List, Optional, Tuple

if TYPE_CHECKING:
    from tools.ks_supervisor.config import SupervisorConfig

from tools.ks_supervisor.types import (
    CheckpointData,
    ExecutionMode,
    GitState,
    ReportData,
    RepositoryBaseline,
    RepositoryDelta,
    ReviewData,
    TaskContract,
)


def parse_yaml_block(content: str) -> Dict[str, str]:
    """Extract and parse simple YAML key-value pairs from markdown code fences."""
    yaml_match = re.search(r"```yaml\s*\n(.*?)\n```", content, re.DOTALL)
    if not yaml_match:
        return {}
    
    yaml_text = yaml_match.group(1)
    result = {}
    current_key = None
    for line in yaml_text.splitlines():
        line = line.rstrip()
        if not line or line.startswith("#"):
            continue
        
        # Match top-level key: "value" or key: value
        kv_match = re.match(r"^([A-Za-z0-9_]+):\s*(.*)$", line)
        if kv_match:
            key, val = kv_match.group(1), kv_match.group(2).strip()
            # Strip quotes
            if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                val = val[1:-1]
            result[key] = val
            current_key = key
        elif line.startswith("  - ") and current_key:
            # Simple list item under current_key
            val = line[4:].strip()
            if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                val = val[1:-1]
            existing = result.get(current_key, "")
            result[current_key] = f"{existing}; {val}" if existing else val
            
    return result


def parse_checkpoint(checkpoint_path: Path) -> CheckpointData:
    """Parse IMPLEMENTATION_CHECKPOINT.md to extract authoritative checkpoint data."""
    if not checkpoint_path.exists():
        return CheckpointData()
    
    content = checkpoint_path.read_text(encoding="utf-8", errors="replace")
    fields = parse_yaml_block(content)
    
    raw_version = fields.get("WORKFLOW_VERSION_EFFECTIVE", "").strip()
    
    # Semantic Whole-Field Validation for Workflow Version
    is_v2_active = False
    if raw_version:
        lower_v = raw_version.lower()
        # Check for ambiguous or contradictory markers using word boundaries
        has_contradiction = (
            bool(re.search(r"\bor\b", lower_v))
            or "not active" in lower_v
            or "inactive" in lower_v
            or "old workflow" in lower_v
        )
        if has_contradiction:
            is_v2_active = False
        elif raw_version == "2" or "workflow v2 active" in lower_v or (raw_version.startswith("2") and "active" in lower_v):
            is_v2_active = True
            
    return CheckpointData(
        workflow_version_effective=raw_version,
        is_v2_active=is_v2_active,
        master_plan_version=fields.get("MASTER_PLAN_VERSION", ""),
        current_phase=fields.get("CURRENT_PHASE", ""),
        current_task=fields.get("CURRENT_TASK", ""),
        current_task_file=fields.get("CURRENT_TASK_FILE", ""),
        current_task_status=fields.get("CURRENT_TASK_STATUS", ""),
        current_task_plan=fields.get("CURRENT_TASK_PLAN", ""),
        current_work_branch=fields.get("CURRENT_WORK_BRANCH", ""),
        last_accepted_task=fields.get("LAST_ACCEPTED_TASK", ""),
        last_implementation_commit=fields.get("LAST_IMPLEMENTATION_COMMIT", ""),
        next_safe_action=fields.get("NEXT_SAFE_ACTION", ""),
        raw_fields=fields,
    )


def parse_task_contract(task_path: Path) -> Optional[TaskContract]:
    """Parse a task contract file under docs/engineering/ai/tasks/."""
    if not task_path.exists():
        return None
    
    content = task_path.read_text(encoding="utf-8", errors="replace")
    lines = content.splitlines()
    
    # Task ID and Title from H1
    title_match = re.search(r"^#\s*([A-Za-z0-9_-]+)\s*[—–-]\s*(.*)$", content, re.MULTILINE)
    task_id = title_match.group(1).strip() if title_match else task_path.stem
    title = title_match.group(2).strip() if title_match else ""
    
    def extract_field(pattern: str, default: str = "") -> str:
        m = re.search(pattern, content, re.MULTILINE | re.IGNORECASE)
        return m.group(1).strip() if m else default

    status = extract_field(r"^Status:\s*(.*)$")
    difficulty = extract_field(r"^Difficulty:\s*(.*)$")
    risk = extract_field(r"^Risk:\s*(.*)$", default="MEDIUM").upper()
    planning_req_raw = extract_field(r"^Planning Required:\s*(.*)$", default="NO").upper()
    planning_required = "YES" in planning_req_raw or "TRUE" in planning_req_raw
    
    exec_mode_raw = extract_field(r"^Execution Mode:\s*(.*)$", default="DIRECT_IMPLEMENTATION").upper()
    exec_mode = ExecutionMode.DIRECT_IMPLEMENTATION
    for mode in ExecutionMode:
        if mode.value in exec_mode_raw:
            exec_mode = mode
            break
            
    senior_review_raw = extract_field(r"^Senior Review Required:\s*(.*)$", default="YES").upper()
    senior_review_required = "NO" not in senior_review_raw and "FALSE" not in senior_review_raw
    
    phase = extract_field(r"^Phase:\s*(.*)$")
    branch_worktree = extract_field(r"^Branch\s*/\s*worktree:\s*(.*)$")
    assigned_role = extract_field(r"^Assigned role:\s*(.*)$")
    authorization = extract_field(r"^Authorization:\s*(.*)$")
    delivery_outcome = extract_field(r"^Delivery outcome:\s*(.*)$")
    stop_conditions = extract_field(r"## Stop conditions\s*\n(.*?)(?=\n##|\Z)")
    
    # Extract acceptance criteria
    ac_matches = re.findall(r"^-\s*\[([ xX])\]\s*(AC-\d+:.*)$", content, re.MULTILINE)
    acceptance_criteria = [ac[1] for ac in ac_matches]

    return TaskContract(
        task_id=task_id,
        title=title,
        status=status,
        difficulty=difficulty,
        risk=risk,
        planning_required=planning_required,
        execution_mode=exec_mode,
        senior_review_required=senior_review_required,
        phase=phase,
        branch_worktree=branch_worktree,
        assigned_role=assigned_role,
        authorization=authorization,
        delivery_outcome=delivery_outcome,
        acceptance_criteria=acceptance_criteria,
        stop_conditions=stop_conditions,
        raw_content=content,
    )


def latest_authoritative_block(content: str, kind: str) -> str:
    """Select by document position, excluding explicitly historical headings."""
    candidates = []
    headings = list(re.finditer(r"^## (.+)$", content, re.M))
    for index, heading in enumerate(headings):
        title = heading.group(1).strip().lower()
        if "historical" in title or "history" in title:
            continue
        end = headings[index + 1].start() if index + 1 < len(headings) else len(content)
        block = content[heading.end():end]
        if kind == "review":
            relevant = re.search(r"(?:current|targeted|final|senior).*?(?:verification|review)|^result$", title)
        else:
            relevant = re.search(r"(?:manual|current|final).*?(?:correction|completion|implementation|verification)", title)
        if relevant:
            candidates.append(block)
    return candidates[-1] if candidates else content


def markdown_field(content: str, label: str) -> str:
    match = re.search(r"^" + label + r":\s*([^\n]*)$", content, re.M | re.I)
    return match.group(1).strip().strip("*` ") if match else ""


def parse_report(report_path: Path) -> Optional[ReportData]:
    """Parse an implementation report under docs/engineering/ai/reports/."""
    if not report_path.exists():
        return None
    
    content = report_path.read_text(encoding="utf-8", errors="replace")
    
    current = latest_authoritative_block(content, "report")
    status_match = re.search(r"^Status:\s*(.*)$", content, re.MULTILINE | re.IGNORECASE)
    status = status_match.group(1).strip() if status_match else ""
    
    branch_match = re.search(r"^Branch\s*/\s*worktree:\s*(.*)$", content, re.MULTILINE | re.IGNORECASE)
    branch = branch_match.group(1).strip() if branch_match else ""
    
    rev_match = re.search(r"^Revision\s*/\s*HEAD:\s*(.*)$", content, re.MULTILINE | re.IGNORECASE)
    revision = rev_match.group(1).strip() if rev_match else ""
    
    status = markdown_field(current, "Status") or (status if current == content else "")
    upper_content = current.upper()
    is_complete = "COMPLETE" in status.upper() or bool(re.search(r"\b(?:CORRECTION COMPLETE|COMPLETE)\b", upper_content))
    is_awaiting_review = bool(re.search(r"AWAITING (?:BOUNDED )?(?:SENIOR (?:REVIEW|VERIFICATION)|REVIEW)", upper_content))
    blocker_fixes_reported = "BLOCKER FIXES" in upper_content or bool(re.search(r"\bB-\d+\b", current)) or "CORRECT ONLY SENIOR REVIEW" in upper_content

    return ReportData(
        task_id=report_path.stem.replace("-implementation", "").replace("-report", ""),
        status=status,
        branch=branch,
        revision=revision,
        is_complete=is_complete,
        is_awaiting_review=is_awaiting_review,
        blocker_fixes_reported=blocker_fixes_reported,
        raw_content=content,
        current_content=current,
    )



def parse_review(review_path: Path) -> Optional[ReviewData]:
    """Interpret the latest authoritative decision without erasing audit history."""
    if not review_path.exists():
        return None
    content = review_path.read_text(encoding="utf-8", errors="replace")
    current = latest_authoritative_block(content, "review")
    value = markdown_field(current, "Decision").upper()
    if value in {"APPROVED", "APPROVED / READY FOR CLOSEOUT", "APPROVED / AWAITING CLOSEOUT"}:
        decision = "APPROVED"
    elif value in {"FIX REQUIRED", "FIX_REQUIRED", "CHANGES_REQUESTED", "CHANGES REQUESTED"}:
        decision = "FIX_REQUIRED"
    elif value == "BLOCKED":
        decision = "BLOCKED"
    elif value:
        decision = "UNKNOWN"
    else:
        # Legacy unstructured reviews remain supported, but only within the selected block.
        decision = "FIX_REQUIRED" if re.search(r"\bFIX\s*REQUIRED\b", current, re.I) else (
            "APPROVED" if re.search(r"\bAPPROVED\b", current, re.I) else "UNKNOWN")
    remaining = markdown_field(current, "Remaining blockers")
    empty = remaining.upper() in {"NONE", "0", "ZERO", "NONE FOUND", "ZERO BLOCKERS", "0 BLOCKERS"}
    if not remaining:
        empty = bool(re.search(r"\b(?:zero|0)\s+blockers?\b", current, re.I))
    blockers = list(dict.fromkeys(re.findall(r"\bB-\d+\b", remaining if remaining else current))) if not empty else []
    if decision == "APPROVED" and not empty:
        decision = "UNKNOWN"
    return ReviewData(task_id=review_path.stem.replace("-review", ""), decision=decision,
                      blockers=blockers, raw_content=content, current_content=current,
                      workflow_state=markdown_field(current, "Workflow v2 state"),
                      blockers_explicitly_empty=empty)


def remediation_review_context(review_path: Path, report_path: Path) -> str:
    """Bind a remediation packet to the latest canonical Senior scope, not historical findings."""
    review = parse_review(review_path)
    if review is None:
        return "Senior authority unavailable: inspect the canonical review; stop if current scope cannot be established."
    content = review.raw_content
    markers = list(re.finditer(r"^## Current targeted verification[^\n]*$", content, re.M))
    metadata = review.current_content
    # Dispositions precede the final machine-readable decision, within the latest review section.
    narrative = content[:markers[-1].start()] if markers else content
    headings = list(re.finditer(r"^## .+$", narrative, re.M))
    if markers and headings:
        narrative = narrative[headings[-1].start():]
    run = re.search(r"^Run ID:\s*(\S+)", metadata, re.M)
    remaining = re.search(r"^Remaining blockers:\s*(.+)$", metadata, re.M)
    lines = [
        f"Senior authority: run {run.group(1) if run else 'not recorded'}",
        f"Decision: {review.decision.replace('_', ' ')}",
        f"Remaining blockers: {remaining.group(1).strip() if remaining else ', '.join(review.blockers) or 'not recorded'}",
        f"Current review SHA256: {compute_file_hash(review_path)}",
        f"Current implementation report SHA256: {compute_file_hash(report_path) or 'not present'}",
    ]
    # Preserve recorded report/manifest identities verbatim; do not claim a manifest comparison was run.
    identity = re.search(r"^### Correction identity\s*\n(.*?)(?=^### |\Z)", narrative, re.M | re.S)
    if identity:
        lines.extend(["Senior recorded content binding:", identity.group(1).strip()])
    for line in metadata.splitlines():
        if re.match(r"(?:Correction report|.*manifest).*?(?:SHA256|hash):", line, re.I):
            lines.append(line.strip())
    lines.append("Latest dispositions for remaining blockers only:")
    for blocker in review.blockers:
        # Markdown list items or headings; stop before the next blocker, including resolved ones.
        pattern = (r"^(?:[-*]\s+(?:\*\*)?|#{2,6}\s+)" + re.escape(blocker)
                   + r"\b.*?(?=^(?:[-*]\s+(?:\*\*)?|#{2,6}\s+)B-\d+\b|^#{2,6} |\Z)")
        matches = list(re.finditer(pattern, narrative, re.M | re.S))
        disposition = matches[-1].group(0).strip() if matches else "Disposition not extracted; inspect the latest review section before acting."
        lines.append(f"{blocker}: {disposition}")
    return "\n".join(lines)


def run_git(repo_root: Path, *args: str) -> Tuple[int, str, str]:
    """Run a git command in the repository and return (returncode, stdout, stderr)."""
    try:
        res = subprocess.run(
            ["git", "-C", str(repo_root), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return res.returncode, res.stdout.strip(), res.stderr.strip()
    except Exception as e:
        return 1, "", str(e)


def _read_porcelain_entries(repo_root: Path, untracked_mode: str = "normal") -> List[Tuple[str, str]]:
    """Return [(status_code, path)] from NUL-delimited porcelain output.

    The two status columns are significant (e.g. " M" vs "M "), so lines must never be
    stripped before slicing. Rename/copy entries carry an extra source path, which is skipped.
    """
    try:
        res = subprocess.run(
            ["git", "-C", str(repo_root), "status", "--porcelain", "-z", f"--untracked-files={untracked_mode}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except Exception:
        return []
    if res.returncode != 0 or not res.stdout:
        return []

    entries: List[Tuple[str, str]] = []
    tokens = res.stdout.split("\0")
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        i += 1
        if len(tok) < 4:
            continue
        code, path = tok[:2], tok[3:]
        entries.append((code, path))
        if code[0] in "RC":
            i += 1  # skip original path of rename/copy
    return entries


def get_git_state(repo_root: Path) -> GitState:
    """Query and return the live Git repository state."""
    code, branch, _ = run_git(repo_root, "branch", "--show-current")
    if code != 0 or not branch:
        # Fallback to symbolic-ref or rev-parse
        _, branch, _ = run_git(repo_root, "rev-parse", "--abbrev-ref", "HEAD")
        
    _, head_sha, _ = run_git(repo_root, "rev-parse", "HEAD")
    
    # Status porcelain (NUL-delimited; status columns preserved)
    modified_files = []
    untracked_files = []
    for status_code, filename in _read_porcelain_entries(repo_root):
        if status_code == "??":
            untracked_files.append(filename)
        else:
            modified_files.append(filename)
                
    # Staged files
    _, staged_out, _ = run_git(repo_root, "diff", "--cached", "--name-only")
    staged_files = [f.strip() for f in staged_out.splitlines() if f.strip()]
    
    is_clean = len(modified_files) == 0 and len(staged_files) == 0 and len(untracked_files) == 0

    return GitState(
        branch=branch,
        head_sha=head_sha,
        is_clean=is_clean,
        modified_files=modified_files,
        staged_files=staged_files,
        untracked_files=untracked_files,
    )


def run_hygiene_check(repo_root: Path, hygiene_script_path: Path) -> Tuple[int, str]:
    """Execute the repository commit hygiene check script."""
    if not hygiene_script_path.exists():
        return 1, f"Hygiene script not found at {hygiene_script_path}"
        
    try:
        res = subprocess.run(
            ["python", str(hygiene_script_path), "--repo", str(repo_root)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return res.returncode, res.stdout + res.stderr
    except Exception as e:
        return 1, f"Failed to execute hygiene script: {e}"


def compute_file_hash(path: Path) -> str:
    """Compute deterministic SHA-256 hash of a file's content, or empty string if absent."""
    if not path.exists() or not path.is_file():
        return ""
    try:
        data = path.read_bytes()
        return hashlib.sha256(data).hexdigest()
    except Exception:
        return ""


def capture_repository_baseline(
    config: "SupervisorConfig",
    task_id: str,
    workflow_state_name: str = "",
) -> RepositoryBaseline:
    """Capture comprehensive snapshot of Git working tree and workflow artifact fingerprints."""
    git_state = get_git_state(config.repo_root)
    
    # Hash every individual changed/untracked file. `--untracked-files=all` expands untracked
    # directories into files (still honouring .gitignore) so new files inside them are visible.
    file_hashes: Dict[str, str] = {}
    porcelain: Dict[str, str] = {}
    for status_code, rel_f in _read_porcelain_entries(config.repo_root, untracked_mode="all"):
        porcelain[rel_f] = status_code
        file_hashes[rel_f] = compute_file_hash(config.repo_root / rel_f)
    for rel_f in git_state.staged_files:
        if rel_f not in file_hashes:
            file_hashes[rel_f] = compute_file_hash(config.repo_root / rel_f)

    # Hash workflow artifacts. Several of these live in gitignored paths, so Git status alone
    # cannot see agent edits to them; content fingerprints are required.
    artifact_hashes: Dict[str, str] = {}
    for kind, directory in (
        ("task", config.tasks_dir),
        ("report", config.reports_dir),
        ("review", config.reviews_dir),
        ("plan", config.plans_dir),
    ):
        if task_id and directory.exists():
            for p in sorted(directory.glob(f"{task_id}*.md")):
                artifact_hashes[f"{kind}:{p.name}"] = compute_file_hash(p)

    artifact_hashes["checkpoint"] = compute_file_hash(config.checkpoint_path)
    artifact_hashes["registry"] = compute_file_hash(config.task_registry_path)

    return RepositoryBaseline(
        timestamp=datetime.now(timezone.utc).isoformat(),
        branch=git_state.branch,
        head_sha=git_state.head_sha,
        is_clean=git_state.is_clean,
        modified_files=list(git_state.modified_files),
        staged_files=list(git_state.staged_files),
        untracked_files=list(git_state.untracked_files),
        porcelain=porcelain,
        file_hashes=file_hashes,
        artifact_hashes=artifact_hashes,
        workflow_state=workflow_state_name,
        task_id=task_id,
    )


def compute_repository_delta(
    pre: RepositoryBaseline,
    post: RepositoryBaseline,
    repo_root: Path,
) -> RepositoryDelta:
    """Compute deterministic delta between pre-run baseline and post-run repository state.

    Pre-existing dirty files are compared by content hash, so an unchanged pre-existing
    modification is NOT counted as an effect of the current run, while a further edit to it is.
    """
    new_files: List[str] = []
    modified_files: List[str] = []
    deleted_files: List[str] = []
    changed_workflow_artifacts: List[str] = []

    for post_f, post_h in post.file_hashes.items():
        if post_f not in pre.file_hashes:
            new_files.append(post_f)
        elif post_h != pre.file_hashes.get(post_f):
            modified_files.append(post_f)
        elif post.porcelain.get(post_f) != pre.porcelain.get(post_f):
            # Same content, different index/worktree status (e.g. agent staged a file)
            modified_files.append(post_f)

    for pre_f in pre.file_hashes.keys():
        if pre_f not in post.file_hashes:
            # File left the dirty set: reverted to HEAD content or deleted
            deleted_files.append(pre_f)

    for k in sorted(set(pre.artifact_hashes.keys()).union(post.artifact_hashes.keys())):
        if pre.artifact_hashes.get(k, "") != post.artifact_hashes.get(k, ""):
            changed_workflow_artifacts.append(k)

    head_changed = bool(pre.head_sha and post.head_sha and pre.head_sha != post.head_sha)
    branch_changed = bool(pre.branch and post.branch and pre.branch != post.branch)
    has_git_changes = bool(new_files or modified_files or deleted_files or head_changed)

    # A derived-state label change is NOT an effect by itself: state is derived from files,
    # so a genuine transition must also appear as a file/artifact/HEAD change.
    observable_effect = bool(has_git_changes or changed_workflow_artifacts)

    return RepositoryDelta(
        has_git_changes=has_git_changes,
        new_files=sorted(new_files),
        modified_files=sorted(modified_files),
        deleted_files=sorted(deleted_files),
        changed_workflow_artifacts=changed_workflow_artifacts,
        initial_workflow_state=pre.workflow_state,
        final_workflow_state=post.workflow_state,
        head_changed=head_changed,
        branch_changed=branch_changed,
        observable_effect=observable_effect,
    )
