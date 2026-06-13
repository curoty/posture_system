# skating-deep-cnn-lstm-bayes

独立的滑冰动作识别深度模型项目，

## 模型结构

动作分类模型：

```text
JSONL 9-node IMU
  -> fixed sequence tensor [T, C]
  -> 1D-CNN
  -> BiLSTM
  -> optional additive self-attention
  -> FC classifier
```

默认输入：

```text
T = 180
C = 9 nodes * 6 IMU channels = 54
```

可选增强输入：

```text
acc_mag
gyro_mag
C = 9 nodes * 8 channels = 72
```

质量评分模型：

```text
deep embedding
  + action probabilities
  + predicted action one-hot
  + duration_seconds
  + missing_node_ratio
  -> GaussianNB
  -> quality class probabilities
  -> weighted continuous quality_score
```

质量等级：

```text
0 Fail      -> 29.5
1 Mid       -> 67.0
2 Good      -> 82.0
3 Excellent -> 95.0
```

连续分：

```text
quality_score = sum(class_probability * representative_score)
```

## 安装

```bash
pip install -r requirements.txt
```

## 训练动作模型

在本目录下执行：

```bash
python -m src.train_action ^
  --jsonl ..\skating-rf-baseline\data\prepared_combined_segments_v2_4class.jsonl ^
  --output-dir experiments\deep_action_2026-04-19 ^
  --sequence-length 180 ^
  --batch-size 32 ^
  --max-epochs 100
```

如果要启用 `acc_mag` 和 `gyro_mag`：

```bash
python -m src.train_action ^
  --jsonl ..\skating-rf-baseline\data\prepared_combined_segments_v2_4class.jsonl ^
  --output-dir experiments\deep_action_derived_2026-04-19 ^
  --use-derived-channels
```

输出产物：

```text
action_model.pt
label_metadata.json
deep_feature_config.json
normalization.json
dataset_summary.json
training_summary.json
evaluation_summary.json
prediction_policy.json
```

## 训练贝叶斯质量模型

先训练动作模型，再训练质量模型：

```bash
python -m src.train_bayes_quality ^
  --raw ..\skating-rf-baseline\data\prepared_combined_segments_v2_4class.jsonl ^
  --quality-dataset ..\skating-rf-baseline\data\quality_dataset_prepared_combined_v2_4class.csv ^
  --action-model experiments\deep_action_2026-04-19\action_model.pt ^
  --output-dir experiments\deep_quality_2026-04-19
```

默认只用“动作模型分类正确”的样本训练质量分类器。如果过滤后样本不足，会自动退回全部已转换样本，并在 `training_summary.json` 中记录。

输出产物：

```text
bayes_quality_global.pkl
bayes_quality_by_action/
quality_feature_config.json
dataset_summary.json
training_summary.json
evaluation_summary.json
prediction_policy.json
```

## 推理

只做动作分类：

```bash
python -m src.predict ^
  --jsonl ..\skating-rf-baseline\data\prepared_combined_segments_v2_4class.jsonl ^
  --action-model experiments\deep_action_2026-04-19\action_model.pt ^
  --output experiments\predictions_action_only.json
```

动作分类 + 贝叶斯质量评分：

```bash
python -m src.predict ^
  --jsonl ..\skating-rf-baseline\data\prepared_combined_segments_v2_4class.jsonl ^
  --action-model experiments\deep_action_2026-04-19\action_model.pt ^
  --quality-model experiments\deep_quality_2026-04-19\bayes_quality_global.pkl ^
  --quality-by-action-dir experiments\deep_quality_2026-04-19\bayes_quality_by_action ^
  --output experiments\predictions_with_quality.json
```

质量评分只在动作分类满足以下条件时执行：

```text
action_confidence >= 0.65
top1_probability - top2_probability >= 0.15
```

否则：

```json
{
  "quality_score": null,
  "quality_prediction": null,
  "quality_skip_reason": "low_action_confidence"
}
```


当前数据只有约 222 条时，深度模型可能不稳定。数据增长到 2000 条以上后，应重点看 `macro_f1` 和每个动作/质量档位的召回率，而不是只看 accuracy。

## Reference similarity scoring

Build a standard-action reference library first:

```bash
python -m src.build_reference_library ^
  --jsonl data\standard_actions.jsonl ^
  --action-model experiments\deep_action_2026-04-19\action_model.pt ^
  --output-dir experiments\reference_library_2026-04-20
```

Run inference with reference similarity as the primary score and GaussianNB as an auxiliary prediction:

```bash
python -m src.predict ^
  --jsonl ..\skating-rf-baseline\data\prepared_combined_segments_v2_4class.jsonl ^
  --action-model experiments\deep_action_2026-04-19\action_model.pt ^
  --reference-library experiments\reference_library_2026-04-20 ^
  --quality-model experiments\deep_quality_2026-04-19\bayes_quality_global.pkl ^
  --quality-by-action-dir experiments\deep_quality_2026-04-19\bayes_quality_by_action ^
  --output experiments\predictions_similarity_with_bayes_aux.json
```

In this mode, `quality_score` and `quality_level` come from `reference_similarity_score` when the reference lookup succeeds. The existing `quality_prediction` field remains the GaussianNB quality prediction and can be used as an auxiliary reference.
