"""
Posture System — Vision Module
================================
基于视频/关键点的花样滑冰动作识别与质量评分子系统。

包含组件:
- pose_extractor: 视频 → RTMPose 关键点提取
- skeleton_graph: 人体骨骼图定义 (COCO 17 关键点)
- stgcn_model: ST-GCN 时空图卷积网络
- train_vision: 训练管线
- inference_vision: 推理管线
- multimodal_aligner: 视频 ↔ IMU 结果对齐 (晚融合)
- config: 视觉管道统一配置
"""
