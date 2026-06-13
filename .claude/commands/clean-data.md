# 数据清洗命令

对 $ARGUMENTS 指定的 JSONL 数据文件执行标准清洗流程，输出清洗后的训练集和归档文件。

## 使用方式

```
/clean-data <input.jsonl>
/clean-data data/database_export.jsonl
/clean-data data/new_batch.jsonl --output data/cleaned_new_batch.jsonl
```

## 执行步骤

1. **确认文件存在**：检查 $ARGUMENTS 指定的文件路径是否可访问

2. **运行清洗脚本**：
   ```bash
   python tools/clean_data.py $ARGUMENTS
   ```
   输出文件自动命名为 `cleaned_<原文件名>.jsonl`，归档文件为 `archived_<原文件名>.jsonl`

3. **核查清洗报告**，对照以下基准判断结果是否正常：

   | 指标 | 本次基准（database_export） | 异常信号 |
   |------|----------------------------|----------|
   | 丢弃率 | 10.6%（301/2840） | >25% 说明数据格式可能有变化 |
   | 无有效帧丢弃 | 18 条 | 骤增说明传感器连接问题加剧 |
   | 投票丢弃（<6/10） | 283 条 | 骤增说明采集质量下降 |
   | 修复动作标签 | 109 条 | 新数据若有新的命名错误需更新脚本 |
   | 修复质量等级标签 | 826 条 | 新数据应为 0（问题已修复）|
   | 前10帧 10/10 完整 | 79% | <70% 需关注采集环境 |

4. **验证清洗后质量**，确认以下字段全部为 0：
   - 残留 `sensor_session`
   - 残留 `"不及格"` 标签
   - 前10帧投票 <6/10 的记录

---

## 清洗规则（2026-06-08 确认，database_export 2,840→2,538 条）

| # | 规则 | 处理方式 | 本次数量 |
|---|------|----------|----------|
| 1 | `actionType = sensor_session` | 重命名为 `weight_shift`（实为重心转移动作，命名有误） | 109 条 |
| 2 | `qualityLevel = "不及格"` | 统一改为 `"不合格"`（与 Java QualityLevel.java / Python quality_labels.py 对齐） | 826 条 |
| 3 | 无有效帧（frames 为空或全空） | 丢弃 | 18 条 |
| 4 | 前10帧投票 ≤50% 包含完整9节点 | 丢弃（节点缺失，54维输入不完整） | 283 条 |
| 5 | `actionType = side_push_recover` | 归档到 `archived_*.jsonl`，不进训练集 | 1 条 |
| 6 | 完整9节点但得0分的记录 | **保留**（专门收集的错误动作负样本，对质量回归有价值） | ~313 条 |

## 节点完整性判定逻辑（多帧投票）

必须全部存在的9个语义节点（对应 `SensorNodeMapping.REQUIRED_NODES`）：
```
head, left_elbow, left_wrist, right_elbow, right_wrist,
left_knee, left_foot, right_knee, right_foot
```

**判定方式**：取前 `NODE_CHECK_FRAMES`（默认10）帧，统计包含全部9个非零节点的帧数，
超过半数（>50%）才算通过。相比首帧单点检查，投票法避免了因传感器启动延迟导致的误杀
（本次救回 68 条首帧恰好缺节点但后续完整的记录）。

## 清洗后数据分布（database_export 基准）

```
总保留：2,538 条，全部 weight_shift

质量等级分布：
  不合格：967 条 (38%)
  及格：  660 条 (26%)
  良好：  580 条 (23%)
  优秀：  329 条 (13%)  ← 高分样本偏少，训练时建议数据增强

前10帧完整度：
  10/10：2,003 条 (79%)
   9/10：  519 条 (20%)
  ≤8/10：   16 条  (1%)
```

## 新数据注意事项

如果新数据出现以下情况，需要先更新 `tools/clean_data.py` 再运行：

- **新动作类型**：更新 `ARCHIVE_ACTIONS`（归档）或在 `clean_record()` 中加重命名规则
- **新质量等级写法**：加入 `QUALITY_LEVEL_REMAP` 字典
- **节点名称变更**：同步更新 `REQUIRED_NODES` 及 Java `SensorNodeMapping` / Python `JSONL_TO_MODEL_NODE_MAPPING`
- **帧结构变化**：检查 `_frame_has_all_nodes()` 中 payload 字段层级
- **投票阈值调整**：修改常量 `NODE_CHECK_FRAMES`（默认10）

## reference_standards 清洗

`reference_standards.jsonl` 是 `database_export` 的高分子集（_id 100% 匹配），
**不需要合并训练**，database_export 清洗后已包含这 370 条。
若需单独清洗参考标准库，同样使用本命令，预期：
- 丢弃模式B（首帧为空）22 条
- 丢弃模式A（缺下肢/腕节点）45 条，投票法可能救回部分
- 保留约 303~320 条

---

## 数据增强（2026-06-08）

清洗后的数据四个质量等级分布不均（不合格 967、及格 660、良好 580、优秀 329），
需通过数据增强将各等级均衡化。

### 增强策略

| 参数 | 值 |
|------|-----|
| 目标数量 | 各等级最大值（967 条），自动均衡 |
| 增强源 | 仅从**每帧都含全部 9 个非零节点**的完整记录中采样 |
| 随机种子 | `--seed 42`，保证可复现 |

### 增强方法（每个变体随机组合 2–4 种，噪声必选）

| 方法 | 概率 | 参数 |
|------|------|------|
| **高斯噪声** | 100%（必选） | σ_acc ∈ [0.005, 0.02], σ_gyro ∈ [0.005, 0.02] |
| **时间裁剪** | 50% | 随机取 ≥150 帧子窗口 → 线性插值回 180 帧 |
| **时间缩放** | 50% | 时间戳 × [0.9, 1.1]，模拟快慢变化 |
| **左右镜像** | 30% | left/right 节点对调，ax/gx/gz 通道取反 |

### 各等级增强量（database_export 基准）

| 等级 | 增强前 | 增强 | 增强后 |
|------|--------|------|--------|
| 不合格 | 967 | 0 | 967 |
| 及格 | 660 | 307 | 967 |
| 良好 | 580 | 387 | 967 |
| 优秀 | 329 | 638 | 967 |
| **合计** | 2,536 | 1,332 | **3,868** |

### 完整命令顺序（新数据来了就这样跑）

```bash
cd skating-deep-cnn-lstm-bayes

# 第一步：清洗
python tools/clean_database_export.py \
    --input ../database_export-xxx.json \
    --output cleaned_training_set.jsonl \
    --archive archived_side_push_recover.jsonl

# 第二步：增强
python tools/augment_data.py \
    --input cleaned_training_set.jsonl \
    --output training_set.jsonl \
    --seed 42

# 验证
python -c "
import json
from collections import Counter
records = [json.loads(l) for l in open('training_set.jsonl','r',encoding='utf-8') if l.strip()]
tags = Counter()
for r in records:
    l = r.get('label',{})
    tags[l.get('qualityTag','N/A') if isinstance(l,dict) else 'N/A'] += 1
print(f'Total: {len(records)}, Augmented: {sum(1 for r in records if r.get(\"augmented\"))}')
print(f'Distribution: {dict(tags)}')
"
```
