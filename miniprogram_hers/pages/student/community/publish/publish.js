const USER_COLLECTION = 'users';
const MAX_IMAGE_COUNT = 9;
const MAX_UPLOAD_RETRY = 3;
const MAX_VIDEO_SIZE_MB = 50;
const MAX_VIDEO_SIZE = MAX_VIDEO_SIZE_MB * 1024 * 1024;
const PUBLISH_MODE_VIDEO = 'video';

Page({
  data: {
    publishMode: 'video',
    isVideoMode: true,
    title: '',
    tag: '视频',
    content: '',
    contentLength: 0,
    images: [],
    video: null,
    submitting: false,
    studentAuthor: {
      name: '学员',
      avatarUrl: ''
    }
  },

  onLoad() {
    const isVideoMode = true;
    this.setData({
      publishMode: PUBLISH_MODE_VIDEO,
      isVideoMode,
      tag: '视频'
    });
    if (typeof wx.setNavigationBarTitle === 'function') {
      wx.setNavigationBarTitle({
        title: '发布视频'
      });
    }
    this.loadStudentAuthor();
  },

  getCurrentUserId() {
    const localUserInfo = wx.getStorageSync('userInfo') || {};
    return localUserInfo.id || localUserInfo._id || '';
  },

  normalizeAvatarUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }
    const lower = raw.toLowerCase();
    if (lower === 'none' || lower === 'null' || lower === 'undefined') {
      return '';
    }
    if (
      lower.includes('/__tmp__/')
      || lower.startsWith('http://127.0.0.1')
      || lower.startsWith('wxfile://')
      || lower.startsWith('file://')
      || lower.startsWith('blob:')
    ) {
      return '';
    }
    return raw;
  },

  loadStudentAuthor() {
    const localUserInfo = wx.getStorageSync('userInfo') || {};
    const localName = localUserInfo.name || localUserInfo.nickName || '';
    const localAvatar = this.normalizeAvatarUrl(localUserInfo.avatarUrl);

    if (localName) {
      this.setData({
        studentAuthor: {
          name: localName,
          avatarUrl: localAvatar
        }
      });
      return;
    }

    if (!wx.cloud) {
      return;
    }

    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true
    });

    const db = wx.cloud.database();
    db.collection(USER_COLLECTION)
      .where({ role: 'student' })
      .limit(1)
      .get()
      .then((res) => {
        const list = res && res.data ? res.data : [];
        if (!list.length) {
          return;
        }
        const item = list[0] || {};
        this.setData({
          studentAuthor: {
            name: item.name || '学员',
            avatarUrl: this.normalizeAvatarUrl(item.avatarUrl)
          }
        });
      })
      .catch(() => {});
  },

  bindTitleInput(e) {
    this.setData({ title: e.detail.value || '' });
  },

  bindTagInput(e) {
    this.setData({ tag: e.detail.value || '' });
  },

  bindContentInput(e) {
    const value = e.detail.value || '';
    this.setData({
      content: value,
      contentLength: value.length
    });
  },

  chooseImages() {
    const current = this.data.images || [];
    const remain = MAX_IMAGE_COUNT - current.length;
    if (remain <= 0) {
      wx.showToast({ title: `最多上传${MAX_IMAGE_COUNT}张图片`, icon: 'none' });
      return;
    }

    wx.chooseImage({
      count: Math.min(9, remain),
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const selected = res && res.tempFilePaths ? res.tempFilePaths : [];
        const nextImages = current.concat(selected).slice(0, MAX_IMAGE_COUNT);
        this.setData({ images: nextImages });
      }
    });
  },

  removeImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isNaN(index)) {
      return;
    }
    const nextImages = (this.data.images || []).filter((_, i) => i !== index);
    this.setData({ images: nextImages });
  },

  handleSelectedImageError(e) {
    const index = Number(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.index : NaN);
    if (Number.isNaN(index)) {
      return;
    }
    const nextImages = (this.data.images || []).filter((_, i) => i !== index);
    this.setData({ images: nextImages });
  },

  previewSelectedImage(e) {
    const index = Number(e.currentTarget.dataset.index) || 0;
    const images = this.data.images || [];
    if (!images.length) {
      return;
    }
    wx.previewImage({
      current: images[index] || images[0],
      urls: images
    });
  },

  normalizePreviewPoster(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }
    const lower = raw.toLowerCase();
    if (lower.includes('/__tmp__/') || lower.startsWith('http://127.0.0.1')) {
      return '';
    }
    return raw;
  },

  applySelectedVideo(raw) {
    const safe = raw && typeof raw === 'object' ? raw : {};
    const tempFilePath = String(safe.tempFilePath || '').trim();
    const posterLocalPath = this.normalizePreviewPoster(String(
      safe.poster
      || safe.thumbTempFilePath
      || safe.thumbPath
      || ''
    ).trim());
    const poster = /^https?:\/\//i.test(posterLocalPath) ? posterLocalPath : '';
    const size = Number(safe.size || 0);
    if (!tempFilePath) {
      wx.showToast({ title: '视频读取失败，请重试', icon: 'none' });
      return;
    }
    if (size > MAX_VIDEO_SIZE) {
      wx.showToast({ title: `视频请控制在${MAX_VIDEO_SIZE_MB}MB内`, icon: 'none' });
      return;
    }
    this.setData({
      video: {
        tempFilePath,
        poster,
        posterLocalPath,
        sourceType: String(safe.sourceType || '').trim(),
        fileName: String(safe.fileName || '').trim(),
        duration: Number(safe.duration || 0),
        size,
        width: Number(safe.width || 0),
        height: Number(safe.height || 0)
      }
    });
  },

  handleChooseVideoFail(error) {
    const msg = String((error && error.errMsg) || '').toLowerCase();
    if (msg.includes('cancel')) {
      return;
    }
    if (msg.includes('auth deny') || msg.includes('auth denied') || msg.includes('permission')) {
      wx.showModal({
        title: '权限不足',
        content: '请在设置中开启相册和相机权限后重试',
        confirmText: '去设置',
        success: (res) => {
          if (res && res.confirm && typeof wx.openSetting === 'function') {
            wx.openSetting({});
          }
        }
      });
      return;
    }
    if (msg.includes('not support') || msg.includes('not supported') || msg.includes('invalid api')) {
      wx.showToast({ title: '当前环境不支持选视频，请真机重试', icon: 'none' });
      return;
    }
    try {
      const info = wx.getSystemInfoSync();
      if (String(info.platform || '').toLowerCase() === 'devtools') {
        wx.showToast({ title: '开发者工具可能受限，请真机测试', icon: 'none' });
        return;
      }
    } catch (e) {}
    wx.showToast({ title: '添加视频失败', icon: 'none' });
  },

  isDevtools() {
    try {
      const info = wx.getSystemInfoSync();
      return String(info && info.platform ? info.platform : '').toLowerCase() === 'devtools';
    } catch (e) {
      return false;
    }
  },

  chooseVideoByMessageFile() {
    if (typeof wx.chooseMessageFile !== 'function') {
      this.handleChooseVideoFail({ errMsg: 'chooseMessageFile:fail not supported' });
      return;
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'],
      success: (res) => {
        const files = Array.isArray(res && res.tempFiles) ? res.tempFiles : [];
        const first = files[0] || {};
        const tempFilePath = String(first.path || first.tempFilePath || '').trim();
        if (!tempFilePath) {
          this.handleChooseVideoFail({ errMsg: 'chooseMessageFile:fail no video file path' });
          return;
        }
        this.normalizeSelectedVideoPath(tempFilePath).then((previewPath) => {
          this.applySelectedVideo({
            tempFilePath: previewPath,
            sourceType: 'message-file',
            fileName: String(first.name || '').trim(),
            size: first.size || 0,
            duration: 0,
            width: 0,
            height: 0
          });
          wx.showToast({ title: '已导入本地视频', icon: 'none' });
        });
      },
      fail: (error) => {
        console.error('chooseMessageFile(video) failed:', error);
        this.handleChooseVideoFail(error);
      }
    });
  },

  normalizeSelectedVideoPath(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) {
      return Promise.resolve('');
    }
    const isAbsoluteWindowsPath = /^([a-z]:\\|\\\\)/i.test(raw);
    if (!isAbsoluteWindowsPath) {
      return Promise.resolve(raw);
    }
    if (typeof wx.getFileSystemManager !== 'function' || !wx.env || !wx.env.USER_DATA_PATH) {
      return Promise.resolve(raw);
    }

    const fs = wx.getFileSystemManager();
    const ext = this.getFileExt(raw, 'mp4');
    const targetPath = `${wx.env.USER_DATA_PATH}/community_preview_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
    return new Promise((resolve) => {
      fs.copyFile({
        srcPath: raw,
        destPath: targetPath,
        success: () => resolve(targetPath),
        fail: () => resolve(raw)
      });
    });
  },

  chooseVideoByLegacy(allowFallback) {
    wx.chooseVideo({
      sourceType: ['album', 'camera'],
      compressed: true,
      maxDuration: 120,
      success: (res) => {
        this.applySelectedVideo({
          tempFilePath: res.tempFilePath,
          sourceType: 'choose-video',
          poster: res.thumbTempFilePath || '',
          duration: res.duration,
          size: res.size,
          width: res.width,
          height: res.height
        });
      },
      fail: (error) => {
        const msg = String((error && error.errMsg) || '').toLowerCase();
        if ((msg.includes('not support') || msg.includes('invalid api')) && allowFallback !== false) {
          this.chooseVideoByMedia(false);
          return;
        }
        if (!msg.includes('cancel') && allowFallback !== false && typeof wx.chooseMedia === 'function') {
          this.chooseVideoByMedia(false);
          return;
        }
        console.error('chooseVideo failed:', error);
        this.handleChooseVideoFail(error);
      }
    });
  },

  chooseVideoByMedia(allowFallback) {
    if (typeof wx.chooseMedia !== 'function') {
      if (allowFallback !== false && typeof wx.chooseVideo === 'function') {
        this.chooseVideoByLegacy(false);
        return;
      }
      this.handleChooseVideoFail({ errMsg: 'chooseMedia:fail not supported' });
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      maxDuration: 120,
      sizeType: ['compressed'],
      success: (res) => {
        const files = Array.isArray(res && res.tempFiles) ? res.tempFiles : [];
        const first = files[0] || {};
        const tempFilePath = String(first.tempFilePath || first.filePath || first.path || '').trim();
        if (!tempFilePath) {
          this.handleChooseVideoFail({ errMsg: 'chooseMedia:fail no video file path' });
          return;
        }
        this.applySelectedVideo({
          tempFilePath,
          sourceType: 'choose-media',
          poster: first.thumbTempFilePath || '',
          duration: first.duration,
          size: first.size,
          width: first.width,
          height: first.height
        });
      },
      fail: (error) => {
        const msg = String((error && error.errMsg) || '').toLowerCase();
        if ((msg.includes('not support') || msg.includes('invalid api')) && allowFallback !== false && typeof wx.chooseVideo === 'function') {
          this.chooseVideoByLegacy(false);
          return;
        }
        if (!msg.includes('cancel') && allowFallback !== false && typeof wx.chooseVideo === 'function') {
          this.chooseVideoByLegacy(false);
          return;
        }
        console.error('chooseMedia(video) failed:', error);
        this.handleChooseVideoFail(error);
      }
    });
  },

  chooseVideo() {
    if (this.isDevtools()) {
      this.chooseVideoByMessageFile();
      return;
    }
    if (typeof wx.chooseMedia === 'function') {
      this.chooseVideoByMedia(true);
      return;
    }
    if (typeof wx.chooseVideo === 'function') {
      this.chooseVideoByLegacy(true);
      return;
    }
    this.handleChooseVideoFail({ errMsg: 'chooseVideo:fail not supported' });
  },

  handlePreviewVideoError() {
    wx.showToast({ title: '组件预览失败，可点“系统预览”查看', icon: 'none' });
  },

  previewVideoBySystem() {
    const video = this.data.video || {};
    const url = String(video.tempFilePath || '').trim();
    if (!url) {
      wx.showToast({ title: '请先选择视频', icon: 'none' });
      return;
    }
    if (typeof wx.previewMedia !== 'function') {
      wx.showToast({ title: '当前环境不支持系统预览', icon: 'none' });
      return;
    }
    wx.previewMedia({
      sources: [{
        url,
        type: 'video'
      }]
    });
  },

  removeVideo() {
    this.setData({ video: null });
  },

  getFileExt(filePath, fallbackExt) {
    const match = String(filePath || '').match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    return match && match[1] ? match[1].toLowerCase() : fallbackExt;
  },

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  shouldRetryUpload(error) {
    const text = String(
      (error && (error.errMsg || error.message)) || error || ''
    ).toLowerCase();
    return (
      text.includes('network')
      || text.includes('socket')
      || text.includes('tls')
      || text.includes('timeout')
      || text.includes('disconnected')
    );
  },

  uploadFileToCloud(filePath, folder, fallbackExt, attempt) {
    const ext = this.getFileExt(filePath, fallbackExt);
    const cloudPath = `community/posts/${folder}/${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`;
    return wx.cloud.uploadFile({
      cloudPath,
      filePath
    })
      .then((res) => (res && res.fileID ? res.fileID : ''))
      .catch((error) => {
        const currentAttempt = Number(attempt || 1);
        if (currentAttempt < MAX_UPLOAD_RETRY && this.shouldRetryUpload(error)) {
          return this.sleep(400 * currentAttempt)
            .then(() => this.uploadFileToCloud(filePath, folder, fallbackExt, currentAttempt + 1));
        }
        throw error;
      });
  },

  uploadMediaFiles() {
    const images = Array.isArray(this.data.images) ? this.data.images : [];
    const video = this.data.video && this.data.video.tempFilePath ? this.data.video : null;

    const imageTasks = images.map((path) => this.uploadFileToCloud(path, 'images', 'jpg'));

    return Promise.all(imageTasks)
      .then((imageFileIDs) => {
        if (!video) {
          return {
            images: imageFileIDs.filter(Boolean),
            video: null
          };
        }
        const buildVideoPayload = (videoFileID, posterFileID) => {
          const safeVideoFileID = String(videoFileID || '').trim();
          if (!safeVideoFileID) {
            return null;
          }
          const payload = {
            fileID: safeVideoFileID,
            duration: video.duration || 0,
            size: video.size || 0,
            width: video.width || 0,
            height: video.height || 0
          };
          const safePosterFileID = String(posterFileID || '').trim();
          if (safePosterFileID) {
            payload.poster = safePosterFileID;
          }
          return payload;
        };

        return this.uploadFileToCloud(video.tempFilePath, 'videos', 'mp4')
          .catch((error) => {
            const message = String((error && (error.errMsg || error.message)) || '');
            throw new Error(`video_upload_failed:${message}`);
          })
          .then((videoFileID) => {
            const safeVideoFileID = String(videoFileID || '').trim();
            if (!safeVideoFileID) {
              return {
                images: imageFileIDs.filter(Boolean),
                video: null
              };
            }
            const posterPath = String(video.posterLocalPath || video.poster || '').trim();
            if (!posterPath) {
              return {
                images: imageFileIDs.filter(Boolean),
                video: buildVideoPayload(safeVideoFileID, '')
              };
            }
            return this.uploadFileToCloud(posterPath, 'video-posters', 'jpg')
              .catch(() => '')
              .then((posterFileID) => ({
                images: imageFileIDs.filter(Boolean),
                video: buildVideoPayload(safeVideoFileID, posterFileID)
              }));
          });
      });
  },

  validateForm() {
    const isVideoMode = !!this.data.isVideoMode;
    const title = (this.data.title || '').trim();
    const content = (this.data.content || '').trim();
    const hasImage = Array.isArray(this.data.images) && this.data.images.length > 0;
    const hasVideo = !!(this.data.video && this.data.video.tempFilePath);

    if (isVideoMode) {
      if (!title) {
        wx.showToast({ title: '请输入视频标题', icon: 'none' });
        return false;
      }
      if (title.length < 2) {
        wx.showToast({ title: '视频标题至少2个字', icon: 'none' });
        return false;
      }
      if (!hasVideo) {
        wx.showToast({ title: '请先添加视频', icon: 'none' });
        return false;
      }
      return true;
    }

    if (!title) {
      wx.showToast({ title: '请输入标题', icon: 'none' });
      return false;
    }
    if (title.length < 3) {
      wx.showToast({ title: '标题至少3个字', icon: 'none' });
      return false;
    }
    if (!content && !hasImage && !hasVideo) {
      wx.showToast({ title: '请输入内容或添加图片/视频', icon: 'none' });
      return false;
    }
    return true;
  },

  buildVideoPostTitle() {
    const now = new Date();
    const pad = (num) => String(num).padStart(2, '0');
    return `视频动态 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  },

  formatBlockedUntil(value) {
    if (!value) {
      return '';
    }
    const dateObj = new Date(value);
    if (Number.isNaN(dateObj.getTime())) {
      return String(value).slice(0, 16);
    }
    const pad = (num) => String(num).padStart(2, '0');
    return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
  },

  handleCreatePostFailure(result) {
    const message = String(result && result.message ? result.message : '');
    const isVideoMode = !!this.data.isVideoMode;
    const minTitle = isVideoMode ? 2 : 3;
    if (message.includes('community_blocked')) {
      const blockedUntil = this.formatBlockedUntil(result.blockedUntil);
      const remain = Number(result.remainingMinutes || 0);
      const detail = blockedUntil
        ? `你已被限制发布与评论，请在 ${blockedUntil} 后重试。`
        : `你已被限制发布与评论，请稍后重试（约${remain || 1}分钟）。`;
      wx.showModal({
        title: '发布受限',
        content: detail,
        showCancel: false
      });
      return;
    }
    if (message.includes('user_not_found')) {
      wx.showToast({ title: '账号信息异常，请重新登录', icon: 'none' });
      return;
    }
    if (message.includes('title_required')) {
      wx.showToast({ title: isVideoMode ? '请输入视频标题' : '请输入标题', icon: 'none' });
      return;
    }
    if (message.includes('title_too_short')) {
      wx.showToast({ title: `标题至少${minTitle}个字`, icon: 'none' });
      return;
    }
    if (message.includes('content_or_media_required')) {
      wx.showToast({ title: '请添加文字、图片或视频', icon: 'none' });
      return;
    }
    if (message.includes('video_required')) {
      wx.showToast({ title: '请先添加视频', icon: 'none' });
      return;
    }
    if (message.includes('post_disabled')) {
      wx.showToast({ title: '帖子功能已关闭，请发布视频', icon: 'none' });
      return;
    }
    if (message.includes('unsupported_type')) {
      wx.showToast({ title: '云函数未更新，请重新部署', icon: 'none' });
      return;
    }
    wx.showToast({ title: '发布失败，请稍后重试', icon: 'none' });
  },

  submitPost() {
    if (this.data.submitting) {
      return;
    }
    if (!this.validateForm()) {
      return;
    }
    if (!wx.cloud) {
      wx.showToast({ title: '当前基础库不支持云开发', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });

    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true
    });

    const isVideoMode = true;
    const inputTitle = this.data.title.trim();
    const title = inputTitle || this.buildVideoPostTitle();
    const content = this.data.content.trim();
    const tag = '视频';
    const userId = this.getCurrentUserId();

    this.uploadMediaFiles()
      .then((media) => wx.cloud.callFunction({
        name: 'quickstartFunctions',
        data: {
          type: 'createCommunityPost',
          userId,
          preferUserId: true,
          expectedRole: 'student',
          title,
          content,
          tag,
          images: [],
          video: media.video || null,
          postType: 'video'
        }
      }))
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          this.handleCreatePostFailure(result);
          return;
        }
        wx.showToast({ title: '发布成功', icon: 'success' });
        setTimeout(() => {
          wx.navigateBack();
        }, 500);
      })
      .catch((error) => {
        console.error('发布帖子失败:', error);
        const errorText = String((error && (error.errMsg || error.message)) || '').toLowerCase();
        if (errorText.includes('video_upload_failed') || errorText.includes('videos/')) {
          wx.showToast({ title: `视频上传失败，请控制在${MAX_VIDEO_SIZE_MB}MB内后重试`, icon: 'none' });
          return;
        }
        if (errorText.includes('uploadfile:fail') || errorText.includes('network')) {
          wx.showToast({ title: '上传失败，请检查网络后重试', icon: 'none' });
          return;
        }
        wx.showToast({ title: '发布失败，请稍后重试', icon: 'none' });
      })
      .finally(() => {
        this.setData({ submitting: false });
      });
  }
});



