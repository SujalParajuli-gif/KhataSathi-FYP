"""KhataSathi Workflow Supervisor - OS-Backed Exclusive Locking & Recovery."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
import sys
import uuid
from typing import Any, Dict, Optional

from tools.ks_supervisor.config import SupervisorConfig

# Platform-specific OS file locking
if os.name == "nt":
    import msvcrt

    def _lock_file(file_obj) -> bool:
        try:
            file_obj.seek(0)
            msvcrt.locking(file_obj.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except (IOError, OSError):
            return False

    def _unlock_file(file_obj) -> None:
        try:
            file_obj.seek(0)
            msvcrt.locking(file_obj.fileno(), msvcrt.LK_UNLCK, 1)
        except (IOError, OSError):
            pass

else:
    import fcntl

    def _lock_file(file_obj) -> bool:
        try:
            fcntl.flock(file_obj.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except (IOError, OSError):
            return False

    def _unlock_file(file_obj) -> None:
        try:
            fcntl.flock(file_obj.fileno(), fcntl.LOCK_UN)
        except (IOError, OSError):
            pass


def is_pid_alive(pid: int) -> bool:
    """Check if a process with the given PID is currently running."""
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.windll.kernel32
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        SYNCHRONIZE = 0x00100000
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, wintypes.DWORD(pid))
        if not handle:
            return False
        # Check exit code
        exit_code = wintypes.DWORD()
        res = kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
        kernel32.CloseHandle(handle)
        STILL_ACTIVE = 259
        return bool(res and exit_code.value == STILL_ACTIVE)
    else:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False


class SupervisorLock:
    """Exclusive supervisor lock with OS-level primitives and stale metadata recovery."""

    def __init__(self, config: SupervisorConfig, task_id: str = "", role: str = ""):
        self.config = config
        self.task_id = task_id
        self.role = role
        self.run_id = str(uuid.uuid4())
        self.lock_file_path = self.config.runtime_dir / "supervisor.lock"
        self.metadata_file_path = self.config.runtime_dir / "supervisor.lock.json"
        self._file_handle = None
        self._acquired = False

    def acquire(self) -> bool:
        """Attempt to acquire exclusive OS file lock."""
        self.config.runtime_dir.mkdir(parents=True, exist_ok=True)

        # Check existing metadata for diagnostic reasons
        existing_meta = self.get_lock_metadata()
        if existing_meta:
            existing_pid = existing_meta.get("pid")
            if existing_pid and is_pid_alive(existing_pid):
                # Lock is actively held by a live process
                return False

        try:
            # Open lock file for read/write (create if not exist)
            self._file_handle = open(self.lock_file_path, "a+b")
            if not _lock_file(self._file_handle):
                self._file_handle.close()
                self._file_handle = None
                return False

            self._acquired = True
            self._write_metadata()
            return True
        except Exception:
            if self._file_handle:
                try:
                    self._file_handle.close()
                except Exception:
                    pass
                self._file_handle = None
            return False

    def release(self) -> None:
        """Release OS lock and clean up metadata."""
        if not self._acquired or not self._file_handle:
            return
        
        try:
            _unlock_file(self._file_handle)
            self._file_handle.close()
        except Exception:
            pass
        finally:
            self._file_handle = None
            self._acquired = False

        try:
            if self.metadata_file_path.exists():
                self.metadata_file_path.unlink()
        except Exception:
            pass

    def _write_metadata(self) -> None:
        """Write runtime metadata JSON for diagnostics."""
        now_iso = datetime.now(timezone.utc).isoformat()
        meta = {
            "run_id": self.run_id,
            "pid": os.getpid(),
            "hostname": socket.gethostname(),
            "task_id": self.task_id,
            "current_role": self.role,
            "start_time": now_iso,
            "heartbeat": now_iso,
        }
        try:
            self.metadata_file_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        except Exception:
            pass

    def update_heartbeat(self, task_id: Optional[str] = None, role: Optional[str] = None) -> None:
        """Update the lock heartbeat and current activity."""
        if not self._acquired:
            return
        if task_id:
            self.task_id = task_id
        if role:
            self.role = role

        meta = self.get_lock_metadata() or {
            "run_id": self.run_id,
            "pid": os.getpid(),
            "hostname": socket.gethostname(),
            "start_time": datetime.now(timezone.utc).isoformat(),
        }
        meta["task_id"] = self.task_id
        meta["current_role"] = self.role
        meta["heartbeat"] = datetime.now(timezone.utc).isoformat()
        try:
            self.metadata_file_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        except Exception:
            pass

    def get_lock_metadata(self) -> Optional[Dict[str, Any]]:
        """Read current lock metadata from disk if present."""
        if not self.metadata_file_path.exists():
            return None
        try:
            return json.loads(self.metadata_file_path.read_text(encoding="utf-8"))
        except Exception:
            return None

    def __enter__(self):
        if not self.acquire():
            meta = self.get_lock_metadata()
            msg = "Failed to acquire exclusive supervisor lock."
            if meta:
                msg += f" Held by PID {meta.get('pid')} on {meta.get('hostname')} (Task: {meta.get('task_id')}, Role: {meta.get('current_role')})."
            raise RuntimeError(msg)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.release()
