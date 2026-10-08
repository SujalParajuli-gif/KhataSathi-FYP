"""KhataSathi Workflow Supervisor - Command Line Interface."""
import argparse
import json
from pathlib import Path
import sys
from typing import Optional

from tools.ks_supervisor.config import SupervisorConfig
from tools.ks_supervisor.doctor import run_doctor
from tools.ks_supervisor.runner import SupervisorRunner
from tools.ks_supervisor.types import AgentInvocation, Role, StopReport, WorkflowState


def cmd_doctor(config: SupervisorConfig) -> int:
    """Execute diagnostic doctor checks."""
    print("=" * 65)
    print(" KhataSathi Workflow Supervisor - System & Environment Diagnostics")
    print("=" * 65)
    
    passed, results = run_doctor(config)
    for res in results:
        status_marker = f"[{res.status}]"
        print(f" {status_marker:<8} {res.name:<32} {res.message}")
        
    print("=" * 65)
    if passed:
        print(" RESULT: ALL MANDATORY CHECKS PASSED")
        return 0
    else:
        print(" RESULT: ONE OR MORE MANDATORY CHECKS FAILED")
        return 1


def cmd_status(config: SupervisorConfig) -> int:
    """Display read-only summary of current repository and workflow state."""
    runner = SupervisorRunner(config)
    state = runner.get_status()

    print("=" * 65)
    print(" KhataSathi Workflow Status (Read-Only)")
    print("=" * 65)

    # Repository & Git
    git_info = state.git_state
    if git_info:
        clean_str = "CLEAN" if git_info.is_clean else f"DIRTY ({len(git_info.modified_files)} modified, {len(git_info.untracked_files)} untracked)"
        print(f" Branch:       {git_info.branch}")
        print(f" HEAD:         {git_info.head_sha[:8] if git_info.head_sha else 'unknown'}")
        print(f" Working Tree: {clean_str}")
    
    # Checkpoint Metadata
    cp = state.checkpoint
    if cp:
        print(f" Master Plan:  v{cp.master_plan_version or '1.2'}")
        print(f" Workflow Ver: {cp.workflow_version_effective}")
        print(f" Phase:        {cp.current_phase}")
        print(f" Active Task:  {cp.current_task or 'None'} [{cp.current_task_status or 'N/A'}]")

    # Task Details
    task = state.task_contract
    if task:
        print(f" Task Title:   {task.title}")
        print(f" Risk / Diff:  {task.risk} / {task.difficulty or 'N/A'}")
        print(f" Exec Mode:    {task.execution_mode.value}")
        print(f" Planning Req: {'YES' if task.planning_required else 'NO'}")

    print("-" * 65)
    print(f" Workflow State: {state.state.value}")
    print(f" Assigned Role:  {state.assigned_role.value}")
    print(f" State Reason:   {state.reason}")

    if state.model_selection:
        ms = state.model_selection
        p = ms.profile
        print("-" * 65)
        print(" Model Profile Selection:")
        print(f"  Provider:       {p.provider.title()}")
        print(f"  Profile:        {p.name}")
        print(f"  Model:          {p.model}")
        print(f"  Effort:         {p.effort}")
        print(f"  Selection Note: {ms.reason}")
        if ms.escalation_level > 0:
            print(f"  Escalation Lvl: {ms.escalation_level} (Escalated)")

    if state.is_hard_stop:
        print("!" * 65)
        print(f" HARD STOP: {state.stop_reason}")
        print("!" * 65)
    else:
        print(f" Next Action:    {state.next_action_description}")

    print("=" * 65)
    return 0


def cmd_run(
    config: SupervisorConfig,
    once: bool = False,
    dry_run: bool = False,
    live: bool = False,
    enable_auto_commit: bool = False,
    max_tasks: int = 3,
) -> int:
    """Execute supervisor workflow steps with dry-run and single-step safety options."""
    # Update config from CLI flags
    config.enable_live_agents = live
    config.enable_auto_commit = enable_auto_commit
    
    runner = SupervisorRunner(config)
    cli_invocation: Optional[AgentInvocation] = None

    def display_invocation(invocation: AgentInvocation) -> None:
        nonlocal cli_invocation
        cli_invocation = invocation
        print("\n EXECUTED TRANSITION (invocation captured before launch)")
        print(f" Run ID:         {invocation.run_id}")
        print(f" Before State:   {invocation.workflow_state_before}")
        print(f" Role:           {invocation.role.value}")
        print(f" Provider:       {invocation.provider.title()}")
        print(f" Model:          {invocation.model}")
        print(f" Effort:         {invocation.effort}")
        print(f" Action:         {invocation.action}")
        print(f" Selection Reason: {invocation.selection_reason}", flush=True)
    
    print("=" * 65)
    if dry_run:
        mode_desc = "DRY-RUN (Simulated; zero agent calls, zero file/Git writes)"
    elif live and once:
        mode_desc = "LIVE SINGLE-STEP (Executing at most 1 authorized transition)"
    elif once:
        mode_desc = "SINGLE-STEP (Gated; use --live to allow agent execution)"
    else:
        mode_desc = "CONTINUOUS (Disabled in MVP)"
    print(f" KhataSathi Workflow Supervisor - Mode: {mode_desc}")
    print("=" * 65)

    try:
        if dry_run or once or not live:
            state, stop_report = runner.run_step(
                dry_run=dry_run, execute_agents=(live and not dry_run),
                on_invocation=display_invocation if live and not dry_run else None,
            )
            reanchor_verified = runner.has_current_reanchor_record()
            deterministic_verified = runner.has_current_verification_record() or reanchor_verified
            if (live and not dry_run and not stop_report and not deterministic_verified
                    and (runner.last_action or state.assigned_role in {Role.SENIOR, Role.PLANNER, Role.IMPLEMENTATION})
                    and (not cli_invocation or cli_invocation != runner.current_invocation
                         or not runner.has_current_execution_record())):
                stop_report = StopReport(
                    state=WorkflowState.SUPERVISOR_INVOCATION_IDENTITY_MISMATCH,
                    task_id=state.active_task_id,
                    reason="SUPERVISOR_INVOCATION_IDENTITY_MISMATCH: CLI invocation does not match execution evidence",
                )
                runner.write_stop_report(stop_report)
            if live and not dry_run:
                result = runner.current_agent_result
                print("\n RESULT")
                print(f" After State:    {(runner.last_run_record or {}).get('workflow_state_after', state.state.value)}")
                print(f" Transition Verified: {not stop_report and (deterministic_verified or runner.has_current_execution_record())}")
                print(f" Observable Effect: {deterministic_verified or bool(result and result.observable_repo_effect)}")
                print(f" Postconditions Valid: {deterministic_verified or bool(result and result.postconditions_valid)}")
                if deterministic_verified:
                    print(f" Action: {'REANCHOR' if reanchor_verified else 'TARGETED_VERIFICATION'} (Supervisor; zero agent calls)")
                if not stop_report:
                    print("\n NEXT TRANSITION")
            else:
                print(f" Current State:  {state.state.value}")
            if not stop_report:
                print(f" Assigned Role:  {state.assigned_role.value}")
                print(f" Next Action:    {state.next_action_description or state.reason}")

            if state.model_selection and not stop_report:
                ms = state.model_selection
                p = ms.profile
                print(f" {'Next Model' if live and not dry_run else 'Selected Model'}: {p.provider.title()} / {p.name} -> {p.model} ({p.effort} effort)")
                if live and not dry_run:
                    print(f" Provider:       {p.provider.title()}")
                    print(f" Model:          {p.model}")
                print(f" Model Reason:   {ms.reason}")
                if ms.escalation_level > 0:
                    print(f" Escalation Lvl: {ms.escalation_level}")

            if stop_report:
                print("!" * 65)
                print(f" STOP REPORT: {stop_report.state.value}")
                print(f" Reason: {stop_report.reason}")
                print(f" Recommended Action: {stop_report.recommended_next_action}")
                print(f" Resume Command:     {stop_report.resume_command}")
                print("!" * 65)
                return 1

            if dry_run:
                print("\n [DRY-RUN COMPLETE] Zero modifications made to workspace or Git.")
            elif not live:
                print("\n [INSPECTION COMPLETE] No agent executed. Use --once --live for one agent call.")
            elif deterministic_verified:
                print(f"\n [STEP COMPLETE] Verified supervisor TARGETED_VERIFICATION transition. Run ID: {runner.current_run_id}")
            elif state.assigned_role in {Role.SENIOR, Role.PLANNER, Role.IMPLEMENTATION} or runner.last_action:
                if (not cli_invocation or cli_invocation != runner.current_invocation
                        or not runner.has_current_execution_record()):
                    print("\n [SUPERVISOR_INVOCATION_IDENTITY_MISMATCH] Current invocation/result/telemetry identity is missing or inconsistent.")
                    runner.write_stop_report(StopReport(
                        state=WorkflowState.SUPERVISOR_INVOCATION_IDENTITY_MISMATCH,
                        task_id=state.active_task_id,
                        reason="SUPERVISOR_INVOCATION_IDENTITY_MISMATCH: CLI invocation does not match execution evidence",
                    ))
                    return 1
                print(f"\n [STEP COMPLETE] Verified {cli_invocation.provider.title()} {cli_invocation.role.value} transition. Run ID: {cli_invocation.run_id}")
            else:
                print("\n [SUPERVISOR STEP COMPLETE] No agent invocation was selected.")
            return 0
        else:
            if not config.allow_continuous:
                print(" [SAFETY GATE] Continuous multi-task execution is disabled for MVP.")
                print(" Use `ks-supervisor run --once --live` for single-step transitions.")
                return 1
            return 0
    except RuntimeError as e:
        print(f" SUPERVISOR ERROR: {e}")
        return 1


def main(argv: Optional[list] = None) -> int:
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        prog="ks-supervisor",
        description="Deterministic local orchestration supervisor for KhataSathi Workflow v2.",
    )
    parser.add_argument("--repo", default=".", help="Path to repository root (defaults to current dir)")
    subparsers = parser.add_subparsers(dest="command", help="Available subcommands")

    # doctor
    subparsers.add_parser("doctor", help="Run system, environment, and repository diagnostics")

    # status
    subparsers.add_parser("status", help="Read-only status of repository, active task, and workflow state")

    inspect_parser = subparsers.add_parser("inspect", help="V3 authoritative JSON facts; no agent or workflow writes")
    inspect_parser.add_argument("--json", action="store_true")
    chat_parser = subparsers.add_parser("chat-entrypoint", help="Resolve exact AGENTS chat token in current Codex session; no role execution")
    chat_parser.add_argument("token", choices=["ks-start", "ks-plan", "ks-impl", "ks-senior", "ks-next"])
    chat_parser.add_argument("--json", action="store_true")
    worker_parser = subparsers.add_parser("delegate-gemini", help="One workspace-only Gemini worker; no orchestration")
    worker_parser.add_argument("--task", required=True)
    worker_parser.add_argument("--mode", choices=["implement", "fix"], default="implement")
    worker_parser.add_argument("--correction", help="Repository-local current-content correction JSON from Codex")
    worker_parser.add_argument("--continuation", help="Current-content bounded slice JSON from Codex")
    worker_parser.add_argument("--json", action="store_true")
    verify_parser = subparsers.add_parser("verify-source", help="Codex-selected reviewed source checks with content-bound evidence")
    verify_parser.add_argument("--task", required=True)
    verify_parser.add_argument("--command", dest="check_commands", action="append", required=True)
    verify_parser.add_argument("--content-identity", required=True)
    verify_parser.add_argument("--source-reviewed", action="store_true", help="Codex has inspected scripts/tests and confirmed no connected/external actions")
    verify_parser.add_argument("--json", action="store_true")
    cycle_parser = subparsers.add_parser("record-cycle", help="Record Codex logical role outcome and persistent safety budget")
    cycle_parser.add_argument("--task", default="")
    cycle_parser.add_argument("--phase", required=True)
    cycle_parser.add_argument("--outcome", required=True)
    cycle_parser.add_argument("--blocker", action="append", default=[])
    cycle_parser.add_argument("--reason", default="")
    cycle_parser.add_argument("--failure-signature", default="")
    cycle_parser.add_argument("--json", action="store_true")
    recovery_parser = subparsers.add_parser("recover-runtime-log-gate", help="Append explicit recovery of one bound adapter-log false gate")
    recovery_parser.add_argument("--task", required=True)
    recovery_parser.add_argument("--mission", required=True)
    recovery_parser.add_argument("--blocked-run", required=True)
    recovery_parser.add_argument("--authorization", required=True)
    recovery_parser.add_argument("--json", action="store_true")
    auth_recovery_parser = subparsers.add_parser("recover-auth-output-gate", help="Append explicit recovery of proven model-prose auth false positive")
    auth_recovery_parser.add_argument("--task", required=True)
    auth_recovery_parser.add_argument("--mission", required=True)
    auth_recovery_parser.add_argument("--blocked-run", required=True)
    auth_recovery_parser.add_argument("--authorization", required=True)
    auth_recovery_parser.add_argument("--json", action="store_true")
    progress_parser = subparsers.add_parser("record-worker-checkpoint", help="Record Codex-inspected progress; never acceptance")
    progress_parser.add_argument("--task", required=True)
    progress_parser.add_argument("--mission", required=True)
    progress_parser.add_argument("--run", required=True)
    progress_parser.add_argument("--assessment", required=True)
    progress_parser.add_argument("--json", action="store_true")
    for tool_parser in (worker_parser, verify_parser, cycle_parser):
        tool_parser.add_argument("--mission", help="ks-start immutable one-task mission handle; manual use may omit")
    mission_parser = subparsers.add_parser("mission", help="One-task binding/completion facts, never executes roles")
    mission_parser.add_argument("operation", choices=["begin", "bind", "finish"])
    mission_parser.add_argument("--mission")
    mission_parser.add_argument("--task", default="")
    mission_parser.add_argument("--accepted-file", action="append", default=[])
    mission_parser.add_argument("--next-task", default="")
    mission_parser.add_argument("--next-title", default="")
    mission_parser.add_argument("--json", action="store_true")
    role_parser = subparsers.add_parser("role-instructions", help="Existing manual role builders, no agent execution")
    role_parser.add_argument("role", choices=["ks-plan", "ks-impl", "ks-senior", "ks-next"])
    role_parser.add_argument("--task", default="")
    role_parser.add_argument("--action", default="")
    role_parser.add_argument("--mission")
    role_parser.add_argument("--json", action="store_true")

    # run
    run_parser = subparsers.add_parser("run", help="Execute supervisor workflow step(s)")
    run_parser.add_argument("--once", action="store_true", default=True, help="Execute at most ONE transition/role, then exit (default: True)")
    run_parser.add_argument("--dry-run", action="store_true", help="Inspect state and report what WOULD run without invoking agents or modifying Git")
    run_parser.add_argument("--live", action="store_true", help="Explicitly allow ONE live AI agent subprocess invocation")
    run_parser.add_argument("--enable-auto-commit", action="store_true", help="Explicitly enable hygiene-gated auto-commit")
    run_parser.add_argument("--max-tasks", type=int, default=3, help="Maximum tasks in continuous run")

    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 0

    config = SupervisorConfig(repo_root=Path(args.repo).resolve())

    if args.command in {"inspect", "chat-entrypoint", "delegate-gemini", "verify-source", "record-cycle", "mission", "role-instructions", "recover-runtime-log-gate", "recover-auth-output-gate", "record-worker-checkpoint"}:
        from tools.ks_supervisor.toolbox import (inspect_repository, delegate_gemini, verify_source, record_cycle,
            DirectCodexVerificationRequired, begin_mission, bind_mission, finish_mission, role_instructions, chat_entrypoint, recover_runtime_log_gate, recover_auth_output_gate, record_worker_checkpoint)
        try:
            if args.command == "inspect":
                result = inspect_repository(config)
            elif args.command == "chat-entrypoint":
                result = chat_entrypoint(config, args.token)
            elif args.command == "delegate-gemini":
                result = delegate_gemini(config, args.task, args.mode,
                                         config.repo_root / args.correction if args.correction else None, mission_id=args.mission,
                                         continuation_path=config.repo_root / args.continuation if args.continuation else None)
            elif args.command == "record-worker-checkpoint":
                from tools.ks_supervisor.toolbox import _packet_path
                packet = json.loads(_packet_path(config, config.repo_root / args.assessment).read_text(encoding="utf-8"))
                result = record_worker_checkpoint(config, args.task, args.mission, args.run, packet)
            elif args.command == "recover-runtime-log-gate":
                result = recover_runtime_log_gate(config, args.task, args.mission, args.blocked_run, args.authorization)
            elif args.command == "recover-auth-output-gate":
                result = recover_auth_output_gate(config, args.task, args.mission, args.blocked_run, args.authorization)
            elif args.command == "verify-source":
                result = verify_source(config, args.task, args.check_commands,
                                       args.content_identity, args.source_reviewed, mission_id=args.mission)
            elif args.command == "role-instructions":
                result = role_instructions(config, args.role, args.task, args.action, args.mission)
            elif args.command == "mission":
                if args.operation == "begin":
                    result = begin_mission(config)
                elif args.operation == "bind":
                    result = bind_mission(config, args.mission or "", args.task)
                else:
                    result = finish_mission(config, args.mission or "", args.accepted_file, args.next_task, args.next_title)
            else:
                result = record_cycle(config, args.task, args.phase, args.outcome, args.blocker, args.reason, args.failure_signature, mission_id=args.mission)
            print(json.dumps(result, indent=2, default=str))
            budget = result.get("budget", result.get("cycle", {}).get("budget", {}))
            return 1 if (result.get("outcome") in {"FAIL", "UNAVAILABLE", "AUTH_QUOTA", "HUMAN_GATE", "INFRASTRUCTURE_FAILURE", "NO_EFFECT"}
                         or budget.get("status") == "HUMAN_INPUT_REQUIRED") else 0
        except DirectCodexVerificationRequired as exc:
            print(json.dumps({"status": "DIRECT_CODEX_VERIFICATION_REQUIRED", "reason": str(exc),
                              "next": "RETURN_TO_CODEX", "acceptance_certified": False}))
            return 2
        except (ValueError, RuntimeError, OSError) as exc:
            from tools.ks_supervisor.adapters.base import redact_secrets
            print(json.dumps({"status": "HUMAN_INPUT_REQUIRED", "reason": redact_secrets(str(exc)),
                              "safe_resume_action": "Resolve the reported authority/target/tooling gate; resume ks-start's bound mission without resetting work"}))
            return 1

    if args.command == "doctor":
        return cmd_doctor(config)
    elif args.command == "status":
        return cmd_status(config)
    elif args.command == "run":
        return cmd_run(
            config,
            once=args.once,
            dry_run=args.dry_run,
            live=args.live,
            enable_auto_commit=args.enable_auto_commit,
            max_tasks=args.max_tasks,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
