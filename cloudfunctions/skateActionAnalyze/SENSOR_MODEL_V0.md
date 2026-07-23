# Sensor Model v0 + API Integration

This cloud function supports sensor-session analysis and training-sample saving.

## Analyze Sensor Session

Call:

```js
wx.cloud.callFunction({
  name: "skateActionAnalyze",
  data: {
    type: "analyzeSensorSession",
    sessionId: "session_001",
    actionType: "basic_skating",
    note: "left knee unstable",
    userId: "u_123",
    frames: [
      {
        t: 1710000000000,
        points: {
          head: { ax: 0.1, ay: 0.2, az: 9.7, gx: 0.01, gy: 0.02, gz: 0.03 },
          left_elbow: { ax: 0.0, ay: 0.1, az: 9.8, gx: 0.02, gy: 0.01, gz: 0.00 },
          right_elbow: { ax: 0.0, ay: 0.1, az: 9.8, gx: 0.01, gy: 0.01, gz: 0.01 },
          left_wrist: { ax: 0.1, ay: 0.0, az: 9.8, gx: 0.02, gy: 0.02, gz: 0.01 },
          right_wrist: { ax: 0.1, ay: 0.0, az: 9.8, gx: 0.01, gy: 0.02, gz: 0.01 },
          left_knee: { ax: 0.2, ay: 0.1, az: 9.6, gx: 0.03, gy: 0.01, gz: 0.02 },
          right_knee: { ax: 0.2, ay: 0.1, az: 9.6, gx: 0.02, gy: 0.02, gz: 0.02 },
          left_foot: { ax: 0.2, ay: 0.0, az: 9.7, gx: 0.02, gy: 0.03, gz: 0.02 },
          right_foot: { ax: 0.2, ay: 0.0, az: 9.7, gx: 0.03, gy: 0.03, gz: 0.02 }
        }
      }
    ]
  }
})
```

Success response includes:

- `analysis.overallScore`
- `analysis.metrics`
- `analysis.tips`
- `analysis.sensorSession`
- `inferenceMode`
- `sensorApiMode`

## Save Sensor Training Sample

Call:

```js
wx.cloud.callFunction({
  name: "skateActionAnalyze",
  data: {
    type: "saveSensorTrainingSample",
    sessionId: "session_001",
    actionType: "basic_skating",
    note: "coach labeled",
    userId: "u_123",
    label: {
      coachScore: 82,
      qualityTag: "good",
      coachComment: "stability improved",
      tags: ["knee", "balance"]
    },
    frames: [/* same frame format */]
  }
})
```

Collection:

- `skate_sensor_training_samples`

## Data Rules

- Required roles: `head`, `left_elbow`, `right_elbow`, `left_wrist`, `right_wrist`, `left_knee`, `right_knee`, `left_foot`, `right_foot`
- Minimum frames: `24`

## Remote Sensor API (interface mode)

Cloud function supports external model service by env vars:

- `SENSOR_API_ENABLED=true`
- `SENSOR_API_URL=https://<your-domain>/infer` (or set `SENSOR_API_FUNCTION`)
- `SENSOR_API_TOKEN=<optional-token>`
- `SENSOR_API_TIMEOUT_MS=20000`

### API-only (no local fallback)

To force "interface only" mode (recommended for production model validation):

- `SENSOR_API_MODE=api_only` (or `remote_only` / `strict`)
- or `SENSOR_API_STRICT=true`

In strict mode:

- if remote API is unavailable, cloud function returns error directly
- no fallback to `sensor_rule_v0`

## Important

- Cloud function runs on cloud, it cannot read local PC path like `D:\...` directly.
- Local model files must be served via an accessible API endpoint (`/infer`).
