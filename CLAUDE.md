# CLAUDE.md

## 项目概览

**项目名称：** Posture System（姿态系统）

**用途：** 花样滑冰动作识别与质量评分系统。通过穿戴式 9 节点 IMU 传感器（头、双肘、双腕、双膝、双足）实时采集运动数据，经深度学习模型（CNN-LSTM + LightGBM）进行动作分类和连续质量评分（0-100），并生成中文教练反馈建议。支持实时传感器流（MQTT）、文件上传（CSV/JSONL）和 JSON API 三种输入模式，通过 SSE 向 Web 前端实时推送结果。

**整体架构：** 微服务 + 消息队列模式

```
ESP32 传感器 → MQTT → Spring Boot (数据接入/会话管理/任务编排)
                         ↕ Redis Stream (生产者-消费者解耦)
                         → HTTP → Python FastAPI (模型推理)
                         → SSE → Web 前端 (实时推送)
                    MySQL (持久化存储)
```

---

## 技术栈

### 后端 (Java)
| 类别 | 技术 | 版本 |
|------|------|------|
| 语言 | Java | 17 |
| 框架 | Spring Boot | 4.0.5 |
| Web | Spring WebMVC + SSE | - |
| ORM | Spring Data JPA (Hibernate) | - |
| 数据库 | MySQL | 8.0 |
| 缓存/消息 | Redis (Lettuce) | 7.x |
| 消息协议 | MQTT (Eclipse Paho) | 1.2.5 |
| 工具 | Lombok, Jackson, Apache Commons Pool2 | - |
| 构建 | Maven | 3.8+ |
| 部署 | Docker (eclipse-temurin:17-jre) | - |

### ML 服务 (Python)
| 类别 | 技术 | 版本 |
|------|------|------|
| 语言 | Python | 3.11 |
| 深度学习 | PyTorch | ≥2.0.0 |
| Web 框架 | FastAPI + Uvicorn | ≥0.100.0 |
| 梯度提升 | LightGBM | ≥4.0.0 |
| 科学计算 | NumPy, Pandas, SciPy | - |
| 机器学习 | scikit-learn | ≥1.0.0 |
| 序列化 | joblib | ≥1.2.0 |
| 部署 | Docker (python:3.11-slim) | - |

### 基础设施
| 类别 | 技术 |
|------|------|
| 容器编排 | Docker Compose 3.8 |
| 外部依赖 | MQTT Broker (ESP32 数据源) |
| 可选 LLM | OpenAI 兼容 API (GPT-4o-mini) |

---

## 项目结构说明

```
posture-system/
├── CLAUDE.md                          # 本文件
├── .env.example                       # 环境变量模板
├── .gitignore                         # 仅忽略 .env
├── docker-compose.yml                 # 4 服务编排（mysql, redis, python-api, springboot）
│
├── backend-springboot/                # Spring Boot 后端服务
│   ├── pom.xml                        # Maven 依赖（Spring Boot 4.0.5, JPA, Redis, MQTT, Lombok）
│   ├── Dockerfile                     # JRE 17 镜像，暴露 5000
│   ├── README.md                      # 后端专属文档（配置说明、启动方式、验证步骤）
│   ├── simulate_sensor.py             # 传感器模拟脚本
│   ├── sniff_mqtt.py                  # MQTT 抓包调试脚本
│   ├── test_mqtt.py                   # MQTT 测试脚本
│   ├── test_frames.txt                # 测试帧数据
│   ├── uploads/                       # CSV 文件上传目录（运行时生成）
│   ├── raw-data/                      # JSON 推理原始数据备份（按日期分目录）
│   └── src/main/java/com/example/posture/
│       ├── BackendSpringbootApplication.java  # 启动类
│       ├── config/
│       │   ├── MqttConfig.java        # MQTT 连接配置（broker URL, client-id, 认证）
│       │   ├── RedisConfig.java       # Redis StringRedisTemplate + ObjectMapper Bean
│       │   ├── RestTemplateConfig.java # HTTP 客户端 Bean
│       │   └── WebConfig.java         # CORS 全局配置（允许所有来源）
│       ├── constant/
│       │   ├── CalibrationStatus.java  # 校准状态枚举（PENDING, READY）
│       │   ├── InputType.java         # 输入类型枚举（JSON, CSV, MQTT）
│       │   ├── QualityLevel.java      # 质量等级枚举（优秀≥88, 良好≥75, 一般≥60, 不合格）
│       │   ├── SensorNodeMapping.java # 硬件ID→语义名映射（1A→left_elbow, 3B→left_foot 等）
│       │   ├── SessionStatus.java     # 会话状态枚举（IDLE, COLLECTING）
│       │   └── TaskStatus.java        # 任务状态枚举（PENDING, PROCESSING, SUCCESS, FAILED）
│       ├── controller/
│       │   ├── DeviceController.java  # 设备管理 API（start/stop/data/heartbeat/status）
│       │   ├── GlobalExceptionHandler.java # 统一异常处理
│       │   ├── HealthController.java  # /api/health 健康检查
│       │   ├── InferenceController.java # 推理 API（upload/json/history/advice/tasks）
│       │   └── RealtimeController.java  # /api/realtime/stream SSE 订阅
│       ├── dto/                       # 20 个 DTO（Request/Response/PageResult/FrameDto 等）
│       ├── entity/
│       │   ├── DeviceSession.java     # 采集会话（sessionId, deviceId, status, frameCount）
│       │   ├── InferenceTask.java     # 推理任务（taskNo, sessionId, inputType, status）
│       │   ├── InferenceResult.java   # 推理结果（sampleIndex, actionLabel, qualityScore, coachingAdvice）
│       │   └── RawDataFile.java       # 原始数据文件引用
│       ├── repository/                # 4 个 JPA Repository
│       └── service/
│           ├── AiCoachService.java    # 可选 LLM 教练增强（OpenAI 兼容 API + 规则回退）
│           ├── DeviceSessionService.java # 核心：会话生命周期、帧缓冲、滑窗推理触发
│           ├── InferenceService.java  # 推理编排（上传→调模型→存结果→富化建议）
│           ├── InferenceStreamConsumer.java # Redis Stream 消费者（独立 daemon 线程）
│           ├── InferenceStreamProducer.java # Redis Stream 生产者
│           ├── ModelClientService.java # HTTP 客户端（调用 Python /predict-json, /predict-by-path）
│           ├── MqttSubscriberService.java  # MQTT 订阅（启动时连接，自动重连）
│           ├── RawDataParserService.java   # ESP32 原始文本解析（MAC:|1A:|... 格式）
│           ├── RealtimeStreamService.java  # SSE 广播（连接/设备状态/数据/推理结果）
│           └── SessionStateStore.java      # Redis 帧缓冲 + 活跃会话 + 上次推理时间（TTL 2h）
│
└── skating-deep-cnn-lstm-bayes/       # Python 深度学习 & 质量评分服务
    ├── Dockerfile                     # Python 3.11-slim，uvicorn 启动 api:app，暴露 5001
    ├── requirements.txt               # torch, numpy, pandas, sklearn, fastapi, lightgbm 等
    ├── README.md                      # 模型训练/推理/参考库构建完整文档
    ├── deploy_package/                # 独立部署包（requirements.txt + README）
    ├── experiments/                   # 实验结果（消融研究、混淆矩阵、预测输出等）
    ├── experiments/weight_shift_v2/   # 当前动作模型权重（2026-06-08 重训）
    ├── src/
    │   ├── __init__.py                # 包说明
    │   ├── api.py                     # FastAPI 服务（/health, /predict-json, /predict-by-path, /feedback, /metrics）
    │   ├── model.py                   # CNN-LSTM-Attention 动作分类模型定义
    │   │                              #   架构：1D-CNN(3层) → BiLSTM → AdditiveSelfAttention → FC
    │   │                              #   输入：[B, 180, 54] (或 72 含导出通道)
    │   ├── predict.py                 # 推理入口（predict_record, predict_jsonl_file, CLI）
    │   │                              #   流水线：动作分类 → 鲁棒性门控 → LightGBM/GaussianNB 质量评分
    │   ├── train_action.py            # 动作模型训练（train/val/test 分割、early stopping、类别加权）
    │   ├── train_lgb_quality.py       # LightGBM 质量回归器训练（特征工程、校准、坍塌检测）
    │   ├── train_bayes_quality.py     # 高斯朴素贝叶斯质量模型训练（Legacy v1）
    │   ├── jsonl_sequence_dataset.py  # JSONL→张量转换、重采样、NaN填充、归一化、PyTorch Dataset
    │   ├── quality_labels.py          # 质量分/等级定义（4级阈值、连续分转换、校准、平滑）
    │   ├── similarity_scoring.py      # 参考动作相似度评分（嵌入+时序+时长+完整性加权）
    │   ├── build_reference_library.py # 构建标准动作参考库（嵌入+序列存储为 .npz）
    │   └── coach_feedback.py          # 规则教练反馈引擎（10档连续分→中文建议，含时长/完整性评估）
    ├── tools/                         # 辅助脚本
    │   ├── clean_real_data.py         # 真实数据清洗
    │   ├── deployment_simulation.py   # 部署模拟
    │   ├── draw_model_architecture.py # 模型架构图绘制
    │   └── evaluate_synthetic_data.py # 合成数据评估
    └── tests/
        └── test_coach_feedback.py     # 教练反馈单元测试
```

---

## 本地开发环境

### 前置依赖
- JDK 17 + Maven 3.8+
- Python 3.11 + pip
- MySQL 8.0+（或 Docker）
- Redis 7.0+（或 Docker）
- (可选) MQTT Broker — 仅实时传感器路径需要

### 环境变量

复制 `.env.example` 为 `.env`：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MYSQL_DATABASE` | `posture_system` | 数据库名 |
| `MYSQL_USER` | `posture` | 数据库用户 |
| `MYSQL_PASSWORD` | `posture123` | 数据库密码 |
| `MYSQL_ROOT_PASSWORD` | `root123` | 数据库 root 密码 |
| `MYSQL_PORT` | `3306` | MySQL 端口 |
| `REDIS_PORT` | `6379` | Redis 端口 |
| `REDIS_PASSWORD` | 空 | Redis 密码 |
| `PYTHON_API_PORT` | `5001` | Python API 端口 |
| `SPRINGBOOT_PORT` | `5000` | Spring Boot 端口 |

Python API 还支持以下环境变量（在 `api.py` 中读取）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEEP_ACTION_MODEL_PATH` | `experiments/weight_shift_v2/action_model.pt` | 动作模型路径 |
| `DEEP_LGB_QUALITY_MODEL_PATH` | `experiments/lgb_quality_v3/lgb_quality_model.pkl` | LightGBM 模型 |
| `DEEP_QUALITY_MODEL_PATH` | `experiments/bayes_quality_v1/bayes_quality_global.pkl` | Legacy GaussianNB |
| `DEEP_WINDOW_SECONDS` | `4.0` | 推理窗口 |
| `DEEP_STEP_SECONDS` | `2.0` | 推理步长 |
| `DEEP_CONFIDENCE_THRESHOLD` | `0.65` | 动作置信度阈值 |
| `DEEP_TOP_MARGIN_THRESHOLD` | `0.15` | Top1-Top2 边际阈值 |
| `DEEP_EMBEDDING_COLLAPSE_THRESHOLD` | `0.05` | 嵌入坍塌检测阈值 |
| `DEEP_MIN_NODE_COMPLETENESS_RATIO` | `0.7` | 节点完整性阈值（兜底防线） |

Java 端额外配置（`application.properties`）：

| 配置项 | 默认值 | 说明 |
|------|--------|------|
| `app.hardware.inference.min-node-completeness-ratio` | `0.7` | 推理窗口内完整帧的最低比例（主防线） |

### 启动方式

**方式一：Docker Compose（推荐，一键启动全部服务）**

```bash
cd posture-system
cp .env.example .env
cd backend-springboot && ./mvnw clean package -DskipTests && cd ..
docker compose up -d --build

# 验证
curl http://127.0.0.1:5000/api/health    # Spring Boot
curl http://127.0.0.1:5001/health         # Python API
```

**方式二：分别启动**

```bash
# 1. MySQL
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS posture_system DEFAULT CHARACTER SET utf8mb4;"

# 2. Redis
redis-server

# 3. Python API
cd skating-deep-cnn-lstm-bayes
pip install -r requirements.txt
uvicorn src.api:app --host 0.0.0.0 --port 5001

# 4. Spring Boot
cd backend-springboot
./mvnw spring-boot:run
```

### 服务端口

| 服务 | 端口 | 健康检查 |
|------|------|----------|
| Spring Boot | 5000 | `GET /api/health` |
| Python API | 5001 | `GET /health` |
| MySQL | 3306 | TCP |
| Redis | 6379 | `PING` |

---

## 重要约定

### 传感器数据
- **9 节点 6 通道 IMU**：每帧含 9 个传感器节点，每个节点 6 个值（ax, ay, az, gx, gy, gz），共 54 维
- 节点命名：`head`, `left_elbow`, `left_wrist`, `right_elbow`, `right_wrist`, `left_knee`, `left_foot`, `right_knee`, `right_foot`（API 语义名）
- 内部模型使用：`head`, `l_elbow`, `l_wrist`, `r_elbow`, `r_wrist`, `l_knee`, `l_skate`, `r_knee`, `r_skate`（基线顺序）
- 映射在 `JSONL_TO_MODEL_NODE_MAPPING`（Python）和 `SensorNodeMapping.MAPPING`（Java）中维护，**两处必须保持同步**
- 时间戳自适应：`api.py:370` 将 >100 的值视为毫秒并转换为秒

### 推理参数
- **窗口/步长**：Java (`application.properties`) 和 Python (`DEEP_WINDOW_SECONDS` / `DEEP_STEP_SECONDS` 环境变量) **两端均配置**，需保持一致
- 默认值：窗口 4.0s，步长 2.0s
- 帧缓冲修剪：保留最近 `max(inferenceWindowSeconds*2, windowSeconds+stepSeconds)` 的数据
- 最小窗口帧数 ≥ 2，否则跳过推理

### 质量评分
- **主路径 (v2)**：LightGBM 回归 → 连续分 0-100
- **回退路径 (v1)**：GaussianNB 分类 → 加权连续分
- 三级鲁棒性门控（全通过才执行质量评分）：
  1. `confidence ≥ 0.65`
  2. `top1_prob - top2_prob ≥ 0.15`
  3. embedding std ≥ 0.05（防坍塌）
- 质量等级阈值（Java 和 Python 已统一）：
  - 优秀 ≥ 88
  - 良好 ≥ 75
  - 一般 ≥ 60
  - 不合格 < 60

### 架构决策
- **单会话模式**：`DeviceSessionService` 全局仅允许一个 COLLECTING 会话，适合单用户训练场景
- **软控制**：start/stop 通过云端 API 下发，非直接 MQTT 控制设备
- **消息解耦**：Redis Stream 作为推理缓冲队列，Consumer 在独立 daemon 线程消费
- **模型路径**：Python API 通过环境变量指定模型文件，默认指向 `experiments/weight_shift_v2/` (动作) 和 `experiments/lgb_quality_v3/` (质量)
- **CORS 全开**：`WebConfig.java` 允许所有来源，适合开发环境

### 节点完整性校验（2026-06-08 新增）
- **双重防线设计：**
  1. Java 主防线：`DeviceSessionService.checkNodeCompleteness()` — 在 `buildInferenceRequests()` 中，子窗口帧经 `mapFrameForModel` 映射后检查是否包含全部 9 个 `REQUIRED_NODES`，统计完整帧比例
  2. Python 兜底防线：`predict.py:_check_node_completeness()` — 在 `predict_record()` 入口处检查原始帧 payload 中非零节点数
- **阈值配置：** Java `app.hardware.inference.min-node-completeness-ratio` / Python `DEEP_MIN_NODE_COMPLETENESS_RATIO`，默认均为 0.7
- **失败行为：** 低于阈值时 Java 侧通过 SSE `inference-warning` 事件推送警告（含 `type: "NODE_INCOMPLETE"`、completenessRatio、requiredNodes 等字段），Python 侧返回 `{"success": false, "reason": "node_incomplete: ..."}`
- **抑制重复警告：** Java 侧跳过后仍更新 `lastInferenceEnd`，避免同一窗口反复触发

### 代码风格
- Java：Lombok 注解（`@Getter/@Setter`），构造器注入（无 `@Autowired`），`var` 关键字
- Python：`from __future__ import annotations`，类型注解，dataclass 配置，NumPy 风格文档字符串

---

## 已知问题 / TODO

### 高优先级
1. **缺少认证/鉴权**：所有 API 端点无任何认证机制，生产环境需添加 JWT 或 API Key

### 中优先级
3. **缺少 API 速率限制**：无防滥用措施
4. **单会话限制**：`DeviceSessionService` 全局锁限制多用户并发
5. **Consumer 无消息去重/幂等**：Redis Stream 消费崩溃重启后可能重复处理
6. **无数据库迁移**：仅 `ddl-auto=update`，缺 Flyway/Liquibase 版本化
7. **MQTT 密码明文配置**：建议改用外部密钥管理（Vault/k8s Secret）
8. **`RawDataParserService` 协议脆弱**：依赖 `MAC:|1A:|...` 固定格式，节点 ID 硬编码

### 低优先级
9. **测试覆盖率低**：仅 1 个 Spring Boot 测试桩 + 1 个 Python 单元测试文件
10. **.env.example 含默认凭证**：生产部署需替换
11. **application.properties 中 `DB_PASSWORD` 默认 `123456`**：弱密码
12. **实验产物未 git 忽略**：`cleaned_*.jsonl`、`*.npz` 等产物未在 `.gitignore` 中（部分已在项目清理中删除）

### 已修复
- ✅ **质量等级阈值不一致**：Java `QualityLevel.java` 优秀阈值 90→88
- ✅ **MQTT 异常静默吞噬**：`MqttSubscriberService.java` 三处 catch 全部替换为 WARN 日志
- ✅ **节点完整性校验**：`DeviceSessionService` + `predict.py` 双重守卫
- ✅ **模型目录命名不规范**：旧目录 `experimentsweight_shift_v1` 已删除，新模型位于 `experiments/weight_shift_v2/`

---

## 变更日志

### 2026-06-08 — Session 总结：6 项高优缺陷修复 + 数据管道 + 模型重训练

**1. 项目清理（释放约 1.48 GB）**
- 删除构建残留和运行时数据：`target/`、`uploads/` (924 MB)、`raw-data/`、`__pycache__/`×3、`.pytest_cache/`
- 删除废弃文件：`HELP.md`、`experimentsreference_library/`、`deploy_package.zip`、`deploy_package/`
- 删除旧模型权重：`experimentsweight_shift_v1/`、`lgb_quality_v1/`、`lgb_quality_v2/`、`small_test_*`、`reference_library_v2/`、`reference_library_v3/`
- 删除实验中间产物：`cleaned_180.jsonl` (135 MB)、`cleaned_training_set.jsonl` (215 MB)、`error_set_score_zero.jsonl` (42 MB)、ablation/predictions 等旧产物
- 新增：`simulate_sensor.py` 支持 `--head-only` 参数

**2. 修复：节点完整性校验（高优 #5）**
- Java 主防线：`DeviceSessionService.checkNodeCompleteness()` — 前 N 帧投票，低于阈值跳过推理 + SSE `inference-warning`
- Python 兜底防线：`predict.py:_check_node_completeness()` — payload 非零节点数检查
- 新增配置：`app.hardware.inference.min-node-completeness-ratio` / `DEEP_MIN_NODE_COMPLETENESS_RATIO`（默认 0.7）
- API：`/predict-json` 校验失败返回 422（原 400）
- 涉及文件：`DeviceSessionService.java`、`SensorNodeMapping.java`、`application.properties`、`predict.py`、`api.py`

**3. 修复：质量等级阈值统一（高优 #1）** — `QualityLevel.java` 优秀阈值 90→88，与 Python 侧一致

**4. 修复：MQTT 异常处理（高优 #3）** — `MqttSubscriberService.java` 三处 `catch (Exception ignored)` → WARN 日志

**5. 数据管道建设**
- `tools/clean_database_export.py`：6 条清洗规则（重命名 sensor_session、统一 qualityTag、前 10 帧投票丢弃不完整记录、归档 side_push_recover），2,840→2,538 条
- `tools/augment_data.py`：4 种增强方法（噪声/裁剪/缩放/镜像），随机组合 2-4 种，均衡四个等级到 967 条，2,538→3,868 条
- 数据划分：按原始 `_id` 分组 80/10/10（Train 3,047 / Val 430 / Test 393），同 _id 的增强变体必须在同一分组
- `.claude/commands/clean-data.md`：完整的数据管道操作文档

**6. 模型重训练**
- 动作模型：`experiments/weight_shift_v2/action_model.pt`（单类 weight_shift，3,047 训练样本）
- 质量模型：`experiments/lgb_quality_v3/lgb_quality_model.pkl`（LightGBM v3，287 维特征）

| 指标 | 旧模型 | 新模型 |
|------|--------|--------|
| 训练数据 | ~222 条 | **3,868 条** |
| Test MAE | — | **3.09** |
| Test RMSE | — | **4.61** |
| Test R² | — | **0.9694** |
| 等级准确率 | — | **84.5%** |
| 不合格 / 良好 / 优秀 | — / — / — | 93.0% / 81.4% / 81.6% |

- `api.py` 默认路径已更新为 v2/v3；旧权重已清理

### 2026-06-08 — 项目文档工程初始化
- 新增 `CLAUDE.md`（完整项目文档）、`.claude/commands/log.md`、`.claude/commands/clean-data.md`
- 全面分析代码库，识别 14 项已知问题（本次修复 4 项：#1 阈值、#2 模型目录、#3 MQTT、#5 节点完整性）
- 记录架构决策和重要约定

### 2026-06-08 — 项目初始状态记录
- 滑冰姿态识别与质量评分系统，Spring Boot + Python FastAPI，CNN-LSTM + LightGBM 双模推理
- 当前模型：`experiments/weight_shift_v2/` + `experiments/lgb_quality_v3/`
- 训练数据：3,868 条（原始 2,538 + 增强 1,332），全部 weight_shift
- AI Coach LLM 增强可选，Docker Compose 一键部署

---

## 会话开始指令

> 每次新 session 开始时，AI 助手应主动：
> 1. 阅读本文件的 **变更日志** 章节，了解最新变动
> 2. 阅读 **已知问题 / TODO** 章节，了解待处理事项
> 3. 简要告知用户最近一次变更日志条目和当前高优先级 TODO 数量
