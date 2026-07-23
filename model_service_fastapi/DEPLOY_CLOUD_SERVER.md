# 传感器模型云部署（代码已整合到 skating-deep-cnn-lstm-bayes）

## 1. 上传目录到云服务器

```bash
scp -r skating-deep-cnn-lstm-bayes root@<服务器IP>:/opt/skating-rf/
```

最终目录：

```text
/opt/skating-rf/skating-deep-cnn-lstm-bayes
```

## 2. 服务器安装依赖并启动
在 Linux 服务器执行：

```bash
cd /opt/skating-rf/skating-deep-cnn-lstm-bayes
chmod +x run_prod.sh
cp .env.example .env
./run_prod.sh
```

`.env` 至少确认：

```text
DEEP_INFERENCE_ENABLED=true
DEEP_MODEL_ROOT=/opt/skating-rf/skating-deep-cnn-lstm-bayes
DEEP_ACTION_MODEL_PATH=/opt/skating-rf/skating-deep-cnn-lstm-bayes/experiments/weight_shift_v2/action_model.pt
DEEP_LGB_QUALITY_MODEL_PATH=/opt/skating-rf/skating-deep-cnn-lstm-bayes/experiments/lgb_quality_v3/lgb_quality_model.pkl
DEEP_CONFIDENCE_THRESHOLD=0.65
DEEP_TOP_MARGIN_THRESHOLD=0.15
DEEP_EMBEDDING_COLLAPSE_THRESHOLD=0.05
DEEP_MIN_NODE_COMPLETENESS_RATIO=0.7
MQTT_BROKER=82.156.18.205
MQTT_PORT=1883
```

默认监听 `18080` 端口。

## 3. 健康检查
新开终端执行：

```bash
curl http://127.0.0.1:18080/health
```

预期：`"success": true`、`"primary_model": "cnn_lstm_lightgbm"`、
`"deep_model_ready": true`。

## 4. 验证云函数兼容接口

```bash
curl -X POST http://127.0.0.1:18080/infer \
  -H "Content-Type: application/json" \
  -d '{
    "scene":"sensor_session_analysis_v1",
    "version":"v1",
    "input":{
      "sessionId":"debug_001",
      "frames":[
        {
          "t":0.0,
          "points":{
            "head":{"ax":0.1,"ay":0.2,"az":9.7,"gx":0.1,"gy":0.1,"gz":0.1},
            "left_elbow":{"ax":0.1,"ay":0.2,"az":9.7,"gx":0.1,"gy":0.1,"gz":0.1},
            "right_elbow":{"ax":0.1,"ay":0.2,"az":9.7,"gx":0.1,"gy":0.1,"gz":0.1},
            "left_wrist":{"ax":0.1,"ay":0.2,"az":9.7,"gx":0.1,"gy":0.1,"gz":0.1},
            "right_wrist":{"ax":0.1,"ay":0.2,"az":9.7,"gx":0.1,"gy":0.1,"gz":0.1},
            "left_knee":{"ax":0.1,"ay":0.2,"az":9.7,"gx":0.1,"gy":0.1,"gz":0.1},
            "right_knee":{"ax":0.1,"ay":0.2,"az":9.7,"gx":0.1,"gy":0.1,"gz":0.1},
            "left_foot":{"ax":0.1,"ay":0.2,"az":9.7,"gx":0.1,"gy":0.1,"gz":0.1},
            "right_foot":{"ax":0.1,"ay":0.2,"az":9.7,"gx":0.1,"gy":0.1,"gz":0.1}
          }
        }
      ]
    }
  }'
```

预期响应里有：
- `success: true`
- `analysis.overallScore`
- `analysis.metrics`
- `analysis.sensorSession`

## 5. 小程序云函数参数（关键）
在微信云开发控制台给 `skateActionAnalyze` 设置环境变量：

```text
SENSOR_API_ENABLED=true
SENSOR_API_URL=https://<你的域名或公网IP>/infer
SENSOR_API_TIMEOUT_MS=20000
SENSOR_API_MODE=api_only
```

如果你服务端做了鉴权，再补：

```text
SENSOR_API_TOKEN=<你的token>
```

然后重新部署 `skateActionAnalyze` 云函数。

## 6. 推荐长期运行方式（systemd）
可选，把服务托管成 systemd：

```ini
[Unit]
Description=Skating RF Sensor API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/skating-rf/skating-deep-cnn-lstm-bayes
EnvironmentFile=/opt/skating-rf/skating-deep-cnn-lstm-bayes/.env
ExecStart=/opt/skating-rf/skating-deep-cnn-lstm-bayes/.venv/bin/uvicorn src.sensor_api:app --host 0.0.0.0 --port 18080 --workers 1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

保存到：`/etc/systemd/system/skating-rf.service`，然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable skating-rf
sudo systemctl start skating-rf
sudo systemctl status skating-rf
```

> **注意**：代码已从 `model_service_fastapi` 整合到 `skating-deep-cnn-lstm-bayes`。
> `model_service_fastapi` 保留旧版 RF 代码供参考，生产部署只需 `skating-deep-cnn-lstm-bayes`。
>
