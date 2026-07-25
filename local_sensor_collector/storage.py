"""
storage.py — 本地 JSONL 储存模块
===================================
所有采集数据以 JSONL 格式储存（每行一个 JSON 对象），
外加一个 samples.json 索引文件记录元数据。
与之前的 miniprogram local-sensor-storage.js 功能等价，纯 Python。
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

_LOGGER = logging.getLogger(__name__)

# ─── 默认储存路径（可被环境变量覆盖） ──────────────────────────────────
DEFAULT_STORAGE_DIR = Path(__file__).resolve().parent / "collected_data"


class Storage:
    """本地传感器数据储存器。

    目录结构:
        collected_data/
        ├── samples.json            # 样本索引
        ├── raw_20260725_143021.jsonl   # 原始帧流水
        └── processed_20260725_143021.jsonl  # 处理后帧流水（含偏置校正）
    """

    def __init__(self, storage_dir: Optional[str] = None):
        self.storage_dir = Path(storage_dir or os.getenv(
            "LOCAL_COLLECTOR_STORAGE_DIR",
            str(DEFAULT_STORAGE_DIR),
        ))
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self._index_path = self.storage_dir / "samples.json"
        self._load_index()
        _LOGGER.info("储存目录: %s", self.storage_dir)

    # ─── 索引管理 ────────────────────────────────────────────────────────

    def _load_index(self) -> None:
        """加载样本索引。"""
        if self._index_path.exists():
            try:
                with open(self._index_path, "r", encoding="utf-8") as f:
                    self._index = json.load(f)
                if not isinstance(self._index, dict) or "samples" not in self._index:
                    self._index = {"samples": []}
            except (json.JSONDecodeError, Exception):
                self._index = {"samples": []}
        else:
            self._index = {"samples": []}

    def _save_index(self) -> None:
        """保存样本索引。"""
        with open(self._index_path, "w", encoding="utf-8") as f:
            json.dump(self._index, f, ensure_ascii=False, indent=2)

    def get_index(self) -> Dict[str, Any]:
        return self._index

    # ─── 帧储存（流式 JSONL） ────────────────────────────────────────────

    def _session_filename(self, prefix: str = "raw") -> str:
        """按当前时间生成文件名。"""
        now = datetime.now().strftime("%Y%m%d_%H%M%S")
        return f"{prefix}_{now}.jsonl"

    def save_raw_frames(self, frames: List[Dict[str, Any]],
                        session_tag: str = "") -> str:
        """将原始帧追加写入 JSONL 文件。

        返回: 文件名
        """
        if not frames:
            return ""
        filename = self._session_filename("raw")
        filepath = self.storage_dir / filename
        with open(filepath, "a", encoding="utf-8") as f:
            for frame in frames:
                f.write(json.dumps(frame, ensure_ascii=False) + "\n")
        _LOGGER.info("已保存 %d 帧原始数据到 %s", len(frames), filename)
        return filename

    def save_processed_frames(self, frames: List[Dict[str, Any]],
                              session_tag: str = "") -> str:
        """将处理后帧追加写入 JSONL 文件。"""
        if not frames:
            return ""
        filename = self._session_filename("processed")
        filepath = self.storage_dir / filename
        with open(filepath, "a", encoding="utf-8") as f:
            for frame in frames:
                f.write(json.dumps(frame, ensure_ascii=False) + "\n")
        _LOGGER.info("已保存 %d 帧处理后数据到 %s", len(frames), filename)
        return filename

    # ─── 完整样本保存 ────────────────────────────────────────────────────

    def save_sample(self, sample: Dict[str, Any]) -> str:
        """保存一个完整的采集样本（含元数据 + 帧 + 标签）。

        样本写入 samples.json 索引，帧分别写入 raw/processed JSONL。

        返回: sample_id
        """
        import hashlib
        import time

        # 生成样本 ID
        raw = f"{time.time_ns()}{json.dumps(sample.get('frames', [])[:1])}"
        sample_id = hashlib.md5(raw.encode()).hexdigest()[:12]

        frames = sample.get("frames", [])
        raw_frames = sample.get("raw_frames", frames)
        processed_frames = sample.get("processed_frames", frames)

        # 保存帧数据
        raw_file = self.save_raw_frames(raw_frames, sample_id)
        proc_file = self.save_processed_frames(processed_frames, sample_id)

        # 构建索引条目
        entry = {
            "sample_id": sample_id,
            "created_at": datetime.now().isoformat(),
            "action_type": sample.get("action_type", ""),
            "source_type": sample.get("source_type", "mqtt"),
            "is_completed": sample.get("is_completed", True),
            "frame_count": len(processed_frames),
            "raw_frame_count": len(raw_frames),
            "coach_score": sample.get("label", {}).get("coach_score", 0),
            "quality_tag": sample.get("label", {}).get("quality_tag", ""),
            "note": sample.get("note", ""),
            "raw_file": str(raw_file),
            "processed_file": str(proc_file),
            "bench_bias_applied": sample.get("bench_bias_applied", False),
            "roles": sample.get("roles", []),
        }

        self._index["samples"].insert(0, entry)
        self._save_index()

        _LOGGER.info("样本已保存: %s (%d 帧, %s)", sample_id,
                     len(processed_frames), sample.get("action_type", "?"))
        return sample_id

    # ─── 查询 ────────────────────────────────────────────────────────────

    def list_samples(self, page: int = 1, page_size: int = 20) -> Dict[str, Any]:
        """分页列出样本索引。"""
        samples = self._index.get("samples", [])
        start = (page - 1) * page_size
        items = samples[start:start + page_size]
        return {"items": items, "total": len(samples), "page": page}

    def load_sample(self, sample_id: str) -> Optional[Dict[str, Any]]:
        """加载指定样本的完整数据。"""
        for entry in self._index.get("samples", []):
            if entry.get("sample_id") == sample_id:
                proc_file = self.storage_dir / entry["processed_file"]
                if proc_file.exists():
                    frames = []
                    with open(proc_file, "r", encoding="utf-8") as f:
                        for line in f:
                            line = line.strip()
                            if line:
                                frames.append(json.loads(line))
                    return {**entry, "frames": frames}
                break
        return None

    def delete_sample(self, sample_id: str) -> bool:
        """删除样本（仅从索引移除，保留 JSONL 文件）。"""
        samples = self._index.get("samples", [])
        before = len(samples)
        self._index["samples"] = [
            s for s in samples if s.get("sample_id") != sample_id
        ]
        if len(self._index["samples"]) < before:
            self._save_index()
            return True
        return False

    # ─── 导出 ────────────────────────────────────────────────────────────

    def export_all(self) -> List[Dict[str, Any]]:
        """导出所有样本的完整数据。"""
        result = []
        for entry in self._index.get("samples", []):
            sample = self.load_sample(entry["sample_id"])
            if sample:
                result.append(sample)
        return result


# 模块级单例
_default_storage: Optional[Storage] = None


def get_storage(storage_dir: Optional[str] = None) -> Storage:
    global _default_storage
    if _default_storage is None or storage_dir is not None:
        _default_storage = Storage(storage_dir)
    return _default_storage
