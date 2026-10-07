"""Read effective CLI grants; explicit setup can install bounded verification rules."""
import hashlib
import json
from pathlib import Path
import re


CLI_PROJECT = "default-cli-project"


def configure_source_verification_permissions():
    """Explicit operator setup only; never called by an agent invocation or run.

    Replace command Allows, including older broad grants, rather than layering
    safe rules over an unsafe policy. Preserve all non-command grants and
    existing Deny/Ask rules. Test paths are enumerated in the source policy;
    connected MySQL fixtures and startup commands are intentionally absent.
    """
    policy = json.loads(Path(__file__).with_name("source_verification_permissions.json").read_text(encoding="utf-8"))
    global_settings = Path.home() / ".gemini/antigravity-cli/settings.json"
    global_grants = json.loads(global_settings.read_text(encoding="utf-8")).get("permissions", {})
    if any(r.startswith(("command(", "unsandboxed(")) for r in global_grants.get("allow", [])):
        raise ValueError("Global command grants must be reviewed separately before project policy setup")
    path = Path.home() / f".gemini/config/projects/{CLI_PROJECT}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("id") != CLI_PROJECT:
        raise ValueError("CLI project identity mismatch")
    grants = data["permissionGrants"]["permissionGrants"]
    for name in ("allow", "deny", "ask"):
        rules = grants.get(name, [])
        if not isinstance(rules, list) or not all(isinstance(r, str) for r in rules):
            raise ValueError("Invalid permission rules")
    grants["allow"] = [r for r in grants.get("allow", []) if not r.startswith(("command(", "unsandboxed("))] + policy["allow"]
    grants["deny"] = list(dict.fromkeys(grants.get("deny", []) + policy["deny"]))
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)
    return path


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
