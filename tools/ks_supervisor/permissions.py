"""Read existing Antigravity CLI grants; never write or extend provider permissions."""
import hashlib
import json
from pathlib import Path
import re


CLI_PROJECT = "default-cli-project"


class CommandPermissions:
    """The invocation explicitly selects this existing CLI project.

    Global and project Deny/Ask take precedence over Allow. Only simple bounded
    commands reach this matcher; unsupported rules fail closed. CLI semantics:
    https://antigravity.google/docs/permissions (CLI fine-grained permissions).
    """
    def __init__(self):
        self.rules = {name: [] for name in ("deny", "ask", "allow")}
        self.sources = {}
        self.error = ""
        try:
            home = Path.home() / ".gemini"
            paths = [home / "antigravity-cli/settings.json",
                     home / f"config/projects/{CLI_PROJECT}.json"]
            for path in paths:
                raw = path.read_bytes()
                data = json.loads(raw)
                if path == paths[1] and data.get("id") != CLI_PROJECT:
                    raise ValueError("CLI project identity mismatch")
                grants = data.get("permissions", {}) if path == paths[0] else data.get(
                    "permissionGrants", {}).get("permissionGrants", {})
                if not isinstance(grants, dict):
                    raise ValueError("Invalid permission grants")
                for name in self.rules:
                    rules = grants.get(name, [])
                    if not isinstance(rules, list) or not all(isinstance(r, str) for r in rules):
                        raise ValueError("Invalid permission rules")
                    self.rules[name].extend(rules)
                self.sources[str(path)] = hashlib.sha256(raw).hexdigest()
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            self.error = f"Effective CLI permission policy unavailable: {type(exc).__name__}"

    @staticmethod
    def matches(rule, command):
        if not rule.startswith("command("):
            return False
        if not rule.endswith(")"):
            raise ValueError("Malformed command rule")
        target = rule[8:-1]
        if target == "*":
            return True
        if target.startswith("regex:"):
            # Full-line matching is deliberately conservative: it cannot grant
            # a prefix whose remaining arguments the provider might reject.
            return re.fullmatch(target[6:], command) is not None
        return command == target or command.startswith(target + " ")

    def authorized(self, command):
        if self.error:
            return False, self.error
        try:
            for name in ("deny", "ask"):
                if any(self.matches(rule, command) for rule in self.rules[name]):
                    return False, f"Existing provider {name} rule requires a stop"
            if any(self.matches(rule, command) for rule in self.rules["allow"]):
                return True, "Matched existing provider Allow rule"
        except (ValueError, re.error):
            return False, "Unsupported or malformed provider command rule"
        return False, "No existing provider Allow rule matches the bounded command"

    def metadata(self):
        return {"project": CLI_PROJECT, "sources_sha256": self.sources, "error": self.error}
