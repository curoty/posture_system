-- Posture System / Tencent Cloud MySQL 8.0 schema
-- IMU raw frames remain in Tencent Cloud document database collection:
-- skate_sensor_training_samples. Do not store raw IMU frames in MySQL.

-- CloudBase/TDSQL 控制台已经选定数据库，一般不允许 CREATE DATABASE / USE。
-- 请先在控制台创建并选中数据库 posture_system，字符集选择 utf8mb4，
-- 排序规则选择 utf8mb4_unicode_ci，然后从下方 CREATE TABLE 开始执行。

-- CloudBase/TDSQL SQL console may reject session-level SET statements.
-- utf8mb4 is declared at database/table level. DATETIME values are written
-- as Asia/Shanghai business time by the application, so no session time_zone
-- statement is required here.

-- Cloud document IDs are 32 chars today, but VARCHAR(64) leaves migration room.
-- Every table contains `_openid` for Tencent Cloud development permission checks.
-- MySQL columns use snake_case. The API layer must map frontend camelCase names
-- (for example activityId/studentPhone) to activity_id/student_phone.

CREATE TABLE IF NOT EXISTS users (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '' COMMENT '云开发权限主体',
  phone VARCHAR(32) NOT NULL DEFAULT '',
  password_hash VARCHAR(255) NOT NULL DEFAULT '',
  password_updated_at DATETIME(3) NULL,
  name VARCHAR(100) NOT NULL DEFAULT '',
  nick_name VARCHAR(100) NOT NULL DEFAULT '',
  avatar_url VARCHAR(1024) NOT NULL DEFAULT '',
  role VARCHAR(32) NOT NULL DEFAULT 'student',
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  level INT NOT NULL DEFAULT 0,
  coach_id VARCHAR(64) NOT NULL DEFAULT '',
  admin_access BOOLEAN NOT NULL DEFAULT FALSE,
  admin_owner_id VARCHAR(64) NOT NULL DEFAULT '',
  join_date DATE NULL,
  student_since DATETIME(3) NULL,
  role_updated_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  KEY idx_users_openid_permission (`_openid`),
  KEY idx_users_phone (phone),
  KEY idx_users_role_status (role, status),
  KEY idx_users_coach (coach_id)
) ENGINE=InnoDB COMMENT='用户、角色及教练学员关系';

CREATE TABLE IF NOT EXISTS user_coach_relations (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  student_id VARCHAR(64) NOT NULL,
  coach_id VARCHAR(64) NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  UNIQUE KEY uk_user_coach_relation (student_id, coach_id),
  KEY idx_user_coach_openid (`_openid`),
  KEY idx_user_coach_coach (coach_id, status),
  KEY idx_user_coach_student (student_id, status)
) ENGINE=InnoDB COMMENT='规范化的教练学员多对多关系；users.coach_id仅作主教练缓存';

CREATE TABLE IF NOT EXISTS user_admin_grants (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  user_id VARCHAR(64) NOT NULL,
  owner_user_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  granted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  UNIQUE KEY uk_user_admin_grant (user_id, owner_user_id),
  KEY idx_user_admin_openid (`_openid`),
  KEY idx_user_admin_owner (owner_user_id, status),
  KEY idx_user_admin_user (user_id, status)
) ENGINE=InnoDB COMMENT='规范化的教练后台授权关系；users.admin_owner_id仅作兼容缓存';

CREATE TABLE IF NOT EXISTS activity_events (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  category VARCHAR(64) NOT NULL DEFAULT '',
  category_label VARCHAR(100) NOT NULL DEFAULT '',
  coach_id VARCHAR(64) NOT NULL DEFAULT '',
  coach_name VARCHAR(100) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  image_url VARCHAR(1024) NOT NULL DEFAULT '',
  price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  max_participants INT NOT NULL DEFAULT 0,
  enroll_count INT NOT NULL DEFAULT 0,
  start_at DATETIME NULL,
  end_at DATETIME NULL,
  deadline_at DATETIME NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  KEY idx_event_openid (`_openid`),
  KEY idx_event_coach (coach_id, status),
  KEY idx_event_category_status (category, status),
  KEY idx_event_time (start_at, end_at)
) ENGINE=InnoDB COMMENT='活动、课程商品';

CREATE TABLE IF NOT EXISTS activities (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  icon VARCHAR(32) NOT NULL DEFAULT '',
  related_id VARCHAR(64) NOT NULL DEFAULT '',
  related_source VARCHAR(32) NOT NULL DEFAULT '',
  related_type VARCHAR(64) NOT NULL DEFAULT '',
  text VARCHAR(500) NOT NULL DEFAULT '',
  visible_for_coach BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  KEY idx_activity_openid (`_openid`),
  KEY idx_activity_related (related_type, related_id),
  KEY idx_activity_created (created_at)
) ENGINE=InnoDB COMMENT='动态流/业务事件日志，不是活动商品';

CREATE TABLE IF NOT EXISTS activity_enrollments (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  activity_id VARCHAR(64) NOT NULL COMMENT '对应前端activityId，指向activity_events._id',
  student_id VARCHAR(64) NOT NULL,
  student_openid VARCHAR(128) NOT NULL DEFAULT '',
  student_name VARCHAR(100) NOT NULL DEFAULT '',
  student_phone VARCHAR(32) NOT NULL DEFAULT '' COMMENT '前端兼容查询字段',
  quantity INT NOT NULL DEFAULT 1,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  enroll_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  payment_status VARCHAR(32) NOT NULL DEFAULT 'unpaid',
  paid_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  UNIQUE KEY uk_enrollment_activity_student (activity_id, student_id),
  KEY idx_enrollment_openid (`_openid`),
  KEY idx_enrollment_student (student_id, created_at),
  KEY idx_enrollment_phone (student_phone, created_at),
  KEY idx_enrollment_payment (payment_status, created_at)
) ENGINE=InnoDB COMMENT='活动报名及支付状态';

CREATE TABLE IF NOT EXISTS schedule_slots (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  coach_id VARCHAR(64) NOT NULL,
  coach_name VARCHAR(100) NOT NULL DEFAULT '',
  coach_openid VARCHAR(128) NOT NULL DEFAULT '',
  coach_owner_id VARCHAR(64) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL,
  slot_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  max_students INT NOT NULL DEFAULT 1,
  booked_count INT NOT NULL DEFAULT 0,
  student_unlimited BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  KEY idx_slot_openid (`_openid`),
  KEY idx_slot_coach_date (coach_id, slot_date, start_time),
  KEY idx_slot_date_status (slot_date, status)
) ENGINE=InnoDB COMMENT='教练可预约课程时段';

CREATE TABLE IF NOT EXISTS schedule_bookings (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  slot_id VARCHAR(64) NOT NULL,
  booker_role VARCHAR(32) NOT NULL DEFAULT 'student',
  coach_id VARCHAR(64) NOT NULL,
  coach_name VARCHAR(100) NOT NULL DEFAULT '',
  coach_openid VARCHAR(128) NOT NULL DEFAULT '',
  coach_owner_id VARCHAR(64) NOT NULL DEFAULT '',
  student_id VARCHAR(64) NOT NULL,
  student_name VARCHAR(100) NOT NULL DEFAULT '',
  student_openid VARCHAR(128) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL DEFAULT '',
  booking_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  UNIQUE KEY uk_booking_slot_student (slot_id, student_id),
  KEY idx_booking_openid (`_openid`),
  KEY idx_booking_student_date (student_id, booking_date),
  KEY idx_booking_coach_date (coach_id, booking_date),
  KEY idx_booking_status (status, booking_date)
) ENGINE=InnoDB COMMENT='课程预约记录';

CREATE TABLE IF NOT EXISTS notifications (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  receiver_user_id VARCHAR(64) NOT NULL DEFAULT '',
  receiver_openid VARCHAR(128) NOT NULL DEFAULT '',
  sender_user_id VARCHAR(64) NOT NULL DEFAULT '',
  sender_openid VARCHAR(128) NOT NULL DEFAULT '',
  sender_name VARCHAR(100) NOT NULL DEFAULT '',
  type VARCHAR(64) NOT NULL DEFAULT 'system',
  title VARCHAR(255) NOT NULL,
  content TEXT NULL,
  related_id VARCHAR(64) NOT NULL DEFAULT '',
  related_type VARCHAR(64) NOT NULL DEFAULT '',
  related_path VARCHAR(500) NOT NULL DEFAULT '',
  extra JSON NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  KEY idx_notification_openid (`_openid`),
  KEY idx_notification_receiver (receiver_user_id, is_read, created_at),
  KEY idx_notification_receiver_openid (receiver_openid, is_read, created_at),
  KEY idx_notification_related (related_type, related_id)
) ENGINE=InnoDB COMMENT='站内通知';

CREATE TABLE IF NOT EXISTS training_tasks (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  coach_id VARCHAR(64) NOT NULL,
  coach_name VARCHAR(100) NOT NULL DEFAULT '',
  coach_phone VARCHAR(32) NOT NULL DEFAULT '',
  training_date DATE NOT NULL,
  training_type VARCHAR(100) NOT NULL,
  duration_minutes DECIMAL(8,2) NOT NULL,
  intensity VARCHAR(32) NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  target_type VARCHAR(32) NOT NULL DEFAULT 'coach_students',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  KEY idx_task_openid (`_openid`),
  KEY idx_task_coach_date (coach_id, training_date),
  KEY idx_task_status_date (status, training_date)
) ENGINE=InnoDB COMMENT='教练发布的训练任务';

CREATE TABLE IF NOT EXISTS training_task_students (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  task_id VARCHAR(64) NOT NULL,
  student_id VARCHAR(64) NOT NULL,
  student_openid VARCHAR(128) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  completed_at DATETIME(3) NULL,
  result_note TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  UNIQUE KEY uk_task_student (task_id, student_id),
  KEY idx_task_student_openid (`_openid`),
  KEY idx_task_student_user (student_id, status)
) ENGINE=InnoDB COMMENT='训练任务的目标学员及完成状态';

CREATE TABLE IF NOT EXISTS training_reports (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  coach_id VARCHAR(64) NOT NULL,
  coach_name VARCHAR(100) NOT NULL DEFAULT '',
  coach_openid VARCHAR(128) NOT NULL DEFAULT '',
  coach_owner_id VARCHAR(64) NOT NULL DEFAULT '',
  coach_role_tag VARCHAR(32) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  receiver_scope VARCHAR(64) NOT NULL DEFAULT 'coach_students',
  status VARCHAR(32) NOT NULL DEFAULT 'published',
  student_count INT NOT NULL DEFAULT 0,
  total_flower_count DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  KEY idx_report_openid (`_openid`),
  KEY idx_report_coach (coach_id, status, created_at)
) ENGINE=InnoDB COMMENT='训练总结报告';

CREATE TABLE IF NOT EXISTS training_report_students (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  report_id VARCHAR(64) NOT NULL,
  student_id VARCHAR(64) NOT NULL,
  student_name VARCHAR(100) NOT NULL DEFAULT '',
  student_openid VARCHAR(128) NOT NULL DEFAULT '',
  student_phone VARCHAR(32) NOT NULL DEFAULT '',
  flower_count DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  UNIQUE KEY uk_report_student (report_id, student_id),
  KEY idx_report_student_openid (`_openid`),
  KEY idx_report_student_user (student_id, created_at)
) ENGINE=InnoDB COMMENT='报告中的学员及奖励明细';

CREATE TABLE IF NOT EXISTS skate_action_analysis_records (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  user_id VARCHAR(64) NOT NULL DEFAULT '',
  action_type VARCHAR(100) NOT NULL DEFAULT '',
  source_type VARCHAR(32) NOT NULL DEFAULT '',
  file_id VARCHAR(1024) NOT NULL DEFAULT '',
  note TEXT NULL,
  inference_mode VARCHAR(32) NOT NULL DEFAULT '',
  api_error VARCHAR(255) NOT NULL DEFAULT '',
  overall_score DECIMAL(5,2) NULL,
  confidence DECIMAL(5,2) NULL,
  analysis JSON NOT NULL,
  source_summary JSON NULL,
  video_info JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  KEY idx_analysis_permission_openid (`_openid`),
  KEY idx_analysis_user (user_id, created_at),
  KEY idx_analysis_action (action_type, created_at),
  KEY idx_analysis_score (overall_score)
) ENGINE=InnoDB COMMENT='视频/动作分析结果；不包含IMU原始帧';

CREATE TABLE IF NOT EXISTS community_posts (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  author_id VARCHAR(64) NOT NULL,
  author_openid VARCHAR(128) NOT NULL DEFAULT '',
  author_role VARCHAR(32) NOT NULL DEFAULT '',
  author_name VARCHAR(100) NOT NULL DEFAULT '',
  author_avatar_url VARCHAR(1024) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL DEFAULT '',
  content TEXT NULL,
  post_type VARCHAR(32) NOT NULL DEFAULT 'text',
  source VARCHAR(32) NOT NULL DEFAULT '',
  tag VARCHAR(64) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  is_notice BOOLEAN NOT NULL DEFAULT FALSE,
  pin_until DATETIME(3) NULL,
  images JSON NULL,
  video JSON NULL,
  like_count INT NOT NULL DEFAULT 0,
  comment_count INT NOT NULL DEFAULT 0,
  view_count INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  KEY idx_post_openid (`_openid`),
  KEY idx_post_author (author_id, created_at),
  KEY idx_post_status_created (status, created_at),
  KEY idx_post_notice_pin (is_notice, pin_until)
) ENGINE=InnoDB COMMENT='社区帖子';

CREATE TABLE IF NOT EXISTS community_comments (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  post_id VARCHAR(64) NOT NULL,
  parent_comment_id VARCHAR(64) NULL,
  author_id VARCHAR(64) NOT NULL DEFAULT '',
  author_openid VARCHAR(128) NOT NULL DEFAULT '',
  author_name VARCHAR(100) NOT NULL DEFAULT '',
  author_avatar_url VARCHAR(1024) NOT NULL DEFAULT '',
  source VARCHAR(32) NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  images JSON NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  KEY idx_comment_openid (`_openid`),
  KEY idx_comment_post (post_id, created_at),
  KEY idx_comment_parent (parent_comment_id)
) ENGINE=InnoDB COMMENT='社区评论与回复';

CREATE TABLE IF NOT EXISTS community_post_likes (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  post_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL DEFAULT '',
  user_openid VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`_id`),
  UNIQUE KEY uk_post_like (post_id, user_openid),
  KEY idx_post_like_openid (`_openid`),
  KEY idx_post_like_user (user_id, created_at)
) ENGINE=InnoDB COMMENT='帖子点赞关系';

CREATE TABLE IF NOT EXISTS community_post_views (
  `_id` VARCHAR(64) NOT NULL,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  post_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL DEFAULT '',
  user_openid VARCHAR(128) NOT NULL,
  first_viewed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_viewed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  view_count INT NOT NULL DEFAULT 1,
  PRIMARY KEY (`_id`),
  UNIQUE KEY uk_post_view (post_id, user_openid),
  KEY idx_post_view_openid (`_openid`),
  KEY idx_post_view_user (user_id, last_viewed_at)
) ENGINE=InnoDB COMMENT='帖子独立访客与浏览次数';

-- -------------------------------------------------------------------------
-- Spring Boot inference tables. Names and column types match JPA entities.
-- `_openid` has a default only to keep current JPA inserts compatible. The
-- service should populate the caller OpenID before exposing tables via the
-- CloudBase SDK/API; an empty value does not grant owner permissions.
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS device_session (
  id BIGINT NOT NULL AUTO_INCREMENT,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  session_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  calibration_status VARCHAR(32) NULL,
  started_at DATETIME(3) NULL,
  stopped_at DATETIME(3) NULL,
  last_data_at DATETIME(3) NULL,
  last_heartbeat_at DATETIME(3) NULL,
  frame_count INT NOT NULL DEFAULT 0,
  error_message TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_device_session_session_id (session_id),
  KEY idx_device_session_openid (`_openid`),
  KEY idx_device_session_status (status),
  KEY idx_device_session_updated_at (updated_at),
  KEY idx_device_session_device (device_id, created_at)
) ENGINE=InnoDB COMMENT='传感器采集会话元数据，不包含IMU帧';

CREATE TABLE IF NOT EXISTS inference_task (
  id BIGINT NOT NULL AUTO_INCREMENT,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  task_no VARCHAR(64) NOT NULL,
  user_id BIGINT NULL COMMENT '保留现有JPA Long类型；未来应统一为users._id字符串',
  session_id VARCHAR(128) NULL,
  input_type VARCHAR(32) NOT NULL,
  raw_data_path VARCHAR(500) NULL COMMENT '文档库ID、对象存储路径或上传文件路径',
  status VARCHAR(32) NOT NULL,
  error_message TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_inference_task_task_no (task_no),
  KEY idx_inference_task_openid (`_openid`),
  KEY idx_inference_task_created_at (created_at),
  KEY idx_inference_task_session_id (session_id),
  KEY idx_inference_task_status (status, created_at)
) ENGINE=InnoDB COMMENT='推理任务编排记录';

CREATE TABLE IF NOT EXISTS inference_result (
  id BIGINT NOT NULL AUTO_INCREMENT,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  task_id BIGINT NOT NULL,
  sample_index INT NOT NULL,
  action_label_id INT NULL,
  action_label_name VARCHAR(100) NULL,
  confidence DOUBLE NULL,
  quality_score DOUBLE NULL,
  quality_level VARCHAR(50) NULL,
  coaching_advice TEXT NULL,
  ai_coach_advice TEXT NULL,
  raw_result_json LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_inference_result_task_sample (task_id, sample_index),
  KEY idx_inference_result_openid (`_openid`),
  KEY idx_inference_result_task_id (task_id),
  KEY idx_inference_result_action (action_label_name, created_at),
  KEY idx_inference_result_quality (quality_score)
) ENGINE=InnoDB COMMENT='模型推理窗口结果';

CREATE TABLE IF NOT EXISTS raw_data_file (
  id BIGINT NOT NULL AUTO_INCREMENT,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  task_id BIGINT NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  file_type VARCHAR(32) NOT NULL,
  frame_count INT NULL,
  size_bytes BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_raw_data_file_openid (`_openid`),
  KEY idx_raw_data_file_task_id (task_id)
) ENGINE=InnoDB COMMENT='上传/推理原始文件引用，不保存文件内容';

CREATE TABLE IF NOT EXISTS imu_document (
  id BIGINT NOT NULL AUTO_INCREMENT,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  doc_id VARCHAR(256) NULL COMMENT '文档数据库文档ID或路径',
  storage_type VARCHAR(64) NOT NULL COMMENT '例如cloudbase_document',
  session_id VARCHAR(128) NULL,
  device_id VARCHAR(128) NULL,
  frame_count INT NULL,
  size_bytes BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_imu_document_doc_id (doc_id),
  KEY idx_imu_document_openid (`_openid`),
  KEY idx_imu_document_session_id (session_id),
  KEY idx_imu_document_device (device_id, created_at)
) ENGINE=InnoDB COMMENT='IMU文档索引；原始帧仅存文档型数据库';

CREATE TABLE IF NOT EXISTS student_action_record (
  id BIGINT NOT NULL AUTO_INCREMENT,
  `_openid` VARCHAR(128) NOT NULL DEFAULT '',
  user_id VARCHAR(128) NULL,
  session_id VARCHAR(128) NULL,
  source VARCHAR(128) NULL,
  frame_count INT NULL,
  score DOUBLE NULL,
  score_color VARCHAR(64) NULL,
  quality VARCHAR(128) NULL,
  quality_class VARCHAR(64) NULL,
  confidence DOUBLE NULL,
  comment TEXT NULL,
  document_path VARCHAR(1024) NULL,
  document_type VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_student_action_record_openid (`_openid`),
  KEY idx_student_action_record_user_id (user_id),
  KEY idx_student_action_record_session (session_id),
  KEY idx_student_action_record_created_at (created_at)
) ENGINE=InnoDB COMMENT='学员动作评分摘要，原始IMU通过document_path引用';
