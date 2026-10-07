"""KhataSathi Workflow Supervisor - Base Agent Adapter Interface."""
from abc import ABC, abstractmethod
import os
import re
from typing import Dict, List, Tuple

from tools.ks_supervisor.config import SupervisorConfig
from tools.ks_supervisor.types import AgentResult, Role


_SECRET_PATTERNS: List[Tuple[re.Pattern, str]] = [
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9\-._~+/]{8,}=*"), r"\1<redacted>"),
    (re.compile(r"ya29\.[0-9A-Za-z\-_]{10,}"), "<redacted-oauth-token>"),
    (re.compile(r"AIza[0-9A-Za-z\-_]{30,}"), "<redacted-google-api-key>"),
    (re.compile(r"\bsk-[A-Za-z0-9\-_]{16,}"), "<redacted-api-key>"),
    (re.compile(r"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\"?\s*[=:]\s*\"?)[^\s\",]+"), r"\1<redacted>"),
]


def redact_secrets(text: str) -> str:
    """Remove credential-shaped substrings from diagnostic text."""
    if not text:
        return text
    for pattern, repl in _SECRET_PATTERNS:
        text = pattern.sub(repl, text)
    return text


def sanitize_environment(config: SupervisorConfig) -> Dict[str, str]:
    """Return a sanitized copy of os.environ without production or sensitive credentials."""
    env = dict(os.environ)
    prefixes = [p.upper() for p in config.sensitive_env_prefixes]
    
    # Strip forbidden keys
    keys_to_remove = []
    for k in env.keys():
        upper_k = k.upper()
        if any(upper_k.startswith(p) for p in prefixes):
            keys_to_remove.append(k)
        elif any(term in upper_k for term in ["SECRET", "PRIVATE_KEY", "PASSWORD", "PROD_DB"]):
            # Allow common local development variables like DEV_SECRET or TEST_PASSWORD
            if not upper_k.startswith(("DEV_", "TEST_", "LOCAL_")):
                keys_to_remove.append(k)

    for k in keys_to_remove:
        env.pop(k, None)

    return env


class BaseAgentAdapter(ABC):
    """Abstract base class for AI CLI subprocess adapters."""

    def __init__(self, config: SupervisorConfig):
        self.config = config

    @abstractmethod
    def check_availability(self) -> Dict[str, any]:
        """Check if the agent CLI binary is installed and operational."""
        pass

    @abstractmethod
    def invoke(self, role: Role, task_id: str, prompt: str, is_read_only: bool = False) -> AgentResult:
        """Invoke the agent subprocess with given role, prompt, and sandbox mode."""
        pass
