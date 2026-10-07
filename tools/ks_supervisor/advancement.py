"""Read-only Workflow v2 re-anchor planning and bounded checkpoint activation."""
from dataclasses import replace
import json
import re

from tools.ks_supervisor.models import select_model_for_action
from tools.ks_supervisor.repo import parse_task_contract
from tools.ks_supervisor.types import DerivedState, Role, WorkflowState


def registry_rows(config):
    if not config.task_registry_path.exists():
        return []
    rows = []
    for line in config.task_registry_path.read_text(encoding="utf-8").splitlines():
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 5 and re.fullmatch(r"TASK-[A-Z0-9-]+", cells[0]):
            rows.append((cells[0], cells[4].upper()))
    return rows


def plan_reanchor(config, accepted):
    """Select registry order, respecting checkpoint priority and explicit dependencies.

    Never create a task or mutate repository state during selection/dry-run.
    Ambiguous gates are left for Senior definition rather than guessed satisfied.
    """
    from tools.ks_supervisor.state import _raw_derive_workflow_state

    checkpoint, git = accepted.checkpoint, accepted.git_state

    def stop(reason):
        return DerivedState(
            state=WorkflowState.NEXT_TASK_UNRESOLVED, assigned_role=Role.NONE,
            active_task_id=accepted.active_task_id, task_contract=accepted.task_contract,
            checkpoint=checkpoint, git_state=git, is_hard_stop=True,
            reason="NEXT_TASK_UNRESOLVED: " + reason,
            stop_reason="NEXT_TASK_UNRESOLVED: " + reason,
        )

    rows = registry_rows(config)
    statuses = dict(rows)
    if (not checkpoint or not checkpoint.is_v2_active or not git or not git.is_clean
            or not accepted.task_contract or accepted.task_contract.status.upper() != "ACCEPTED"
            or checkpoint.current_task_status.upper() != "ACCEPTED"
            or statuses.get(accepted.active_task_id) != "ACCEPTED"):
        return stop("re-anchor requires clean Git and completed ACCEPTED task/checkpoint/registry closeout")
    if len(statuses) != len(rows):
        return stop("duplicate registry task identities")

    action = checkpoint.next_safe_action.strip()
    named = checkpoint.raw_fields.get("NEXT_TASK", "").strip()
    references = set(re.findall(r"\bTASK-[A-Z0-9]+(?:-[A-Z0-9]+)+\b", action)) - {accepted.active_task_id}
    if not named and len(references) == 1:
        named = next(iter(references))
    if not named and len(references) > 1:
        return stop("NEXT_SAFE_ACTION names multiple next tasks")
    candidates = [(named, statuses.get(named, ""))] if named else rows
    rejected = []
    for task_id, status in candidates:
        if task_id == accepted.active_task_id or status not in {"READY", "PLAN_READY_FOR_IMPLEMENTATION", "IN_PROGRESS"}:
            if named:
                rejected.append(f"{task_id} is not eligible ({status or 'unregistered'})")
            continue
        paths = [p for p in config.tasks_dir.glob("*.md")
                 if p.stem == task_id or p.name.startswith(task_id + "-")]
        if len(paths) != 1:
            rejected.append(f"{task_id} has missing/ambiguous contract")
            continue
        task = parse_task_contract(paths[0])
        if not task or task.task_id != task_id or task.status.upper() != status:
            rejected.append(f"{task_id} contract/registry status mismatch")
            continue
        if (not re.search(r"^Planning Required:\s*(YES|NO)\s*$", task.raw_content, re.M | re.I)
                or (task.risk == "HIGH" and not task.planning_required)
                or (task.execution_mode.value == "PLANNED_IMPLEMENTATION" and not task.planning_required)):
            rejected.append(f"{task_id} has incomplete or inconsistent planning metadata")
            continue
        branch = re.split(r"\s+/\s+|\s*;\s*", task.branch_worktree)[0].strip()
        if not branch or branch != git.branch:
            rejected.append(f"{task_id} requires a different or unspecified branch")
            continue
        gate = re.search(r"^Dependencies\s*/\s*approval gates:\s*(.*)$", task.raw_content, re.M | re.I)
        if gate and gate.group(1).strip().lower() not in {"none", "none.", "n/a"}:
            value = gate.group(1).strip()
            deps = re.findall(r"\bTASK-[A-Z0-9]+(?:-[A-Z0-9]+)+\b", value)
            residue = re.sub(r"\bTASK-[A-Z0-9]+(?:-[A-Z0-9]+)+\b", "", value)
            # Only an explicit dependency list or 'ACCEPTED <IDs>' proves eligibility.
            residue = re.sub(r"\baccepted\b", "", residue, flags=re.I).strip(" ,;.`")
            if residue or not deps or any(statuses.get(dep) != "ACCEPTED" for dep in deps):
                rejected.append(f"{task_id} has unsatisfied or unresolved dependency/approval gates")
                continue
        target_checkpoint = replace(
            checkpoint, current_task=task_id, current_task_status=task.status,
            current_task_file=paths[0].relative_to(config.repo_root).as_posix(),
            current_phase=task.phase or checkpoint.current_phase,
            current_task_plan=f"docs/engineering/ai/plans/{task_id}-plan.md" if task.planning_required else "",
        )
        target = _raw_derive_workflow_state(config, checkpoint=target_checkpoint, git_state=git)
        if target.is_hard_stop:
            rejected.append(f"{task_id}: {target.reason}")
            continue
        target.reason = f"Re-anchor after ACCEPTED {accepted.active_task_id}: " + target.reason
        target.model_selection = select_model_for_action(target.state, target.assigned_role, task, config=config)
        return target

    if named:
        return stop("; ".join(rejected) or f"{named} is not eligible")
    # The router's NO_ACTIVE_TASK path scopes a recorded deliverable, not arbitrary
    # backlog work or a new task invented by this deterministic selector.
    resumed = re.search(r"\bOn resumption,\s*(.+)", action, re.I)
    definition = resumed.group(1) if resumed else action
    if re.search(r"\b(scope|define|draft)\b", definition, re.I) and not re.search(
            r"\b(no safe|no next|unknown|unresolved)\b", definition, re.I):
        target_checkpoint = replace(checkpoint, current_task="", current_task_file="",
                                    current_task_status="", current_task_plan="", next_safe_action=definition)
        target = _raw_derive_workflow_state(config, checkpoint=target_checkpoint, git_state=git)
        target.reason = f"Re-anchor after ACCEPTED {accepted.active_task_id}: next deliverable requires formal task definition"
        target.model_selection = select_model_for_action(target.state, target.assigned_role, config=config)
        return target
    return stop("; ".join(rejected) or "no eligible registry task or recorded next task-definition action")


def apply_reanchor(config, target):
    """Activate the already selected item; preserve accepted contracts and registry.

    The caller holds the Supervisor lock. Only ignored checkpoint metadata changes;
    tracked Git content, index, branch and HEAD remain untouched.
    """
    checkpoint = target.checkpoint
    fields = {
        "CURRENT_TASK": checkpoint.current_task,
        "CURRENT_PHASE": checkpoint.current_phase,
        "CURRENT_TASK_FILE": checkpoint.current_task_file,
        "CURRENT_TASK_STATUS": checkpoint.current_task_status,
        "CURRENT_TASK_PLAN": checkpoint.current_task_plan,
        "CURRENT_TASK_AUTHORIZATION": target.task_contract.authorization if target.task_contract else "",
        "CURRENT_TASK_REVIEW": "",
        "NEXT_SAFE_ACTION": target.next_action_description if checkpoint.current_task else checkpoint.next_safe_action,
        "LAST_REANCHOR_HEAD": target.git_state.head_sha,
    }
    content = config.checkpoint_path.read_text(encoding="utf-8")
    fence = re.search(r"```yaml\s*\n(.*?)\n```", content, re.S)
    if not fence:
        raise ValueError("NEXT_TASK_UNRESOLVED: checkpoint YAML block missing")
    block = fence.group(1)
    for key, value in fields.items():
        line = f"{key}: {json.dumps(value, ensure_ascii=False)}"
        pattern = r"^" + key + r":[^\n]*$"
        if re.search(pattern, block, re.M):
            block = re.sub(pattern, lambda _: line, block, flags=re.M)
        else:
            block += "\n" + line
    content = content[:fence.start(1)] + block + content[fence.end(1):]
    temporary = config.checkpoint_path.with_suffix(".reanchor.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(config.checkpoint_path)
