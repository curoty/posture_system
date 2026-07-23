"""Project-level configuration for skating-rf-baseline."""

from __future__ import annotations

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = PROJECT_ROOT / "data"
DEFAULT_MODEL_OUTPUT_DIR = PROJECT_ROOT / "models"

DEFAULT_WINDOW_START_SECONDS = 1.0
DEFAULT_WINDOW_END_SECONDS = 1.0
DEFAULT_RANDOM_SEED = 42
DEFAULT_ENABLE_MISSING_NODE_FLAGS = True
DEFAULT_MISSING_NODE_FILL_VALUE = 0.0
DEFAULT_MIN_VALID_NODES_PER_WINDOW = 6

DEFAULT_RANDOM_FOREST_PARAMS = {
    "n_estimators": 300,
    "max_depth": None,
    "min_samples_split": 2,
    "min_samples_leaf": 1,
    "max_features": "sqrt",
    "bootstrap": True,
    "random_state": DEFAULT_RANDOM_SEED,
    "n_jobs": 1,
}
