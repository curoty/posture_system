# Sensor Data Schema (v1)

This document defines a single protocol used by:
- Device side data upload
- Mini Program client
- Cloud function `skateActionAnalyze`

## Encoding

- Transport encoding: `UTF-8`
- Field names: ASCII only (`snake_case` or fixed camelCase in existing API)
- Enum values: ASCII fixed strings
- Timestamps: Unix milliseconds (`Number`)

## Core Frame Structure

```json
{
  "t": 1773485000000,
  "points": {
    "head": { "ax": 0.1, "ay": 0.2, "az": 0.9, "gx": 0.01, "gy": 0.02, "gz": 0.03 },
    "left_elbow": { "ax": 0.0, "ay": 0.1, "az": 1.0, "gx": 0.01, "gy": 0.01, "gz": 0.02 },
    "right_elbow": { "ax": 0.0, "ay": 0.1, "az": 1.0, "gx": 0.01, "gy": 0.01, "gz": 0.02 },
    "left_knee": { "ax": 0.2, "ay": 0.2, "az": 0.8, "gx": 0.03, "gy": 0.02, "gz": 0.02 },
    "right_knee": { "ax": 0.2, "ay": 0.2, "az": 0.8, "gx": 0.03, "gy": 0.02, "gz": 0.02 }
  }
}
```

## Required Point Roles

- `head`
- `left_elbow`
- `right_elbow`
- `left_knee`
- `right_knee`

## API Types

- Analyze session: `type = "analyzeSensorSession"`
- Save training sample: `type = "saveSensorTrainingSample"`
- List samples: `type = "listSensorTrainingSamples"`
- Delete sample: `type = "deleteSensorTrainingSample"`

## Common Request Fields

- `sessionId: string`
- `actionType: string` (recommended enum values)
  - `sensor_session`
  - `basic_skating`
  - `curve_skating`
  - `weight_shift`
  - `side_push_recover`
  - `braking`
- `sourceType: string`
  - `mock`
  - `real_device`
- `userId: string` (student user id)
- `operatorUserId: string` (coach/admin user id)
- `note: string`
- `frames: Frame[]`

## Label Fields (save only)

- `label.coachScore: number` (0~100)
- `label.qualityTag: string`
- `label.coachComment: string`
- `label.tags: string[]`

## Storage Collection

- `skate_sensor_training_samples`
- Soft delete fields:
  - `isDeleted: true`
  - `deletedAt`
  - `deletedBy`

## Compatibility Rules

- Client side must not rename existing keys.
- New fields can be appended but old fields must remain readable.
- If enum extension is needed, append new values; do not change existing values.
