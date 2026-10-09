"""Cheap implementation ownership decision; risk is never a cost estimate."""


def delegation_eligible(task):
    return bool(task and task.risk == "HIGH" and task.expected_usage == "HIGH"
                and task.implementation_owner == "GEMINI" and task.delegation_reason.strip())


def implementation_owner(task):
    return "GEMINI" if delegation_eligible(task) else "CODEX"
