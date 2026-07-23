"""Persistent subprocess bridge that isolates the legacy `src` package name."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Dict, Optional


class DeepModelBridge:
    def __init__(self) -> None:
        self.process: Optional[subprocess.Popen[str]] = None
        self.error: Optional[str] = None
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        value = os.getenv("DEEP_INFERENCE_ENABLED", "true").strip().lower()
        return value not in {"0", "false", "off", "no"}

    @property
    def ready(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def start(self) -> None:
        if not self.enabled or self.ready:
            return
        worker = Path(__file__).with_name("deep_worker.py")
        try:
            self.process = subprocess.Popen(
                [sys.executable, "-u", str(worker)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=None,
                text=True,
                encoding="utf-8",
                bufsize=1,
                env=os.environ.copy(),
            )
            self.error = None
        except Exception as exc:
            self.process = None
            self.error = str(exc)

    def stop(self) -> None:
        process = self.process
        self.process = None
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()

    def predict(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.ready:
            raise RuntimeError(self.error or "deep model worker is not ready")
        assert self.process is not None
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        with self._lock:
            self.process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self.process.stdin.flush()
            line = self.process.stdout.readline()
        if not line:
            self.error = "deep model worker exited without a response"
            raise RuntimeError(self.error)
        response = json.loads(line)
        if not response.get("ok"):
            raise RuntimeError(str(response.get("error") or "deep inference failed"))
        result = response.get("result")
        if not isinstance(result, dict):
            raise RuntimeError("deep inference returned an invalid result")
        return result
