"""Explicit HIGH/HIGH owner fixture for worker/provenance regression tests."""
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase


class DelegatedSupervisorTestCase(BaseSupervisorTestCase):
    def write_task(self, *args, **kwargs):
        kwargs["risk"] = "HIGH"
        path = super().write_task(*args, **kwargs)
        with path.open("a", encoding="utf-8") as f:
            f.write("\nExpected Usage: HIGH\nImplementation Owner: GEMINI\nDelegation Reason: Bounded independent fixture implementation is cheaper than direct authoring plus review.\n")
        task_id = kwargs.get("task_id", args[0] if args else "TASK-01-001")
        plan = self.config.plans_dir / f"{task_id}-plan.md"
        if kwargs.get("planning_required") != "YES" and not plan.exists():
            plan.write_text("Final plan disposition: IMPLEMENTATION-READY.", encoding="utf-8")
        return path
