# ML 算法重构方案：5 节点链路解耦与算法增强

> 目标：让下肢 5 节点（waist + 2 knee + 2 ankle）数据能完整跑通「训练 → 推理 → 质量评分」链路，
> 并在 baseline（CNN-BiLSTM-Attention）与结构感知模型之间做可对比的消融。
> 时间约束：**7/28 比赛**，本文档先于代码产出，供评审后立即落地。

---

## 1. 核心矛盾诊断

### 1.1 节点命名四层断层

| 层 | 节点命名 | 节点数 | 关键位置 |
|---|---|---|---|
| 固件 v2.6.1/v2.7.21 | `waist`(+`gateway_waist`)+`left_knee`+`right_knee`+`left_ankle`+`right_ankle` | **5（下肢）** | `gateway_waist_master_mqtt_v2_6_1.ino:131`；`*_imu_test.ino` |
| 云函数 `skateActionAnalyze` | `normalizeRoleName` 把 `left_ankle→left_foot`；存训练样本默认期望 `["waist","left_knee","right_knee","left_foot","right_foot"]` | **5（下肢，含 waist）** | `skateActionAnalyze/index.js:3377`、`:72-95`、`:260-297` |
| 小程序 SDK | `SENSOR_ROLES` 9 节点，**不认 `waist`**；`remote-predict.js:91` 强制 `activeRoles.length>=9` | 9（全身，无 waist） | `wearable-device-sdk.js:1-11`、`sensor-model.js:16-26`、`remote-predict.js:91` |
| 模型加载器 | `JSONL_TO_MODEL_NODE_MAPPING` 9 键**无 `waist`**；`min_valid_nodes=6` | 9（全身，无 waist） | `jsonl_sequence_dataset.py:40-50`、`:70` |

**三个致命断层**：

1. **腰部命名断**：固件/云函数用 `waist`，模型加载器只认 `head`，`waist` 在
   [jsonl_sequence_dataset.py:263](skating-deep-cnn-lstm-bayes/src/jsonl_sequence_dataset.py#L263) 被 `continue` 静默丢弃。
   小程序层有个默认关闭的 `legacy9WaistAsHeadDebug` 开关（`remote-predict.js:22-28`）——曾有人意识到，未解决。
2. **节点数断**：固件只产 5 节点，但 `remote-predict.js:91` 要 9 节点才放行、
   `tools/clean_database_export.py` 的 `REQUIRED_NODES` 强制 9 节点齐全、`min_valid_nodes=6` 也高于 5。
   **真实 5 节点数据进不到模型**。
3. **文档脱节**：`SENSOR_DATA_SCHEMA.md` 写 5 节点(head+2肘+2膝)、集合名 `skate_sensor_training_samples`；
   实际代码用 10 节点 schema、集合 `train_samples_nofiltering`、默认期望下肢 5 节点。三套并存。

### 1.2 算法现状（已通读）

- **分类**：baseline [CNNLSTMAttentionClassifier](skating-deep-cnn-lstm-bayes/src/model.py#L74)（拍平 54 维，丢弃节点结构）
  vs structured [StructuredActionClassifier](skating-deep-cnn-lstm-bayes/src/model.py#L285)
  （逐节点共享 CNN → 跨节点 MultiheadAttention → BiLSTM → attention pooling）。
  **两个模型类本身已节点数参数化**，卡点全在数据链路。
- **质量评分**：LightGBM 回归（[train_lgb_quality.py](skating-deep-cnn-lstm-bayes/src/train_lgb_quality.py)）已就位，
  特征工程扎实（embedding + 动作概率 + 时序统计 + 逐节点方差/jerk + 相似度 + 元数据），全局 z-score 校准 + 崩塌检测。
- **去噪/姿态**：[denoise.py](skating-deep-cnn-lstm-bayes/src/denoise.py)（Hampel 野值剔除）、
  [attitude.py](skating-deep-cnn-lstm-bayes/src/attitude.py)（Mahony 互补滤波）均**节点数无关**，无需改动。

---

## 2. 总体设计

### 2.1 设计原则

1. **配置驱动，不硬编码**：节点顺序、JSONL→模型节点映射、最少有效节点数，全部从配置派生，不在代码里写死 9 或 5。
2. **预设 + 自定义**：内置 `full_body_9`（向后兼容）与 `lower_body_5`（匹配固件现状）两套预设，
   同时允许 `--node-order` 完全自定义。
3. **向后兼容**：无 `arch`/`node_preset` 字段的旧 checkpoint 默认按 `full_body_9` 解析，旧模型推理行为不变。
4. **腰部正名**：5 节点方案里 `waist` 是一等节点（不再是 `head` 的替身），结构感知模型的邻接先验围绕腰部中心构建。

### 2.2 节点预设定义

| 预设名 | JSONL 键（云函数/数据存档侧） | 模型内部节点名（node_order） | 节点数 | 用途 |
|---|---|---|---|---|
| `full_body_9` | head, left_elbow, right_elbow, left_wrist, right_wrist, left_knee, right_knee, left_foot, right_foot | head, l_elbow, l_knee, l_skate, l_wrist, r_elbow, r_knee, r_skate, r_wrist | 9 | 向后兼容旧数据/旧模型 |
| `lower_body_5` | waist, left_knee, right_knee, left_foot, right_foot | waist, l_knee, r_knee, l_skate, r_skate | 5 | **匹配固件/云函数现状，比赛主用** |

> **命名决策（待你确认）**：5 节点模型内部名沿用 `l_skate/r_skate`（与现有 `BASELINE_NODE_ORDER` 风格一致，
> 代码改动最小；`l_skate` 在本仓库语义即「脚踝/轮滑鞋」）。
> 若你更想贴合固件原文，可改为 `l_ankle/r_ankle`——只需改一处预设常量，邻接矩阵同步调整。
> **本文档后续以 `l_skate/r_skate` 为准。**

> **JSONL 键说明**：固件发 `left_ankle`，云函数 `normalizeRoleName` 已将其重命名为 `left_foot` 落库
>（`skateActionAnalyze/index.js:289`）。故模型侧 JSONL 键用 `left_foot/right_foot`，与存档一致，无需在模型侧再做 ankle→foot 转换。

---

## 3. 阶段一：数据链路节点数解耦（必做前提）

> **这是 7/28 比赛能演示 5 节点端到端的硬前提。** 没有它，5 节点数据进不到模型。

### 3.1 NodePreset 接口设计

在 `skating-deep-cnn-lstm-bayes/src/jsonl_sequence_dataset.py` 新增：

```python
@dataclass(frozen=True)
class NodePreset:
    name: str
    jsonl_keys: Tuple[str, ...]          # 数据存档/云函数侧的键名
    model_node_order: Tuple[str, ...]    # 模型内部节点名（决定张量通道顺序）
    jsonl_to_model: Dict[str, str]       # jsonl_keys → model_node_order 映射
    min_valid_ratio: float = 0.8         # 最少有效节点比例（替代写死的 min_valid_nodes）

    @property
    def num_nodes(self) -> int: return len(self.model_node_order)

    @property
    def min_valid_nodes(self) -> int: return max(1, int(self.num_nodes * self.min_valid_ratio))

NODE_PRESETS: Dict[str, NodePreset] = {
    "full_body_9": NodePreset(
        name="full_body_9",
        jsonl_keys=("head","left_elbow","right_elbow","left_wrist","right_wrist",
                    "left_knee","right_knee","left_foot","right_foot"),
        model_node_order=("head","l_elbow","l_knee","l_skate","l_wrist","r_elbow","r_knee","r_skate","r_wrist"),
        jsonl_to_model={"head":"head","left_elbow":"l_elbow","right_elbow":"r_elbow",
                        "left_wrist":"l_wrist","right_wrist":"r_wrist","left_knee":"l_knee",
                        "right_knee":"r_knee","left_foot":"l_skate","right_foot":"r_skate"},
        min_valid_ratio=0.67,   # 9*0.67≈6，等价旧 min_valid_nodes=6
    ),
    "lower_body_5": NodePreset(
        name="lower_body_5",
        jsonl_keys=("waist","left_knee","right_knee","left_foot","right_foot"),
        model_node_order=("waist","l_knee","r_knee","l_skate","r_skate"),
        jsonl_to_model={"waist":"waist","left_knee":"l_knee","right_knee":"r_knee",
                        "left_foot":"l_skate","right_foot":"r_skate"},
        min_valid_ratio=0.8,    # 5*0.8=4，允许丢 1 个节点
    ),
}
```

`SequenceConfig` 改动：
- 新增字段 `node_preset_name: str = "full_body_9"`（向后兼容默认）
- `node_order` / `jsonl_to_model_node_mapping` 不再是模块级常量，而是从 `NODE_PRESETS[preset]` 派生
- `min_valid_nodes` 改为 property，从 `preset.min_valid_nodes` 派生（移除 `:70` 的硬编码 6）
- `to_dict()`/`from_dict()` 持久化 `node_preset_name`，保证推理端复现训练时节点配置

### 3.2 逐文件改动清单

#### A. 模型数据链路（核心）

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/jsonl_sequence_dataset.py` | `:16-50` 模块常量 | 保留 `BASELINE_NODE_ORDER`/`JSONL_TO_MODEL_NODE_MAPPING` 作 `full_body_9` 预设来源；新增 `NodePreset`/`NODE_PRESETS` |
| 同上 | `:63-130` `SequenceConfig` | 加 `node_preset_name`；`node_order`/映射从预设派生；`min_valid_nodes` 改 property |
| 同上 | `:221-337` `convert_record_to_sequence` | 用 `config.jsonl_to_model_node_mapping` 替代模块级 `JSONL_TO_MODEL_NODE_MAPPING`（`:263`） |
| `src/model.py` | `:175-221` `StructuredModelConfig` | 默认 `num_nodes` 改为从预设派生（保留字段，构造时传入）；无需改编码器逻辑（已参数化） |
| `src/predict.py` | `:329-378` `_check_node_completeness` | 用 `checkpoint["sequence_config"]["node_preset_name"]` 对应的 jsonl_keys 做校验，替代写死的 `JSONL_TO_MODEL_NODE_MAPPING` |
| 同上 | `:255-263` fallback | `range(9)` → `range(len(node_order))`；`np.zeros((1,9,6))` → `np.zeros((1,len(node_order),6))` |
| 同上 | `:74-103` `load_action_model` | 无需改（已通过 `sequence_config` 重建） |

#### B. 训练入口

| 文件 | 改动 |
|---|---|
| `src/train_action.py` | `run_action_training` 增加 `node_preset: str = "full_body_9"` 参数；构造 `SequenceConfig` 时传入；CLI 加 `--node-preset` |
| `src/train_multiclass.py` | `run()` 增加 `node_preset` 参数；`build_model` 的 `num_nodes` 从 `seq_config.node_order` 长度取（已是，确认即可）；CLI 加 `--node-preset` |
| `src/train_lgb_quality.py` | `build_lgb_feature_matrix` 从 `checkpoint["sequence_config"]` 重建 `SequenceConfig`（已如此，确认 preset 透传即可）；逐节点方差特征自动适配 `num_nodes`（已是） |

#### C. 推理服务

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/sensor_api.py` | `:52-97` 常量 | `REMOTE_ROLE_TO_BASELINE_NODE` 保留（含 waist→waist）；`/infer` 不再硬性 9 节点校验 |
| 同上 | `:211-248` `_check_nine_node_completeness` | 重命名为 `_check_node_completeness`；required 集合从**已加载 checkpoint 的 `node_preset_name`** 派生，而非 `REMOTE_ROLE_CANONICAL_ORDER` |
| 同上 | `:541`、`api.py:161/228/280` | `"sensor_mode": "9node"` → 从 checkpoint 动态读 `node_preset_name` |
| `src/api.py` | `:331-337` `_validate_frames` | 已是「每个 node 6 值」，无需改；确认即可 |

#### D. 数据清洗工具

| 文件 | 位置 | 改动 |
|---|---|---|
| `tools/clean_database_export.py` | `:28-38` `REQUIRED_NODES` | 改为从 `--node-preset` 派生；默认 `full_body_9`，传 `lower_body_5` 时要求 waist+2knee+2foot |
| 同上 | `:45-75` `_count_complete_frames` | 完整帧判定用 preset 的 jsonl_keys |
| `tools/build_multiclass_dataset.py` | `:33-49` | 同上，`REQUIRED_NODES`/`_frame_complete` 从 preset 派生 |

#### E. SSL 预训练（为阶段二铺路，阶段一不改）

`src/train_ssl.py` 的 `SSLPretrainer` 目前只包裹 `CNNLSTMAttentionClassifier`。
阶段一不动；阶段二让其支持 `StructuredActionClassifier`（见 §4.2）。

#### F. 云函数 / 小程序（链路对齐，非阻塞）

> 这两层改动不影响模型训练/推理，但影响「真实 5 节点数据能否采集到并送进模型」。
> 比赛若用离线 JSONL 训练 + 本地推理，可暂缓；若要端到端实时演示，必须改。

| 文件 | 位置 | 改动 |
|---|---|---|
| `cloudfunctions/skateActionAnalyze/index.js` | `:3377` | 默认 `expectedRoles` 已是下肢 5 节点，确认即可；`sensorProfile` 改名 `lower_body_5_v1` |
| `miniprogram_hers/utils/remote-predict.js` | `:22-28`、`:91` | 移除 `activeRoles.length>=9` 硬校验，改为按 `sensorProfile` 要求的节点数校验；启用 waist 支持 |
| `miniprogram_hers/utils/wearable-device-sdk.js` | `:1-11`、`:38-54` | `SENSOR_ROLES` 增加 waist；`ROLE_ALIAS` 增加 `waist→waist` |
| `cloudfunctions/skateActionAnalyze/SENSOR_DATA_SCHEMA.md` | 全文 | 更新为下肢 5 节点权威定义，删除过期的 9 节点 required roles 与集合名 |

### 3.3 向后兼容策略

1. 旧 checkpoint（无 `node_preset_name` 字段）：`SequenceConfig.from_dict` 缺字段时默认 `full_body_9`，行为与现状完全一致。
2. 旧 JSONL 数据（9 节点）：用 `--node-preset full_body_9` 训练/推理，无任何变化。
3. 新 5 节点数据：用 `--node-preset lower_body_5`，`input_dim` 自动从 54 变 30（5×6），模型配置自动适配。
4. **baseline 与 structured 都自动支持两种 preset**——只需训练时传同一个 `--node-preset`，对比才公平。

### 3.4 验证清单（阶段一完成标志）

- [ ] `python -m src.train_action --node-preset lower_body_5 --jsonl <5节点数据> --output-dir ...` 能跑完并产出 checkpoint，`input_dim=30`
- [ ] `python -m src.train_multiclass --arch structured --node-preset lower_body_5 ...` 能跑完
- [ ] `python -m src.predict --action-model <5节点ckpt> --jsonl <5节点数据>` 推理不报 `node_incomplete`
- [ ] 旧 9 节点 checkpoint 推理行为不变（回归测试）
- [ ] `tools/clean_database_export.py --node-preset lower_body_5` 能保留 5 节点样本
- [ ] `/infer` 接收 5 节点帧不再被 `_check_nine_node_completeness` 拒绝

---

## 4. 阶段二：结构感知模型增强（时间允许的算法优化）

### 4.1 跨节点注意力加生物力学邻接先验

**动机**：5 节点时 cross-node attention 只有 5 个 token，全连接注意力会让每个节点平等地看其它所有节点，
但滑冰运动的节点耦合是有结构的——腰部是躯干中心，应与双侧膝/踝强耦合；左右对称节点（l_knee↔r_knee、l_skate↔r_skate）
在蹬冰/落冰时高度协同；同侧膝↔踝是连杆关系。

**改法**：在 [model.py:250](skating-deep-cnn-lstm-bayes/src/model.py#L250) 的 `cross_node_attn` 上加可学习 attention bias（而非硬 mask，硬 mask 会丢泛化）：

```python
# StructuredIMUEncoder.__init__ 新增
# 邻接先验 bias: [num_nodes, num_nodes]，初始化为生物力学耦合强度
#   腰部 ↔ 所有节点: 强（中心枢纽）
#   同侧膝↔踝: 强（连杆）
#   左右对称膝↔膝、踝↔踝: 中（双侧协同）
#   其它: 弱
self.node_adj_bias = nn.Parameter(torch.zeros(num_nodes, num_nodes))
# 用先验值初始化（可选；也可全 0 让网络自学）
```

在 `cross_node_attn` 调用时把 bias 加到 attention scores 上（`MultiheadAttention` 的 `attn_mask` 可承载加性 bias）。
对 `lower_body_5` 预设定义邻接矩阵；`full_body_9` 可选不加（保持 baseline 对比纯净）。

> 这是**可消融因子**：开/关 `node_adj_bias` 做 A/B，证明先验是否真有增益。
> 小数据下先验通常有帮助（减少搜索空间），但需实验验证，不臆断。

### 4.2 SSL 预训练覆盖结构感知编码器

**现状**：[SSLPretrainer](skating-deep-cnn-lstm-bayes/src/model.py#L384) 的 `self.encoder = CNNLSTMAttentionClassifier(config)`，
只包裹 baseline backbone。结构感知编码器 `StructuredIMUEncoder` 的 per-node CNN + cross-node attention 参数无法被 SSL 预训练。

**改法**：让 `SSLPretrainer` 支持两种 backbone：
- 抽象出 `encoder: Union[CNNLSTMAttentionClassifier, StructuredActionClassifier]`
- 两者都暴露 `extract_embedding(x) -> (embedding, attn)` 接口（已是，见 [model.py:303](skating-deep-cnn-lstm-bayes/src/model.py#L303)）
- `SequenceDecoder`/`ProjectionHead` 不变（它们只依赖 `embedding_dim`）
- `train_ssl.py` 加 `--arch baseline|structured`，与 `train_multiclass.py` 对齐

**收益**：小数据（~222 样本）下，先用无标签数据做 denoising-reconstruction + contrastive 预训练结构感知编码器，
再 fine-tune 分类头，有望显著提升 structured 模型的 macro-F1。

---

## 5. 阶段三：质量评分优化（时间允许）

### 5.1 per-action 校准

**现状**：[train_lgb_quality.py:780](skating-deep-cnn-lstm-bayes/src/train_lgb_quality.py#L780) 的 `_fit_calibration_params` 是全局 z-score。
但不同动作（basic_skating vs braking）分值分布差异大，全局校准会把高分动作拉低、低分动作抬高。

**改法**：按 `predicted_action_id` 分组拟合校准参数，存为 `calibration_params_by_action: Dict[action_name, params]`；
推理时按预测动作取对应参数。`prediction_policy.json` 同步更新。

### 5.2 `only_correct_actions` 退化复查

**现状**：[train_lgb_quality.py:477-493](skating-deep-cnn-lstm-bayes/src/train_lgb_quality.py#L477) 当动作模型弱时，
`predicted==true` 过滤后样本不足 4，会 fallback 到全部样本并记 `filter_policy: "fallback_all_samples"`。

**风险**：fallback 引入了「动作识别错误」的样本进质量训练，污染质量模型。
**改法**：fallback 时降低门槛（如 `min_action_confidence` 从 0 降到允许 top2 命中），而非直接放全量；
并在 `training_report.json` 高亮 fallback 事件，便于答辩时说清数据质量。

---

## 6. 7/28 比赛前的最小可行集（MVP）与执行顺序

> 今天 7/23，距比赛 5 天。MVP 只保证「5 节点端到端能跑 + baseline/structured 可对比」。

### MVP（必做，预计聚焦阶段一）
1. **§3.1 NodePreset + SequenceConfig 改造**（核心，~2 文件）
2. **§3.2-A 模型数据链路**（`jsonl_sequence_dataset.py`、`predict.py`）
3. **§3.2-B 训练入口透传 `--node-preset`**（`train_action.py`、`train_multiclass.py`）
4. **§3.2-C 推理服务去 9 硬编码**（`sensor_api.py` 的 `_check_nine_node_completeness`）
5. **§3.2-D 清洗工具**（`clean_database_export.py`、`build_multiclass_dataset.py`）
6. **§3.4 验证清单全过**

### 增强（时间允许）
7. §4.1 邻接先验（structured 专属增益，答辩亮点）
8. §4.2 SSL 覆盖 structured（小数据增益，答辩亮点）
9. §3.2-F 云函数/小程序链路对齐（仅当要现场实时演示才必做）

### 暂缓
10. §5 质量评分 per-action 校准（质量模型已可用，优化项）

### 建议执行顺序
阶段一 MVP（1→6）→ 跑出 baseline vs structured 在 5 节点上的 macro-F1/混淆矩阵对比 →
若 structured 不如 baseline，做 §4.1 邻接先验 → 若数据太少过拟合，做 §4.2 SSL → 答辩材料。

---

## 7. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| 5 节点真实训练数据不足（固件刚上线） | 模型训不稳 | 先用现有 9 节点数据按 `lower_body_5` preset 抽取腰部+膝+踝子集做过渡；或合成增强 |
| `lower_body_5` 的 `waist` 在旧存档里可能叫 `head`（受 `legacy9WaistAsHeadDebug` 影响） | 数据加载错位 | `NodePreset` 加 `alias_map` 兜底：`lower_body_5` 也接受 `head` 当 `waist`（带告警） |
| 邻接先验在小数据下过拟合 | structured 反而更差 | 先验 bias 初始化为 0 让网络自学，作为可关因子；A/B 验证后再定 |
| 改 `SequenceConfig` 序列化格式 | 旧 checkpoint 加载失败 | `from_dict` 对所有新字段给默认值，旧字段全保留（已规划，§3.3） |
| 比赛前来不及做云函数/小程序链路 | 无法现场实时演示 | MVP 用离线 JSONL + 本地 `predict.py` 演示；实时演示降级为「录屏 + 离线推理」 |

---

## 8. 待你确认的决策点

1. **5 节点模型内部名**：`waist, l_knee, r_knee, l_skate, r_skate`（推荐，代码改动最小）还是 `l_ankle/r_ankle`？
2. **MVP 是否包含 §3.2-F 云函数/小程序链路**？还是要现场实时演示？
3. **现有训练数据**：当前 `train_samples_nofiltering` 里实际存的是 5 节点还是 9 节点？
   （决定能否直接用 `lower_body_5` preset 训练，还是需先做数据子集抽取）
4. **阶段二邻接先验**：是否在 MVP 后立即做（答辩亮点），还是等阶段一验证完再定？

---

*文档基于 2026-07-23 代码现状撰写。评审通过后按 §6 顺序落地。*
