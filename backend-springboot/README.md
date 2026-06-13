# posture-backend

滑冰姿态评估后端服务，负责传感器数据接入、推理任务编排、结果持久化和实时推送。

## 依赖服务清单

| 服务 | 用途 | 默认地址 |
|---|---|---|
| MySQL | 推理任务、结果、设备会话持久化 | `localhost:3306` |
| Redis | 帧缓冲、Stream 消息队列、会话状态 | `localhost:6379` |
| Python ML API | 动作分类 + 质量评分 + 教练反馈 | `http://127.0.0.1:5001` |
| MQTT Broker | ESP32 传感器实时数据接入 | `tcp://82.156.18.205:1883` |

## 配置说明

以下为 `application.properties` 中需按环境修改的配置项：

```properties
# ---- 服务端口 ----
server.port=5000

# ---- MySQL ----
spring.datasource.url=jdbc:mysql://localhost:3306/posture_system?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&createDatabaseIfNotExist=true
spring.datasource.username=${DB_USERNAME:root}
spring.datasource.password=${DB_PASSWORD:123456}

# ---- Redis ----
spring.data.redis.host=${REDIS_HOST:localhost}
spring.data.redis.port=${REDIS_PORT:6379}
spring.data.redis.password=${REDIS_PASSWORD:}

# ---- Python ML API ----
app.model-api.base-url=http://127.0.0.1:5001

# ---- MQTT ----
app.mqtt.broker-url=tcp://82.156.18.205:1883
app.mqtt.client-id=posture-backend-001
app.mqtt.topic=esp32/sensor/+

# ---- 设备默认参数 ----
app.hardware.device-id=A0:F2:62:F4:B9:A0
app.hardware.inference.window-seconds=4.0
app.hardware.inference.step-seconds=2.0
app.hardware.timestamp-unit=s

# ---- 文件存储 ----
spring.servlet.multipart.max-file-size=400MB
app.upload.dir=uploads
app.raw-data.dir=raw-data

# ---- AI Coach (可选) ----
app.ai-coach.enabled=false
app.ai-coach.base-url=
app.ai-coach.api-key=
app.ai-coach.model=gpt-4o-mini
```

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `DB_USERNAME` | MySQL 用户名 | `root` |
| `DB_PASSWORD` | MySQL 密码 | `123456` |
| `REDIS_HOST` | Redis 地址 | `localhost` |
| `REDIS_PORT` | Redis 端口 | `6379` |
| `REDIS_PASSWORD` | Redis 密码 | 空 |
| `app.model-api.base-url` | Python API 地址 | `http://127.0.0.1:5001` |
| `app.mqtt.broker-url` | MQTT Broker 地址 | `tcp://82.156.18.205:1883` |
| `app.ai-coach.enabled` | 是否启用 GPT 教练增强 | `false` |

## 启动方式

### 方式一：本地 Maven 启动

**前置条件**：JDK 17、Maven 3.8+、MySQL 8.0+、Redis 7.0+

```bash
# 1. 创建数据库（首次）
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS posture_system DEFAULT CHARACTER SET utf8mb4;"

# 2. 编译打包
cd backend-springboot
./mvnw clean package -DskipTests

# 3. 启动
java -jar target/backend-springboot-0.0.1-SNAPSHOT.jar

# 或直接运行
./mvnw spring-boot:run
```

### 方式二：Docker Compose 完整环境（推荐）

同时启动 MySQL + Redis + Python API + Spring Boot。

```bash
# 1. 在父目录 posture-system 下，复制并填写环境变量
cp .env.example .env

# 2. 编译 Spring Boot（Docker 构建需要 jar 包）
cd backend-springboot
./mvnw clean package -DskipTests
cd ..

# 3. 启动全部服务
docker compose up -d --build

# 4. 验证
curl http://127.0.0.1:5000/api/health
curl http://127.0.0.1:5001/health
```

MySQL 数据由 Docker named volume 持久化，销毁容器不会丢失数据。

## 启动顺序

| 顺序 | 服务 | 验证方法 |
|---|---|---|
| 1 | MySQL | `mysql -u root -p -e "SELECT 1"` |
| 2 | Redis | `redis-cli PING` 返回 `PONG` |
| 3 | Python ML API | `curl http://127.0.0.1:5001/health` 返回 `{"success":true}` |
| 4 | Spring Boot | 启动后执行下方快速验证 |

MQTT Broker 为外部服务，非必需；若不可用，实时传感器路径不可用，但文件/JSON 推理路径不受影响。

## 快速验证

```bash
# 健康检查
curl http://127.0.0.1:5000/api/health
```

正常返回：

```json
{"code":200, "message":"success", "data":"Posture backend is running"}
```

端到端推理验证：

```bash
# 用本地 JSONL 文件测试（需 Python API 已启动）
curl -X POST http://127.0.0.1:5000/api/inference/json \
  -H "Content-Type: application/json" \
  -d '{"mac":"TEST","sessionId":"test-001","frames":[{"t":0,"p":{"head":[0.1,0.2,0.3,1,2,3]}}]}'
```
