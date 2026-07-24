# ML 算法重构方案：5 节点全链路落地（v3，基于 DeepSeek 改动后状态）

> 目标：让下肢 5 节点（waist + 2 knee + 2 ankle）数据完整跑通「采集 → 训练 → 实时推理 → 质量评分」全链路，
> 在 baseline（CNN-BiLSTM-Attention）与结构感知模型间做可对比消融。
> 时间约束：**7/28 比赛现场实时采集演示**。
> 本文档 v3 基于 DeepSeek commit `ffe270b` 后的代码现状撰写。

---

## 0. 当前进度速览

### 0.1 DeepSeek 已完成（commit ffe270b，方向正确）

| 模块 | 状态 | 说明 |
|---|---|---|
| `NodePreset` / `NODE_PRESETS` 体系 | ✅ 完成 | [jsonl_sequence_dataset.py:31-75](skating-deep-cnn-lstm-bayes/src/jsonl_sequence_dataset.py#L31) |
| `SequenceConfig` preset 驱动 + 向后兼容 | ✅ 完成 | `resolved_node_order` / `resolved_min_valid_nodes` property，旧 ckpt 默认 full_body_9 |
| `convert_record_to_sequence` 用 config 映射 | ✅ 完成 | [jsonl_sequence_dataset.py:321](skating-deep-cnn-lstm-bayes/src/jsonl_sequence_dataset.py#L321) |
| `SequenceConfig` 默认 350帧/50Hz | ✅ 完成 | `sequence_length=350, sample_rate_hz=50.0` |
| train_action / train_multiclass `--node-preset` CLI | ✅ 完成 | |
| train_lgb_quality 改用通用加载器 | ✅ 完成 | 支持 structured，`_extract_raw_sequence` 用 config 映射 |
| `_check_node_completeness` 支持 expected_nodes | ✅ 完成 | [predict.py:477](skating-deep-cnn-lstm-bayes/src/predict.py#L477) |
| `_check_input_stationary` 静止检测 | ✅ 完成 | [predict.py:329](skating-deep-cnn-lstm-bayes/src/predict.py#L329) |
| model.py | ✅ 无需改 | 已参数化 num_nodes |

### 0.2 必须修复的 Bug（5 个，阻断 5 节点链路）

> api.py 已融合到 sensor_api.py，api.py 废弃，不再列入。train_ssl.py 暂时用不到，相关项移除。

| # | 严重度 | 位置 | 问题 | 修复 |
|---|---|---|---|---|
| 1 | 🔴 5节点被拒 | [sensor_api.py:555](skating-deep-cnn-lstm-bayes/src/sensor_api.py#L555) | `/health` 硬编码 `"sensor_mode": "9node"` | 从 `inference_service["checkpoint"]["sequence_config"]["node_preset_name"]` 动态读 |
| 2 | 🔴 5节点被拒 | [sensor_api.py:292](skating-deep-cnn-lstm-bayes/src/sensor_api.py#L292)、[sensor_api.py:785](skating-deep-cnn-lstm-bayes/src/sensor_api.py#L785) | `_check_nine_node_completeness(frames)` 未传 preset_name，默认 full_body_9 | 从 `inference_service["checkpoint"]` 读 `node_preset_name` 传入 |
| 3 | 🔴 质量特征失效 | [predict.py:821](skating-deep-cnn-lstm-bayes/src/predict.py#L821) | `config.node_order`（空 tuple）→ node_to_index 空 → raw 全 NaN | 改为 `config.resolved_node_order` |
| 4 | 🔴 5节点映射失败 | [predict.py:832](skating-deep-cnn-lstm-bayes/src/predict.py#L832) | 用模块级 `JSONL_TO_MODEL_NODE_MAPPING`（full_body_9），waist 键缺失 | 改为 `config.jsonl_to_model_node_mapping` |
| 5 | 🔴 stationary 失效 | [predict.py:454](skating-deep-cnn-lstm-bayes/src/predict.py#L454) | `node_order = sequence_config.node_order`（空）→ reshape(1,0,-1) 出错 | 改为 `sequence_config.resolved_node_order` |

### 0.3 待标签确定后再处理的设计问题

**stationary（信号层）与 idle/standing（标签层）逻辑分离**：
- 训练标签（动作类别）尚未确定，先不纠结 idle/standing 命名
- 但原则需确立：信号层 stationary 检测仅作 metadata 标记，**不应直接跳过质量评分**；标签层的"空闲类"才跳过质量评分
- 当前 [predict.py:541-546](skating-deep-cnn-lstm-bayes/src/predict.py#L541) 把两层混在一起，标签确定后需重写

---

## 1. 核心矛盾诊断（已由 DeepSeek 解决大半）

### 1.1 节点命名四层断层（原状）

| 层 | 节点命名 | 节点数 |
|---|---|---|
| 固件 v2.6.1/v2.7.21 | `waist`+`left_knee`+`right_knee`+`left_ankle`+`right_ankle` | 5（下肢） |
| 云函数 `skateActionAnalyze` | `normalizeRoleName` 把 `left_ankle→left_foot`；默认 expectedRoles 已是下肢 5 节点 | 5（下肢） |
| 小程序 SDK | `SENSOR_ROLES` 9 节点，不认 `waist`；`remote-predict.js:91` 强制 `activeRoles.length>=9` | 9（全身） |
| 模型加载器 | `JSONL_TO_MODEL_NODE_MAPPING` 9 键无 `waist`；`min_valid_nodes=6` | 9（全身） |

**DeepSeek 已解决模型层**（NodePreset 体系），**未解决小程序层**（实时采集演示必做）。

### 1.2 算法现状

- **分类**：baseline `CNNLSTMAttentionClassifier`（拍平 54/30 维）vs structured `StructuredActionClassifier`（per-node CNN → 跨节点 attention → BiLSTM）。两者已节点数参数化。
- **质量评分**：LightGBM 回归，特征工程扎实，全局 z-score 校准。
- **去噪/姿态**：Hampel + Mahony，节点数无关，无需改。

---

## 2. 总体设计（保持 DeepSeek 方案）

### 2.1 节点预设（DeepSeek 已实现，无需改）

| 预设名 | JSONL 键 | 模型内部节点名 | 节点数 | 用途 |
|---|---|---|---|---|
| `full_body_9` | head, left_elbow, right_elbow, left_wrist, right_wrist, left_knee, right_knee, left_foot, right_foot | head, l_elbow, l_knee, l_skate, l_wrist, r_elbow, r_knee, r_skate, r_wrist | 9 | 读旧 9 节点样本做对比实验 |
| `lower_body_5` | waist, left_knee, right_knee, left_foot, right_foot | waist, l_knee, r_knee, l_skate, r_skate | 5 | **比赛主用，匹配固件现状** |

> 5 节点模型内部名沿用 `l_skate/r_skate`（与现有 baseline 风格一致，代码改动最小）。

---

## 3. 阶段一：Bug 修复 + 数据采集 + 小程序链路（比赛 MVP）

### 3.1 Bug 修复（最高优先级，阻断一切）

按 §0.2 表格逐个修复。5 个 bug 全是 1-3 行改动，预计极快。

修复后验证清单：
- [ ] `/health` 端点返回 `sensor_mode` 反映已加载 checkpoint 的 preset（Bug 1）
- [ ] `/infer` 接收 5 节点帧不再被拒（Bug 2）
- [ ] 5 节点推理时质量特征 `acc_var_global` 等非 0（Bug 3、4）
- [ ] 5 节点 stationary 检测正常触发（Bug 5）

### 3.2 数据采集方案（核心，比赛前必须完成）

#### 3.2.1 采集规格

| 项 | 规格 |
|---|---|
| 节点 | 下肢 5 节点：waist + left_knee + right_knee + left_ankle + right_ankle |
| 采样率 | 50 fps（ESP32-S3 → MQTT） |
| 单段时长 | 7 秒 = 350 帧 |
| 单段结构 | 前置准备 0.5-1s → 目标动作 2-4 周期 5-6s → 后置静立 0.5s |
| 采集人员 | 至少 2 人（避免单人过拟合） |
| 场地 | 尽量真实滑冰场/轮滑场；平地模拟需标注 `surface_type: floor` |

#### 3.2.2 动作类别与采集量

**训练标签（动作类别）尚未确定**，待你确认后再细化。以下为通用原则：

- 建议至少 2 个目标动作类别 + 1 个空闲/准备类（避免实时演示时准备阶段误触发）
- 空闲类建议覆盖「静止站立」和「原地踏步」两种子状态
- 每个类别建议 15-20 段，底线每类 10 段
- 每段 350 帧（7 秒 / 50fps），含 2-4 个完整动作周期

#### 3.2.3 动作起止标注：按键标记法（推荐）

**肉眼回看标注不精准且成本高，正确做法是采集时按键实时标记。**

小程序采集页面加 3 个按钮：

```
┌─────────────────────────────────────┐
│  采集页面 (actionType 已选)          │
├─────────────────────────────────────┤
│  [● 开始采集]   帧号: 0/350          │
│                                     │
│  准备阶段                            │
│  ── 喊"开始"时按 ↓ ──               │
│  [▶ 标记动作开始]  → 记录 frame=25  │
│                                     │
│  做动作中（2-4 周期）                │
│  ── 喊"结束"时按 ↓ ──               │
│  [■ 标记动作结束]  → 记录 frame=320 │
│                                     │
│  后置静立 0.5 秒                    │
│  [⏹ 停止采集]                       │
└─────────────────────────────────────┘
```

**采集者操作流程**：
1. 穿好设备，站稳，选 `actionType`
2. 点「开始采集」
3. 静立 0.5-1 秒（前置准备自动录入）
4. 喊「开始」**同时**点「标记动作开始」
5. 连续做 2-4 个完整周期
6. 喊「结束」**同时**点「标记动作结束」
7. 静立 0.5 秒
8. 点「停止采集」，样本自动提交

**精度**：按键反应延迟 100-200ms（5-10 帧），对 7 秒样本完全可接受。比肉眼回看准 10 倍。

**提交 payload 增字段**：
```json
{
  "actionType": "<待确定>",
  "action_start_frame": 25,
  "action_end_frame": 320,
  "cycle_count": 3,
  "collector_id": "user_001",
  "surface_type": "ice",
  "skill_level": "intermediate"
}
```

训练时滑窗只在 `[action_start_frame, action_end_frame]` 区间内切。

#### 3.2.4 备选标注：口令法（零标注）

若小程序改动时间紧，用固定口令：
- 0.0s 喊「准备」→ 1.0s 喊「开始」→ 6.5s 喊「停」→ 7.0s 停止
- 训练时固定取第 25-325 帧为有效区间
- 误差 15-30 帧，要求采集纪律性强

### 3.3 小程序 + 云函数链路（实时演示必做）

| 文件 | 位置 | 改动 |
|---|---|---|
| `miniprogram_hers/utils/remote-predict.js` | `:91` | 移除 `activeRoles.length>=9` 硬校验，改为按 `sensorProfile` 要求节点数校验 |
| 同上 | `:22-28` | 移除 `legacy9WaistAsHeadDebug` 开关，直接支持 waist |
| `miniprogram_hers/utils/wearable-device-sdk.js` | `:1-11` | `SENSOR_ROLES` 改为下肢 5 节点（waist + 2 knee + 2 ankle） |
| 同上 | `:38-54` | `ROLE_ALIAS` 增加 `waist→waist`、`left_ankle→left_ankle` |
| `cloudfunctions/skateActionAnalyze/index.js` | `:3377` | 确认 expectedRoles 已是下肢 5 节点（DeepSeek 已确认） |
| 同上 | 落库逻辑 | metadata 新增字段（`action_start_frame` 等）原样存入 `train_samples_nofiltering` |
| 小程序采集页面 | - | 加 3 个标注按钮（§3.2.3）+ 帧号记录 |

### 3.4 训练数据流程（2 个集合）

```
5节点 ICM20602 → ESP32-S3 → MQTT → FastAPI /frames → 五节点时间对齐
→ 小程序训练数据采集页面 → skateActionAnalyze 云函数
→ train_samples_nofiltering（原始 IMU）
→ FastAPI /denoise/training-frames → train_samples_filtering（滤波后）
→ 导出 JSONL（带 action_start/end_frame）
→ train_action.py --node-preset lower_body_5 --sequence-length 350
→ train_multiclass.py --arch baseline|structured --node-preset lower_body_5
→ train_lgb_quality.py
```

**数据导出工具改动**（`tools/clean_database_export.py` / `build_multiclass_dataset.py`）：
- `REQUIRED_NODES` 从 `--node-preset` 派生，默认 `lower_body_5`
- 滑窗只在 `[action_start_frame, action_end_frame]` 区间切
- 完整帧判定用 preset 的 jsonl_keys

---

## 4. 阶段二：算法增强（时间允许，答辩亮点）

### 4.1 跨节点注意力加生物力学邻接先验

**动机**：5 节点 cross-node attention 只有 5 个 token，全连接注意力忽略身体结构。滑冰运动的节点耦合是有结构的——腰部是躯干中心，应与双侧膝/踝强耦合；同侧膝↔踝是连杆；左右对称节点在蹬冰/落冰时协同。

**改法**：在 `StructuredIMUEncoder.cross_node_attn` 上加可学习 attention bias（非硬 mask）：

```python
# lower_body_5 邻接先验 bias: [5, 5]
#   waist ↔ 所有节点: 强（中心枢纽）
#   同侧膝↔踝(l_knee↔l_skate, r_knee↔r_skate): 强（连杆）
#   左右对称膝↔膝、踝↔踝: 中（双侧协同）
#   其它: 弱
self.node_adj_bias = nn.Parameter(torch.zeros(num_nodes, num_nodes))
```

在 `cross_node_attn` 调用时把 bias 加到 attention scores 上。

**可消融因子**：开/关 `node_adj_bias` 做 A/B，证明先验是否真有增益。小数据下先验通常有帮助。

### 4.2 质量评分 per-action 校准（暂缓）

**现状**：`train_lgb_quality.py:780` 全局 z-score 校准。不同动作分值分布差异大，全局校准会把高分动作拉低、低分动作抬高。

**改法**：按 `predicted_action_id` 分组拟合校准参数。比赛前不做，质量模型已可用。

### 4.3 SSL 预训练（暂时用不到，留作未来工作）

`train_ssl.py` 暂不纳入比赛范围。未来若数据量不足需 SSL 增益时，再适配 `--node-preset` 与 structured backbone。

---

## 5. 比赛前 MVP 执行顺序

> 今天 7/24，距比赛 4 天。

### MVP（必做）
1. **§3.1 修复 5 个 Bug**（阻断一切，最高优先级）
2. **§3.3 小程序 + 云函数链路**（实时采集演示前提）
3. **§3.2 数据采集**（待标签确定后细化类别与量）
4. **§3.4 训练流水线**（导出 JSONL → train_action/train_multiclass → train_lgb_quality）
5. **跑出 baseline vs structured 在 5 节点上的对比**（accuracy / F1 / 混淆矩阵）

### 增强（时间允许）
6. **§4.1 邻接先验**（structured 专属增益，答辩亮点）

### 暂缓
7. §4.2 per-action 质量校准
8. §4.3 SSL 预训练

### 决策点
- 若 structured 不如 baseline → 做 §4.1 邻接先验
- 答辩材料：5 节点链路解耦 + baseline vs structured 对比 + （可选）邻接先验增益

---

## 6. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| 5 节点采集数据不足 | 模型训不稳 | 数据增强（加噪/时间扭曲/幅度缩放）；未来启用 SSL |
| 比赛前来不及改小程序 | 无法实时演示 | 降级为「录屏 + 离线推理」演示 |
| 邻接先验在小数据下过拟合 | structured 反而更差 | bias 初始化为 0 让网络自学，A/B 验证后再定 |
| stationary 检测误判 | 准备阶段被误判为动作 | 信号层 stationary 仅作 metadata；标签确定后分离两层逻辑 |
| 固件实际输出非 50fps | 采样率失配 | 采集前用 `/frames` 抽测实际帧率，必要时在 SequenceConfig 调整 |
| 旧 9 节点样本的 `waist` 可能叫 `head` | 数据加载错位 | NodePreset 加 `alias_map` 兜底（lower_body_5 接受 head 当 waist，带告警） |

---

## 7. 待确认决策点

1. **训练标签（动作类别）**：目标动作类别与空闲类命名待确定
2. **采集量**：待标签确定后按类别数细化
3. **标注法**：按键标记（推荐）还是口令法？
4. **小程序链路**：是否能腾出时间改，还是直接降级为离线演示？

---

*v3 基于 2026-07-24 commit `ffe270b` 后代码现状（api.py 已废弃、train_ssl.py 暂缓、训练标签待定）。评审通过后按 §5 顺序落地。*
