# hunyuanVisionService

Cloud function bridge for Tencent Hunyuan `hunyuan-turbos-vision-video`.

## Deploy

1. Open `cloudfunctions/hunyuanVisionService` in WeChat DevTools.
2. Right click the folder and choose:
   - Upload and Deploy: Install dependencies in cloud
3. Enable HTTP access for this function and copy the full HTTPS URL.

## Environment variables

- `HUNYUAN_API_KEY` (required): OpenAI-compatible API key (`sk-...`)
- `HUNYUAN_MODEL` (optional, default `hunyuan-turbos-vision-video`)
- `HUNYUAN_API_ENDPOINT` (optional, default `https://api.hunyuan.cloud.tencent.com/v1/chat/completions`)
- `HUNYUAN_TIMEOUT_MS` (optional, default `30000`)
- `HUNYUAN_MAX_TOKENS` (optional, default `1200`)
- `HUNYUAN_TEMPERATURE` (optional, default `0.2`)
- `HUNYUAN_VIDEO_FPS` (optional, default `2`)
- `STUB_ON_ERROR` (optional, default `false`)

During debugging, keep `STUB_ON_ERROR=false` so failures are visible.

## Wire into existing chain

Set in `keypointInfer`:

- `KEYPOINT_REAL_ENABLED=true`
- `KEYPOINT_REAL_ENDPOINT=<HTTP URL of hunyuanVisionService>`
- `KEYPOINT_REAL_TIMEOUT_MS=20000`

Keep in `skateActionAnalyze`:

- `KEYPOINT_API_ENABLED=true`
- `KEYPOINT_API_FUNCTION=keypointInfer`

## Verify

After student analysis call:

- `inferenceMode=api_keypoint`
- `apiError` is empty

