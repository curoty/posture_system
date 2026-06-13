# Posture System — 花样滑冰动作识别与质量评分系统

基于 **9 节点穿戴式 IMU 传感器** 的实时动作捕捉与智能评估平台。通过深度学习模型（CNN-LSTM + LightGBM）对花滑动作进行分类和连续质量评分（0-100），并自动生成中文教练反馈建议。

> 🏗️ 微服务架构 · 消息队列解耦 · 实时 SSE 推送 · Docker 一键部署

---

## 核心功能

| 模块 | 功能 |
|------|------|
| 🎯 **动作分类** | 基于 CNN-BiLSTM-Attention 深度学习模型，识别花滑动作类型（当前支持 `weight_shift` 重心转移） |
| 📊 **质量评分** | LightGBM 回归模型输出 0-100 连续分，四级质量标签（优秀 ≥88 / 良好 ≥75 / 一般 ≥60 / 不合格） |
| 💬 **教练反馈** | 规则引擎自动生成中文建议，涵盖时长评估、完整度、相似度、改进方向；可选 LLM（GPT-4o-mini）增强 |
| 📡 **多模式数据接入** | 支持 **MQTT 实时传感器流**、**文件上传（CSV/JSONL）**、**JSON API** 三种输入方式 |
| 🔄 **实时推送** | SSE（Server-Sent Events）向 Web 前端实时推送推理结果、设备状态、警告事件 |
| 🛡️ **鲁棒性门控** | 三级门控（置信度 / Top1-Top2 边际 / 嵌入坍塌检测）+ 双重节点完整性校验 |

---

## 技术栈

### 后端服务（Java）

| 类别 | 技术 | 版本 |
|------|------|------|
| 语言 | Java | 17 |
| 框架 | Spring Boot | 4.0.5 |
| Web | Spring WebMVC + SSE | — |
| ORM | Spring Data JPA (Hibernate) | — |
| 数据库 | MySQL | 8.0 |
| 缓存/消息 | Redis (Lettuce) | 7.x |
| 消息协议 | MQTT (Eclipse Paho) | 1.2.5 |
| 工具 | Lombok, Jackson, Apache Commons Pool2 | — |
| 构建 | Maven | 3.8+ |
| 部署 | Docker (`eclipse-temurin:17-jre`) | — |

### ML 推理服务（Python）

| 类别 | 技术 | 版本 |
|------|------|------|
| 语言 | Python | 3.11 |
| 深度学习 | PyTorch | ≥2.0.0 |
| Web 框架 | FastAPI + Uvicorn | ≥0.100.0 |
| 梯度提升 | LightGBM | ≥4.0.0 |
| 科学计算 | NumPy, Pandas, SciPy | — |
| 机器学习 | scikit-learn | ≥1.0.0 |
| 部署 | Docker (`python:3.11-slim`) | — |

### 基础设施

| 类别 | 技术 |
|------|------|
| 容器编排 | Docker Compose 3.8 |
| 外部依赖 | MQTT Broker（ESP32 数据源） |
| 可选 AI | OpenAI 兼容 API (GPT-4o-mini) |

---

## 项目目录结构

```
posture-system/
├── README.md                           # 本文件
├── .env.example                        # 环境变量模板
├── docker-compose.yml                  # 4 服务编排（mysql, redis, python-api, springboot）
│
├── backend-springboot/                 # Spring Boot 后端服务
│   ├── pom.xml                         # Maven 依赖配置
│   ├── Dockerfile                      # JRE 17 镜像
│   ├── simulate_sensor.py              # 传感器模拟脚本
│   ├── sniff_mqtt.py                   # MQTT 抓包调试脚本
│   ├── test_mqtt.py                    # MQTT 连通性测试
│   ├── test_frames.txt                 # 测试帧数据
│   └── src/main/java/com/example/posture/
│       ├── BackendSpringbootApplication.java  # 启动类
│       ├── config/                     # Bean 配置（MQTT, Redis, RestTemplate, CORS）
│       ├── constant/                   # 枚举常量（状态/质量等级/传感器映射）
│       ├── controller/                 # REST 控制器（设备/推理/健康/实时流）
│       ├── dto/                        # 数据传输对象（20 个 DTO）
│       ├── entity/                     # JPA 实体（会话/任务/结果/数据文件）
│       ├── repository/                 # Spring Data JPA 仓库
│       └── service/                    # 核心业务逻辑
│           ├── DeviceSessionService.java      # 会话生命周期 + 帧缓冲 + 滑窗推理触发
│           ├── InferenceStreamProducer.java   # Redis Stream 生产者
│           ├── InferenceStreamConsumer.java   # Redis Stream 消费者（守护线程）
│           ├── InferenceService.java          # 推理任务编排
│           ├── ModelClientService.java        # HTTP 客户端（调用 Python API）
│           ├── AiCoachService.java            # LLM 教练增强（可选）
│           ├── MqttSubscriberService.java     # MQTT 订阅 + 自动重连
│           ├── RawDataParserService.java      # ESP32 原始文本解析
│           ├── RealtimeStreamService.java     # SSE 广播
│           └── SessionStateStore.java         # Redis 帧缓冲 + 会话状态
│
└── skating-deep-cnn-lstm-bayes/        # Python 深度学习 & 质量评分服务
    ├── Dockerfile                      # Python 3.11-slim 镜像
    ├── requirements.txt                # Python 依赖
    ├── src/
    │   ├── api.py                      # FastAPI 服务（/health, /predict-json, /predict-by-path, /feedback, /metrics）
    │   ├── model.py                    # CNN-LSTM-Attention 动作分类模型
    │   │                               #   架构：1D-CNN(3层) → BiLSTM → AdditiveSelfAttention → FC
    │   ├── predict.py                  # 推理入口（全流水线）
    │   ├── train_action.py             # 动作模型训练
    │   ├── train_lgb_quality.py        # LightGBM 质量回归器训练（v2 主路径）
    │   ├── train_bayes_quality.py      # 高斯朴素贝叶斯质量模型训练（v1 回退路径）
    │   ├── jsonl_sequence_dataset.py   # JSONL → 张量转换（重采样/NaN填充/归一化）
    │   ├── quality_labels.py           # 质量分/等级定义（4 级阈值/连续分转换/校准）
    │   ├── similarity_scoring.py       # 参考动作相似度评分
    │   ├── build_reference_library.py  # 构建标准动作参考库
    │   └── coach_feedback.py           # 规则教练反馈引擎
    ├── tools/                          # 辅助脚本（数据清洗/增强/消融/可视化等 18 个工具）
    ├── tests/
    │   └── test_coach_feedback.py      # 教练反馈单元测试（8 个用例）
    └── experiments/                    # 模型权重与实验产物
        ├── weight_shift_v2/            # 当前动作模型（2026-06-08 重训）
        ├── lgb_quality_v3/             # 当前 LightGBM 质量模型
        ├── bayes_quality_v1/           # Legacy GaussianNB（回退用）
        └── reference_library/          # 标准动作参考库
```

---

## 架构与数据流

```
ESP32 传感器 → MQTT → Spring Boot (数据接入/会话管理/任务编排)
                         ↕ Redis Stream (生产者-消费者解耦)
                         → HTTP → Python FastAPI (模型推理)
                         → SSE → Web 前端 (实时推送)
                    MySQL (持久化存储)
```

### 推理流水线

```
原始 IMU 数据 (9 节点 × 6 通道 = 54 维)
  → 节点映射 + NaN 插值 + 重采样至 180 帧
  → Z-Score 归一化
  → CNN-LSTM-Attention 动作分类
  → 三级鲁棒性门控 (置信度 ≥ 0.65, Top1-Top2 边际 ≥ 0.15, 嵌入标准差 ≥ 0.05)
  → LightGBM 质量回归 (287 维特征) → Z-Score 校准 → 0-100 连续分
  → 参考库相似度评分 (嵌入 + 时序 + 时长 + 完整度加权)
  → 规则教练反馈引擎 → 中文建议
```

### 双重防线：节点完整性校验

| 防线 | 位置 | 逻辑 |
|------|------|------|
| **主防线** | Java `DeviceSessionService.checkNodeCompleteness()` | 子窗口帧映射后检查 9 节点完整性比例，低于阈值跳推理 + SSE 警告 |
| **兜底防线** | Python `predict.py:_check_node_completeness()` | 原始帧 payload 非零节点数检查 |

---

## 快速开始

### 前置依赖

| 依赖 | 本地开发 | Docker |
|------|----------|--------|
| JDK 17 + Maven 3.8+ | ✅ 必需 | — |
| Python 3.11 + pip | ✅ 必需 | — |
| MySQL 8.0+ | ✅ 必需 | 🐳 容器内 |
| Redis 7.0+ | ✅ 必需 | 🐳 容器内 |
| MQTT Broker | ⚠️ 可选（实时传感器路径） | 外部服务 |
| Docker + Docker Compose | — | ✅ 必需 |

### 方式一：Docker Compose（推荐）

```bash
# 1. 克隆项目
cd posture-system

# 2. 配置环境变量
cp .env.example .env

# 3. 编译 Spring Boot JAR
cd backend-springboot
./mvnw clean package -DskipTests
cd ..

# 4. 一键启动全部服务（MySQL + Redis + Python API + Spring Boot）
docker compose up -d --build

# 5. 验证服务
curl http://127.0.0.1:5000/api/health    # Spring Boot → "Posture backend is running"
curl http://127.0.0.1:5001/health          # Python API → {"status":"healthy"}
```

### 方式二：本地分别启动

```bash
# 1. 启动 MySQL 并创建数据库
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS posture_system DEFAULT CHARACTER SET utf8mb4;"

# 2. 启动 Redis
redis-server

# 3. 启动 Python ML API
cd skating-deep-cnn-lstm-bayes
pip install -r requirements.txt
uvicorn src.api:app --host 0.0.0.0 --port 5001

# 4. 启动 Spring Boot（新终端）
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

### 端到端验证

```bash
# JSON 推理测试
curl -X POST http://127.0.0.1:5000/api/inference/json \
  -H "Content-Type: application/json" \
  -d '{
    "mac": "TEST",
    "sessionId": "test-001",
    "frames": [
      {"t": 0.0, "p": {"head": [0.1, 0.2, 0.3, 1, 2, 3]}}
    ]
  }'

# 查看推理历史
curl http://127.0.0.1:5000/api/inference/history?page=0&size=10

# SSE 实时流（在浏览器或另一个终端）
curl -N http://127.0.0.1:5000/api/realtime/stream

# Python API 健康检查
curl http://127.0.0.1:5001/health
```

---

## 环境变量参考

### 基础设施（`.env`）

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

### ML 推理参数（Python 环境变量）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEEP_ACTION_MODEL_PATH` | `experiments/weight_shift_v2/action_model.pt` | 动作模型路径 |
| `DEEP_LGB_QUALITY_MODEL_PATH` | `experiments/lgb_quality_v3/lgb_quality_model.pkl` | LightGBM 模型 |
| `DEEP_WINDOW_SECONDS` | `4.0` | 推理窗口 (秒) |
| `DEEP_STEP_SECONDS` | `2.0` | 推理步长 (秒) |
| `DEEP_CONFIDENCE_THRESHOLD` | `0.65` | 动作置信度阈值 |
| `DEEP_TOP_MARGIN_THRESHOLD` | `0.15` | Top1-Top2 边际阈值 |
| `DEEP_EMBEDDING_COLLAPSE_THRESHOLD` | `0.05` | 嵌入坍塌检测阈值 |
| `DEEP_MIN_NODE_COMPLETENESS_RATIO` | `0.7` | 节点完整性阈值 |

---

## 模型性能

当前模型（2026-06-08 重训，3,868 训练样本）：

| 指标 | 值 |
|------|-----|
| 训练数据 | 3,868 条（原始 2,538 + 增强 1,332） |
| Test MAE | **3.09** |
| Test RMSE | **4.61** |
| Test R² | **0.9694** |
| 等级准确率 | **84.5%** |
| 不合格召回率 | 93.0% |
| 良好召回率 | 81.4% |
| 优秀召回率 | 81.6% |

> 高质量样本（优秀等级）占比较少，是当前等级准确率的主要瓶颈。

---

## 关键架构决策

- **单会话模式**：全局仅允许一个 `COLLECTING` 会话，适配单人训练场景
- **软控制**：设备的 start/stop 通过云端 API 下发，而非直接 MQTT 控制
- **消息解耦**：Redis Stream 作为推理缓冲队列，Consumer 在独立守护线程消费
- **CORS 全开**：`WebConfig.java` 允许所有来源，适配开发环境
- **传感器节点映射**：Java `SensorNodeMapping` 和 Python `JSONL_TO_MODEL_NODE_MAPPING` 必须保持同步
- **推理参数双端配置**：窗口/步长在 Java `application.properties` 和 Python 环境变量中均需配置

---

## 未来规划 / 待办事项

### 🔴 高优先级

- [ ] **认证与鉴权**：所有 API 端点无任何认证机制，生产环境需添加 JWT 或 API Key
- [ ] **测试覆盖**：当前仅 1 个空 Java 测试 + 1 个 Python 测试文件（8 用例），需补充端到端和单元测试
- [ ] **修复 `pom.xml`**：`spring-boot-starter-parent:4.0.5` 和 `spring-boot-starter-webmvc` 可能无法从 Maven Central 解析

### 🟡 中优先级

- [ ] **API 速率限制**：防止滥用
- [ ] **多用户并发**：`DeviceSessionService` 全局锁限制为单会话
- [ ] **消息去重/幂等**：Redis Stream Consumer 崩溃重启后可能重复处理
- [ ] **数据库版本迁移**：用 Flyway/Liquibase 替代 `ddl-auto=update`
- [ ] **MQTT 密码外部化**：改用 Vault / k8s Secret 管理
- [ ] **`.dockerignore`**：Python 构建上下文包含 ~1 GB 训练数据，严重拖慢构建
- [ ] **Python 环境变量暴露至 Docker Compose**：12 个 `DEEP_*` 变量当前无法在 Docker 中配置

### 🟢 低优先级

- [ ] **多动作支持**：当前仅支持 `weight_shift`，需扩展至更多花滑动作类型
- [ ] **LLM 教练增强**：`AiCoachService` 已预留接口，需配置 OpenAI 兼容 API 即可启用
- [ ] **Docker 资源限制**：为 PyTorch 容器设置 `mem_limit` / `cpus`
- [ ] **Uvicorn 多 worker**：提升 ML 推理并发能力
- [ ] **弱密码替换**：`DB_PASSWORD` 默认 `123456`，`.env.example` 含弱凭证
- [ ] **协议健壮性**：`RawDataParserService` 依赖硬编码 `MAC:|1A:|...` 格式

---

## 许可证

内部项目，暂未设定开源许可证。
