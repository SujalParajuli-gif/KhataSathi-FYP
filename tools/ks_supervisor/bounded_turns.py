"""Validated slice packets; Codex, rather than the provider, assesses progress."""
from pathlib import PurePosixPath
import json


def validate_slice(packet, task_id, mission_id, identity, plan_hash):
    if (packet.get("task_id") != task_id or not mission_id or packet.get("mission_id") != mission_id
            or packet.get("content_identity") != identity or packet.get("plan_sha256") != plan_hash):
        raise ValueError("Continuation must bind the same mission/task/current content/ready plan")
    for key in ("slice", "instructions", "preserve_completed"):
        if not isinstance(packet.get(key), str) or not packet[key].strip():
            raise ValueError("Continuation requires exact slice, instructions and preserved work")
    for key in ("files", "plan_steps", "acceptance_criteria", "remaining_slices"):
        value = packet.get(key)
        if not isinstance(value, list) or not value or not all(isinstance(v, str) and v.strip() for v in value):
            raise ValueError("Continuation requires " + key)
    if len(packet["files"]) > 12 or len(set(packet["files"])) != len(packet["files"]):
        raise ValueError("A bounded turn requires at most 12 exact distinct product files")
    for name in packet["files"]:
        path = PurePosixPath(name)
        if ("\\" in name or path.is_absolute() or ".." in path.parts or str(path) != name
                or path.parts[0] not in {"backend", "frontend"}):
            raise ValueError("Slice files must be exact repository product paths")
    return packet


def slice_prompt(packet, report):
    return "\nBOUNDED CONTINUE (overrides broad implementation extent):\n" + json.dumps(packet, sort_keys=True) + (
        "\nImplement ONLY this slice in the exact files listed, plus append progress to " + report + "."
        " Preserve all other files, completed work and interfaces. Never reset, clean, revert or restart."
        " Read the existing contract/ready plan; this is the SAME product task, not a new task or plan."
        " Append exactly one run-bound worker-turn section before returning: completed slices, changed files,"
        " decisions, remaining slices, gates and verification still required. Preserve existing report text."
        " Return control when this slice is complete; do not attempt the remaining slices."
        " In fix mode also obey the supplied latest Senior blockers/correction packet."
        " Workspace file tools ONLY: no shell, tests, Git, Prisma, migration, servers, deploy or external operation."
        " No task acceptance, closeout or commit per slice; Codex inspects progress and verifies at the final appropriate boundary.\n")
