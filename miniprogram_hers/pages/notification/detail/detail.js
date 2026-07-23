Page({
  data: {
    title: '',
    content: '',
    timeText: '',
    categoryLabel: '',
    senderName: '',
    type: '',
    icon: '/images/icons/notification-system.svg'
  },

  safeDecode(text) {
    try {
      return decodeURIComponent(String(text || ''));
    } catch (e) {
      return String(text || '');
    }
  },

  resolveIconByType(type, categoryLabel, text) {
    const safeType = String(type || '').toLowerCase();
    const safeText = `${String(categoryLabel || '')} ${String(text || '')}`.toLowerCase();
    if (safeType === 'training_report') {
      return '/images/icons/notification-report.svg';
    }
    if (safeType === 'schedule_slot_published') {
      return '/images/icons/notification-course.svg';
    }
    if (safeType === 'schedule_booking' || safeType.includes('schedule') || safeType.includes('reminder')) {
      return '/images/icons/notification-reminder.svg';
    }
    if (safeType.includes('flower') || safeType.includes('reward') || safeText.includes('小红花') || safeText.includes('奖励')) {
      return '/images/icons/notification-reward.svg';
    }
    return '/images/icons/notification-system.svg';
  },

  onLoad(options) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const title = this.safeDecode(safeOptions.title) || '消息详情';
    const content = this.safeDecode(safeOptions.content);
    const timeText = this.safeDecode(safeOptions.timeText);
    const categoryLabel = this.safeDecode(safeOptions.categoryLabel) || '系统通知';
    const senderName = this.safeDecode(safeOptions.senderName) || '系统';
    const type = this.safeDecode(safeOptions.type) || 'system';

    this.setData({
      title,
      content,
      timeText,
      categoryLabel,
      senderName,
      type,
      icon: this.resolveIconByType(type, categoryLabel, `${title} ${content}`)
    });
  }
});
