"""Byte-exact cumulative worker reports and immutable per-invocation evidence."""
import hashlib
import re


REPORT_REWRITE_REASON = "Worker rewrote cumulative implementation report"
REPORT_TURN_REASON = "Worker report append is not bound to exactly one current worker turn"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def report_overlay(run_id):
    return (
        "\nAUTOMATED KS-IMPL CUMULATIVE PROVENANCE (overrides report replacement instructions):\n"
        "Existing canonical implementation report bytes are immutable cumulative provenance. "
        "Never rewrite, reorganize, summarize-away, delete, replace or normalize previous sections, "
        "including trailing newlines/EOF. NEW_CONTENT = EXACT_PRIOR_CONTENT + APPENDED_CURRENT_TURN_CONTENT. "
        "Append exactly ONE new section for this invocation, starting on its own line with "
        f"'## Worker turn {run_id}'. Record mode/slice, changed paths, actual progress, remaining work, "
        "verification still required and provider limits there. Append historical corrections explicitly "
        "inside that new section; never edit an earlier claim in place. Do not append a start section "
        "and a second completion section. If no report update is appropriate, explicitly return that fact. "
        "Use an exact EOF insertion preserving every prior byte; if your file tool cannot preserve "
        "the existing prefix, leave the report untouched and return current-turn facts for Codex recovery.\n"
    )


def report_violations(prior, candidate, run_id=None, prior_exists=True):
    if candidate is None and not prior_exists and not prior:
        return []  # An absent report left absent is not a deletion/rewrite.
    if candidate is None or not candidate.startswith(prior):
        return [REPORT_REWRITE_REASON]
    appended = candidate[len(prior):]
    if not appended or not run_id:
        return []
    # No text/newline normalization: validate only the newly appended section.
    heading = b"## Worker turn " + run_id.encode()
    headings = re.findall(rb"^## ([^\r\n]+)\r?$", appended, re.M)
    starts_section = appended.lstrip(b"\r\n").startswith((heading + b"\n", heading + b"\r\n"))
    starts_line = not prior or prior.endswith(b"\n") or appended.startswith((b"\n", b"\r\n"))
    if headings != [b"Worker turn " + run_id.encode()] or not starts_section or not starts_line:
        return [REPORT_TURN_REASON]
    return []


def save_report_bytes(directory, name, data):
    """Supervisor-owned exclusive write; never overwrite older runtime evidence."""
    path = directory / name
    with path.open("xb") as stream:
        stream.write(data)
    return {"path": str(path), "sha256": digest(data), "length": len(data)}
