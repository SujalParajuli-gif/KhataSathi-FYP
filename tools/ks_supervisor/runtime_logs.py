"""Exact adapter-owned v3 logs; prior runtime evidence is never exempted."""
import hashlib
import re
from pathlib import Path


class _OwnedLog:
    def __init__(self, path):
        self.path = path
        self.stream = path.open("x", encoding="utf-8", newline="")
        self.digest = hashlib.sha256()

    @property
    def closed(self):
        return self.stream.closed

    def write(self, text):
        result = self.stream.write(text)
        self.digest.update(text.encode("utf-8"))
        return result

    def flush(self):
        self.stream.flush()

    def close(self):
        self.stream.close()


class SupervisorRuntimeLogs:
    def __init__(self, config, run_id):
        if not re.fullmatch(r"[0-9a-f]{32}", run_id):
            raise ValueError("Invalid runtime log invocation")
        self.root = config.runtime_dir.resolve()
        self.directory = config.runtime_dir / "v3" / "workers" / run_id / "logs"
        self.logs = []

    def open(self):
        # No arbitrary path, symlink/junction, existing log, or repository prefix
        # receives ownership. Legacy shared logs stay immutable in the v3 guard.
        for path in (self.directory, *self.directory.parents):
            if path == self.root:
                break
            if path.exists() and (path.is_symlink() or path.resolve() != path.absolute()):
                raise ValueError("Runtime log path is redirected")
        if not self.directory.resolve().is_relative_to(self.root):
            raise ValueError("Runtime log path escapes authoritative runtime")
        self.directory.mkdir(exist_ok=False)
        for name in ("current_agent_stream.jsonl", "current_agent_stderr.log"):
            self.logs.append(_OwnedLog(self.directory / name))
        return tuple(self.logs)

    def violations(self):
        expected = {log.path for log in self.logs}
        actual = set(self.directory.rglob("*")) if self.directory.exists() else set()
        problems = []
        for path in actual - expected:
            problems.append("Unowned worker runtime log artifact: " + path.name)
        for log in self.logs:
            if not log.closed:
                log.flush()
            if (log.path.is_symlink() or not log.path.is_file()
                    or not log.path.resolve().is_relative_to(self.root)
                    or hashlib.sha256(log.path.read_bytes()).hexdigest() != log.digest.hexdigest()):
                problems.append("Worker modified Supervisor-owned runtime log: " + log.path.name)
        return problems
