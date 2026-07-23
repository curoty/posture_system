Page({
  data: {
    studentInfo: {},
    periods: ['最近7天', '最近30天', '最近90天', '全部'],
    selectedPeriod: '最近30天',
    stats: {
      attendanceRate: 95,
      averageScore: 85,
      totalTrainingTime: 1200
    },
    scoreTrend: [
      { date: '2-17', score: 80 },
      { date: '2-18', score: 82 },
      { date: '2-19', score: 85 },
      { date: '2-20', score: 83 },
      { date: '2-21', score: 88 },
      { date: '2-22', score: 86 },
      { date: '2-23', score: 90 }
    ],
    intensityDistribution: {
      low: 20,
      medium: 60,
      high: 20
    },
    trainingSummary: '张三同学在过去30天的训练中表现良好，出勤率达到95%，平均评分为85分，总训练时长为1200分钟。训练强度分布合理，以中等强度为主，占比60%。评分趋势整体呈上升趋势，说明训练效果明显。',
    recommendations: [
      '继续保持当前的训练强度和频率',
      '适当增加高强度训练的比例，提高训练效果',
      '加强技巧训练，提升技术水平',
      '注意训练后的放松和恢复，避免过度疲劳'
    ]
  },

  onLoad(options) {
    const studentId = options.id;
    this.loadStudentInfo(studentId);
    this.loadStats(studentId);
  },

  loadStudentInfo(studentId) {
    // 模拟从后端获取学生信息
    const studentInfo = {
      id: studentId,
      name: '张三',
      phone: '138****8888'
    };
    this.setData({ studentInfo });
  },

  loadStats(studentId) {
    // 模拟从后端获取统计数据
    const stats = {
      attendanceRate: 95,
      averageScore: 85,
      totalTrainingTime: 1200
    };
    
    const scoreTrend = [
      { date: '2-17', score: 80 },
      { date: '2-18', score: 82 },
      { date: '2-19', score: 85 },
      { date: '2-20', score: 83 },
      { date: '2-21', score: 88 },
      { date: '2-22', score: 86 },
      { date: '2-23', score: 90 }
    ];
    
    const intensityDistribution = {
      low: 20,
      medium: 60,
      high: 20
    };
    
    const trainingSummary = '张三同学在过去30天的训练中表现良好，出勤率达到95%，平均评分为85分，总训练时长为1200分钟。训练强度分布合理，以中等强度为主，占比60%。评分趋势整体呈上升趋势，说明训练效果明显。';
    
    const recommendations = [
      '继续保持当前的训练强度和频率',
      '适当增加高强度训练的比例，提高训练效果',
      '加强技巧训练，提升技术水平',
      '注意训练后的放松和恢复，避免过度疲劳'
    ];
    
    this.setData({ stats, scoreTrend, intensityDistribution, trainingSummary, recommendations });
  },

  bindPeriodChange(e) {
    const index = e.detail.value;
    this.setData({ selectedPeriod: this.data.periods[index] });
    // 这里可以添加按时间段筛选逻辑
  }
});
