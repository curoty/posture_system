const FEATURE_GATES = {
  // Student side AI action analysis entry is kept, but generation is temporarily closed.
  studentAiActionAnalyzeEnabled: true,
  studentAiActionAnalyzeLockMessage: "AI动作分析功能维护中，暂未开放",

  // Community AI action analysis is temporarily closed (student + coach entry and auto-analyze card).
  communityAiActionAnalyzeEnabled: true,
  communityAiActionAnalyzeLockMessage: "社区AI动作分析暂未开放",

  // Coach/admin community management is temporarily closed.
  coachCommunityManageEnabled: true,
  coachCommunityManageLockMessage: "社区内容管理功能维护中，暂未开放",

  // Student report AI-generated insights are temporarily closed.
  studentAiReportInsightsEnabled: false,
  studentAiReportInsightsLockMessage: "AI生成报告功能维护中，暂未开放",

  // Sensor component is open for data collection.
  sensorComponentEnabled: true,
  sensorComponentLockMessage: "传感器组件功能维护中，暂未开放",

  // Sensor big-screen display is temporarily closed.
  sensorBigScreenEnabled: false,
  sensorBigScreenLockMessage: "大屏展示功能维护中，暂未开放",
};

module.exports = {
  FEATURE_GATES,
};
