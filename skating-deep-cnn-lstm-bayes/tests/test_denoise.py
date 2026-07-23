from __future__ import annotations

import unittest

import numpy as np

from src.denoise import (
    CalibrationProfile,
    apply_calibration,
    fit_temperature_bias,
    process_single_node_sequence,
    process_training_frames,
    validate_timestamps,
)


class DenoiseCalibrationTests(unittest.TestCase):
    def test_validate_timestamps_detects_duplicate_and_gap(self) -> None:
        report = validate_timestamps([0, 20, 40, 40, 100], sample_rate_hz=50)
        self.assertEqual(report["duplicate_count"], 1)
        self.assertEqual(report["gap_count"], 1)
        self.assertEqual(report["estimated_missing_frames"], 2)

    def test_temperature_fit_recovers_linear_slope(self) -> None:
        temperature = np.linspace(20.0, 35.0, 500)
        slope = np.asarray([0.1, -0.2, 0.05])
        values = 2.0 + (temperature - 27.5)[:, None] * slope[None, :]
        result = fit_temperature_bias(temperature, values)
        self.assertTrue(result["enabled"])
        np.testing.assert_allclose(result["slope_per_c"], slope, atol=1e-10)
        np.testing.assert_allclose(result["r_squared"], np.ones(3), atol=1e-10)

    def test_temperature_fit_rejects_small_span(self) -> None:
        temperature = np.linspace(27.0, 27.5, 100)
        values = np.column_stack([temperature, temperature, temperature])
        result = fit_temperature_bias(temperature, values)
        self.assertFalse(result["enabled"])
        self.assertIn("temperature_span_too_small", result["reason"])

    def test_apply_residual_bias_and_temperature_compensation(self) -> None:
        temperature = np.asarray([25.0, 26.0, 27.0])
        sequence = np.zeros((3, 1, 6), dtype=np.float32)
        sequence[:, 0, 3] = 1.0 + 0.2 * (temperature - 25.0)
        profile = CalibrationProfile(
            node_id="waist",
            reference_temperature_c=25.0,
            gyro_bias=[1.0, 0.0, 0.0],
            gyro_temperature_slope=[0.2, 0.0, 0.0],
            temperature_compensation_enabled=True,
        )
        corrected = apply_calibration(sequence, profile, temperature)
        np.testing.assert_allclose(corrected[:, 0, 3:], 0.0, atol=1e-6)

    def test_pipeline_removes_single_spike(self) -> None:
        sequence = np.zeros((101, 1, 6), dtype=np.float32)
        sequence[50, 0, 0] = 100.0
        result, stats = process_single_node_sequence(sequence)
        self.assertEqual(stats["outliers_replaced"], 1)
        self.assertAlmostEqual(float(result[50, 0, 0]), 0.0)

    def test_pipeline_supports_separate_acc_and_gyro_cutoffs(self) -> None:
        time = np.arange(500) / 50.0
        sequence = np.zeros((500, 1, 6), dtype=np.float32)
        sequence[:, 0, 0] = np.sin(2 * np.pi * 15 * time)
        sequence[:, 0, 3] = np.sin(2 * np.pi * 15 * time)
        result, stats = process_single_node_sequence(
            sequence,
            remove_spikes=False,
            acc_cutoff_hz=8.0,
            gyro_cutoff_hz=12.0,
        )
        self.assertTrue(stats["lowpass_applied"])
        self.assertLess(np.std(result[:, 0, 0]), np.std(sequence[:, 0, 0]) * 0.2)
        self.assertLess(np.std(result[:, 0, 3]), np.std(sequence[:, 0, 3]) * 0.6)

    def test_training_frames_preserve_layout_and_report_missing_role(self) -> None:
        frames = [
            {"t": index * 20, "p": {"waist": [0, 0, 1, 0, 0, 0]}}
            for index in range(101)
        ]
        frames[50]["p"]["waist"][0] = 100
        processed, report = process_training_frames(
            frames,
            roles=["waist", "left_knee"],
        )
        self.assertEqual(processed[0]["t"], 0)
        self.assertEqual(processed[50]["p"]["waist"][0], 0.0)
        self.assertEqual(report["total_outliers_replaced"], 1)
        self.assertEqual(report["roles"]["waist"]["coverage_ratio"], 1.0)
        self.assertEqual(report["roles"]["left_knee"]["status"], "missing")

    def test_training_frames_apply_only_explicit_residual_profile(self) -> None:
        frames = [
            {"t": index * 20, "p": {"waist": [0, 0, 1, 1.5, 0, 0]}}
            for index in range(20)
        ]
        unchanged, unchanged_report = process_training_frames(frames)
        corrected, corrected_report = process_training_frames(
            frames,
            profiles={
                "waist": CalibrationProfile(
                    node_id="waist",
                    gyro_bias=[0.5, 0, 0],
                )
            },
        )
        self.assertEqual(unchanged[0]["p"]["waist"][3], 1.5)
        self.assertEqual(corrected[0]["p"]["waist"][3], 1.0)
        self.assertFalse(
            unchanged_report["roles"]["waist"]["calibration_applied"]
        )
        self.assertTrue(corrected_report["roles"]["waist"]["calibration_applied"])

    def test_training_frames_support_verbose_points_schema(self) -> None:
        frames = [
            {
                "t": index * 20,
                "points": {
                    "waist": {
                        "ax": 0,
                        "ay": 0,
                        "az": 1,
                        "gx": 0,
                        "gy": 0,
                        "gz": 0,
                    }
                },
            }
            for index in range(101)
        ]
        frames[50]["points"]["waist"]["gx"] = 1200
        processed, report = process_training_frames(frames)
        self.assertEqual(processed[50]["points"]["waist"]["gx"], 0.0)
        self.assertEqual(report["roles"]["waist"]["sample_count"], 101)
        self.assertEqual(report["total_outliers_replaced"], 1)

    def test_training_frames_report_complete_five_node_alignment(self) -> None:
        roles = [
            "waist",
            "left_knee",
            "right_knee",
            "left_foot",
            "right_foot",
        ]
        frames = [
            {
                "t": index * 20,
                "points": {
                    role: {"ax": 0, "ay": 0, "az": 1, "gx": 0, "gy": 0, "gz": 0}
                    for role in roles
                },
            }
            for index in range(180)
        ]
        processed, report = process_training_frames(frames, roles=roles)
        self.assertEqual(len(processed), 180)
        for role in roles:
            self.assertEqual(report["roles"][role]["coverage_ratio"], 1.0)
            self.assertEqual(
                report["roles"][role]["timestamp_quality"]["gap_count"],
                0,
            )


if __name__ == "__main__":
    unittest.main()
