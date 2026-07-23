from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.training_denoise import filter_training_frames  # noqa: E402


class TrainingDenoiseProfileTests(unittest.TestCase):
    def test_bench_profile_is_used_when_active_profile_missing(self) -> None:
        frames = [
            {"t": index * 20, "p": {"waist": [0, 0, 1, -0.358779, 0.992366, -1.183206]}}
            for index in range(20)
        ]
        _, report = filter_training_frames(frames, roles=["waist"])
        role_report = report["roles"]["waist"]
        self.assertTrue(role_report["calibration_applied"])
        self.assertEqual(role_report["calibration_source"], "bench_v3_raw")

    def test_valid_active_profile_overrides_bench_profile(self) -> None:
        frames = [
            {"t": index * 20, "p": {"waist": [0, 0, 1, 2, 0, 0]}}
            for index in range(20)
        ]
        _, report = filter_training_frames(
            frames,
            roles=["waist"],
            profiles={
                "waist": {
                    "node_id": "waist",
                    "calibration_mode": "firmware_calibrated",
                    "gyro_bias": [2, 0, 0],
                    "metadata": {"calibration_status": "ready"},
                }
            },
        )
        self.assertEqual(
            report["roles"]["waist"]["calibration_source"], "active"
        )


if __name__ == "__main__":
    unittest.main()
