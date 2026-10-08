"""Append-only mission succession; legacy authority is never rewritten."""
import hashlib
import json
import re


def transitions(config):
    path = config.runtime_dir / "v3/mission_transitions.jsonl"
    if not path.exists():
        return []
    try:
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        previous = None
        retired = set()
        for row in rows:
            if not re.fullmatch(r"[0-9a-f]{32}", row["mission_id"]) or (
                    row["previous_mission"] and not re.fullmatch(r"[0-9a-f]{32}", row["previous_mission"])):
                raise ValueError("Invalid mission identity")
            if row["previous_mission"] != previous and previous is not None:
                raise ValueError("Mission succession chain changed")
            if row["mission_id"] in retired or row["mission_id"] == row["previous_mission"]:
                raise ValueError("Retired mission cannot become active")
            if row["previous_mission"]:
                retired.add(row["previous_mission"])
            for item in row["preserved"]:
                target = config.runtime_dir / item["path"]
                if (target.is_symlink() or not target.resolve().is_relative_to(config.runtime_dir.resolve())
                        or hashlib.sha256(target.read_bytes()).hexdigest() != item["sha256"]):
                    raise ValueError("Historical mission evidence changed")
            previous = row["mission_id"]
        return rows
    except (OSError, KeyError, TypeError, ValueError):
        raise ValueError("Unreadable mission succession authority; preserve history")


def current_mission(config):
    rows = transitions(config)
    return rows[-1]["mission_id"] if rows else None


def retired_missions(config):
    return {row["previous_mission"] for row in transitions(config) if row["previous_mission"]}


def append_transition(config, row):
    transitions(config)
    path = config.runtime_dir / "v3/mission_transitions.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, sort_keys=True) + "\n")


def fingerprint(config, path):
    return {"path": path.relative_to(config.runtime_dir).as_posix(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
