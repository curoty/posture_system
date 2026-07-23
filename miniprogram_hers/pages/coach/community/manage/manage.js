const COLLECTION_NAME = 'community_posts';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POST_FETCH = 60;
const MEDIA_RESOLVE_BATCH_SIZE = 4;
const { pickRandomAvatar, resolveAvatarSeed } = require('../../../../utils/avatar');
const { normalizeRoleToken } = require('../../../../utils/permission');
const { FEATURE_GATES } = require('../../../../utils/feature-gates');

Page({
  data: {
    posts: [],
    originalPosts: [],
    searchKeyword: '',
    activeTab: 'video',
    isAdmin: false,
    moderating: false,
    unreadNotificationCount: 0,
    loading: false,
    loadError: '',
    currentUserId: '',
    deletingPostId: ''
  },

  ensureCommunityManageEnabled() {
    if (FEATURE_GATES.coachCommunityManageEnabled !== false) {
      return true;
    }
    wx.showToast({
      title: FEATURE_GATES.coachCommunityManageLockMessage || '社区内容管理功能维护中，暂未开放',
      icon: 'none'
    });
    const fallbackUrl = '/pages/coach/index/index';
    setTimeout(() => {
      wx.switchTab({
        url: fallbackUrl,
        fail: () => {
          wx.reLaunch({ url: fallbackUrl });
        }
      });
    }, 220);
    return false;
  },

  onLoad() {
    if (!this.ensureCommunityManageEnabled()) {
      return;
    }
    const runtimeRole = this.resolveRuntimeRole();
    if (runtimeRole === 'admin' || runtimeRole === 'coach') {
      wx.setStorageSync('userRole', runtimeRole);
    }
    // 缓存预览图临时地址，避免 onShow 时闪烁
    this._previewLocalCache = {};
  },

  onShow() {
    if (!this.ensureCommunityManageEnabled()) {
      return;
    }
    const runtimeRole = this.resolveRuntimeRole();
    const selectedIndex = runtimeRole === 'admin' ? 1 : 2;
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setTabBarList();
      this.getTabBar().setData({
        selected: selectedIndex
      });
    }

    this.setData({
      isAdmin: this.isAdminAccount(),
      currentUserId: this.getCurrentUserId()
    });
    this.loadPosts();
    this.loadUnreadNotificationCount();
  },

  onPullDownRefresh() {
    this.loadPosts(true);
  },

  resolveRuntimeRole() {
    const localUserInfo = wx.getStorageSync('userInfo') || {};
    const accountRole = normalizeRoleToken(wx.getStorageSync('accountRole'));
    const profileRole = normalizeRoleToken(localUserInfo.role);
    const storedRole = normalizeRoleToken(wx.getStorageSync('userRole'));
    return accountRole || profileRole || storedRole || '';
  },

  isAdminAccount() {
    return this.resolveRuntimeRole() === 'admin';
  },

  loadPosts(isPullDown) {
    if (this._isLoadingPosts) {
      if (isPullDown) {
        wx.stopPullDownRefresh();
      }
      return;
    }
    this._isLoadingPosts = true;

    if (!wx.cloud) {
      this.setData({
        loading: false,
        loadError: '当前基础库不支持云开发'
      });
      this._isLoadingPosts = false;
      if (isPullDown) {
        wx.stopPullDownRefresh();
      }
      return;
    }

    this.setData({
      loading: true,
      loadError: ''
    });

    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true
    });

    const db = wx.cloud.database();
    this.fetchAllPosts(db, true)
      .catch(() => this.fetchAllPosts(db, false))
      .then((docs) => {
        const normalized = (docs || []).map((item) => this.normalizePost(item));
        const deduped = this.dedupeWelcomePosts(normalized);
        return this.resolvePreviewImages(this.sortPosts(deduped))
          .then((list) => this.resolveVideoSources(list));
      })
      .then((list) => {
        this.setData({
          originalPosts: Array.isArray(list) ? list : []
        });
        this.searchPosts();
      })
      .catch((error) => {
        console.error('load posts failed:', error);
        this.setData({
          originalPosts: [],
          loadError: '加载帖子失败，请稍后重试'
        });
        this.searchPosts();
      })
      .finally(() => {
        this.setData({ loading: false });
        this._isLoadingPosts = false;
        if (isPullDown) {
          wx.stopPullDownRefresh();
        }
      });
  },

  fetchAllPosts(db, useOrderBy, skip, list) {
    const currentSkip = typeof skip === 'number' ? skip : 0;
    const currentList = Array.isArray(list) ? list : [];
    const pageSize = 20;

    let query = db.collection(COLLECTION_NAME).where({ status: 'active' });
    if (useOrderBy) {
      query = query.orderBy('createdAt', 'desc');
    }

    return query
      .skip(currentSkip)
      .limit(pageSize)
      .get()
      .then((res) => {
        const data = res && res.data ? res.data : [];
        const merged = currentList.concat(data);
        const canContinue = data.length === pageSize && merged.length < MAX_POST_FETCH;
        if (!canContinue) {
          return merged;
        }
        return this.fetchAllPosts(db, useOrderBy, currentSkip + data.length, merged);
      });
  },

  mapInBatches(source, mapper, batchSize) {
    const list = Array.isArray(source) ? source : [];
    if (!list.length) {
      return Promise.resolve([]);
    }
    const size = Math.max(1, Number(batchSize) || 1);
    const result = [];
    let cursor = 0;

    const runNext = () => {
      if (cursor >= list.length) {
        return Promise.resolve(result);
      }
      const batch = list.slice(cursor, cursor + size);
      cursor += size;
      return Promise.all(batch.map((item) => mapper(item).catch(() => item)))
        .then((mapped) => {
          result.push(...mapped);
          return runNext();
        });
    };

    return runNext();
  },

  getCommentCount(post) {
    if (!post || typeof post !== 'object') {
      return 0;
    }
    if (typeof post.commentCount === 'number') {
      return post.commentCount;
    }
    if (typeof post.comments === 'number') {
      return post.comments;
    }

    const countWithReplies = (list) => list.reduce((sum, item) => {
      const replyLen = Array.isArray(item && item.replies) ? item.replies.length : 0;
      return sum + 1 + replyLen;
    }, 0);

    if (Array.isArray(post.commentList)) {
      return countWithReplies(post.commentList);
    }
    if (Array.isArray(post.comments)) {
      return countWithReplies(post.comments);
    }
    return 0;
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

  parseLegacyTcbUrl(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^https?:\/\/([^/]+)\.tcb\.qcloud\.(?:la|com)\/(.+)$/i);
    if (!match) {
      return null;
    }
    const bucket = String(match[1] || '').trim();
    const filePath = String(match[2] || '')
      .replace(/^\/+/, '')
      .replace(/[?#].*$/, '')
      .trim();
    if (!bucket || !filePath) {
      return null;
    }
    return { bucket, filePath };
  },

  normalizePreviewMediaRef(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }
    if (raw.startsWith('cloud://')) {
      return raw;
    }
    const candidates = this.buildCloudFileIdCandidates(raw);
    return candidates.length ? candidates[0] : '';
  },

  getCurrentEnvId() {
    const app = typeof getApp === 'function' ? getApp() : null;
    const env = app && app.globalData ? String(app.globalData.env || '').trim() : '';
    return env;
  },

  buildCloudFileIdCandidates(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return [];
    }
    if (raw.startsWith('cloud://')) {
      return [raw];
    }
    const legacy = this.parseLegacyTcbUrl(raw);
    if (!legacy) {
      return [raw];
    }

    const envFromApp = this.getCurrentEnvId();
    const envFromBucketMatch = legacy.bucket.match(/^[^-]+-([a-z0-9-]+)-\d+$/i);
    const envFromBucket = envFromBucketMatch && envFromBucketMatch[1]
      ? String(envFromBucketMatch[1]).trim()
      : '';
    const envCandidates = [];
    if (envFromApp) {
      envCandidates.push(envFromApp);
    }
    if (envFromBucket && !envCandidates.includes(envFromBucket)) {
      envCandidates.push(envFromBucket);
    }
    if (!envCandidates.length) {
      return [];
    }

    const bucketCandidates = [legacy.bucket];
    const firstDash = legacy.bucket.indexOf('-');
    if (firstDash > 0) {
      const stripped = legacy.bucket.slice(firstDash + 1);
      if (stripped && stripped !== legacy.bucket) {
        bucketCandidates.push(stripped);
      }
    }

    const unique = [];
    envCandidates.forEach((env) => {
      bucketCandidates.forEach((bucket) => {
        const item = `cloud://${env}.${bucket}/${legacy.filePath}`;
        if (!unique.includes(item)) {
          unique.push(item);
        }
      });
    });
    return unique;
  },

  resolveAnalyzeCloudFileId(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }
    const candidates = this.buildCloudFileIdCandidates(raw);
    if (!candidates.length) {
      return '';
    }
    const cloudCandidate = candidates.find((item) => String(item || '').trim().startsWith('cloud://'));
    return cloudCandidate ? String(cloudCandidate || '').trim() : '';
  },

  isLocalVideoPath(path) {
    const raw = String(path || '').trim().toLowerCase();
    if (!raw) {
      return false;
    }
    return raw.startsWith('wxfile://')
      || raw.startsWith('file://')
      || raw.startsWith('/')
      || /^[a-z]:\\/.test(raw);
  },

  resolvePreviewImageSource(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return Promise.resolve('');
    }
    const candidates = this.buildCloudFileIdCandidates(raw);
    if (!candidates.length) {
      return Promise.resolve('');
    }

    const legacy = !!this.parseLegacyTcbUrl(raw);
    const cache = this._previewLocalCache || {};
    const normalizePosterUrl = (url) => {
      const safeUrl = String(url || '').trim();
      if (!safeUrl) {
        return '';
      }
      if (!/^https?:\/\//i.test(safeUrl)) {
        return '';
      }
      return safeUrl;
    };
    const resolveByTempUrl = (fileID) => {
      if (!wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') {
        return Promise.reject(new Error('get_temp_url_not_supported'));
      }
      return wx.cloud.getTempFileURL({ fileList: [fileID] })
        .then((res) => {
          const list = res && Array.isArray(res.fileList) ? res.fileList : [];
          const first = list[0] || {};
          const tempUrl = String(first.tempFileURL || first.tempFileUrl || '').trim();
          if (!tempUrl) {
            throw new Error('temp_url_empty');
          }
          const posterUrl = normalizePosterUrl(tempUrl);
          if (!posterUrl) {
            throw new Error('temp_url_invalid_for_poster');
          }
          return posterUrl;
        });
    };
    const tryCandidate = (index) => {
      if (index >= candidates.length) {
        return Promise.resolve('');
      }

      const candidate = String(candidates[index] || '').trim();
      if (!candidate) {
        return tryCandidate(index + 1);
      }
      if (cache[candidate]) {
        const cachedUrl = normalizePosterUrl(cache[candidate]);
        if (cachedUrl) {
          return Promise.resolve(cachedUrl);
        }
      }
      if (!candidate.startsWith('cloud://')) {
        const directUrl = normalizePosterUrl(candidate);
        if (directUrl) {
          cache[candidate] = directUrl;
          this._previewLocalCache = cache;
          return Promise.resolve(directUrl);
        }
        return legacy ? tryCandidate(index + 1) : Promise.resolve('');
      }
      if (!wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') {
        return tryCandidate(index + 1);
      }

      return resolveByTempUrl(candidate)
        .then((res) => {
          const posterUrl = normalizePosterUrl(res);
          if (!posterUrl) {
            throw new Error('resolved_poster_invalid');
          }
          cache[candidate] = posterUrl;
          this._previewLocalCache = cache;
          return posterUrl;
        })
        .catch(() => tryCandidate(index + 1));
    };

    return tryCandidate(0);
  },

  resolvePreviewImages(posts) {
    const source = Array.isArray(posts) ? posts : [];
    if (!source.length) {
      return Promise.resolve([]);
    }

    return this.mapInBatches(source, (item) => {
      const ref = String(item && item.previewImage ? item.previewImage : '').trim();
      if (!ref) {
        return Promise.resolve(item);
      }
      return this.resolvePreviewImageSource(ref)
        .then((resolved) => ({
          ...item,
          previewImage: String(resolved || '').trim()
        }))
        .catch(() => ({
          ...item,
          previewImage: ''
        }));
    }, MEDIA_RESOLVE_BATCH_SIZE);
  },

  resolvePreviewImage(post) {
    const safePost = post || {};
    const rawVideo = safePost.video && typeof safePost.video === 'object' ? safePost.video : null;
    if (rawVideo) {
      const posterRef = String(
        rawVideo.poster
        || rawVideo.posterFileID
        || rawVideo.cover
        || rawVideo.thumb
        || ''
      ).trim();
      if (posterRef) {
        return this.normalizePreviewMediaRef(posterRef);
      }
    }

    const rawList = Array.isArray(safePost.images)
      ? safePost.images
      : (Array.isArray(safePost.imageList) ? safePost.imageList : []);
    if (!rawList.length) {
      return '';
    }
    const first = rawList[0];
    const ref = typeof first === 'string'
      ? first
      : (first && typeof first === 'object' ? (first.fileID || first.url || '') : '');
    return this.normalizePreviewMediaRef(ref);
  },

  resolveHasVideo(post) {
    const safePost = post || {};
    const video = safePost.video;
    if (!video) {
      return false;
    }
    if (typeof video === 'string') {
      return !!String(video).trim();
    }
    if (typeof video === 'object') {
      return !!String(video.fileID || video.url || '').trim();
    }
    return false;
  },

  resolveVideoFileId(post) {
    const safePost = post || {};
    const video = safePost.video;
    let raw = '';
    if (!video) {
      return '';
    }
    if (typeof video === 'string') {
      raw = String(video || '').trim();
    } else if (typeof video === 'object') {
      raw = String(video.fileID || video.url || '').trim();
    }
    if (!raw) {
      return '';
    }
    const candidates = this.buildCloudFileIdCandidates(raw);
    if (!candidates.length) {
      return this.parseLegacyTcbUrl(raw) ? '' : raw;
    }
    const first = String(candidates[0] || '').trim();
    if (/\.tcb\.qcloud\./i.test(first)) {
      return '';
    }
    return first;
  },

  resolveVideoSource(fileId) {
    const raw = String(fileId || '').trim();
    if (!raw) {
      return Promise.resolve('');
    }
    const candidates = this.buildCloudFileIdCandidates(raw);
    if (!candidates.length) {
      return Promise.resolve('');
    }
    const legacy = !!this.parseLegacyTcbUrl(raw);
    const isBlockedLegacyMediaUrl = (url) => /\.tcb\.qcloud\./i.test(String(url || '').trim());
    const downloadByHttpUrl = (url) => {
      const safeUrl = String(url || '').trim();
      if (isBlockedLegacyMediaUrl(safeUrl)) {
        return Promise.reject(new Error('legacy_tcb_proxy_blocked'));
      }
      if (!safeUrl || typeof wx.downloadFile !== 'function') {
        return Promise.reject(new Error('download_url_not_supported'));
      }
      return new Promise((resolve, reject) => {
        wx.downloadFile({
          url: safeUrl,
          success: (res) => {
            const statusCode = Number(res && res.statusCode);
            const tempFilePath = String(res && res.tempFilePath ? res.tempFilePath : '').trim();
            if (statusCode >= 200 && statusCode < 300 && tempFilePath) {
              resolve(tempFilePath);
              return;
            }
            reject(new Error(`download_url_status_${statusCode || 0}`));
          },
          fail: (error) => reject(error)
        });
      });
    };
    const tryCandidate = (index) => {
      if (index >= candidates.length) {
        return Promise.resolve('');
      }
      const candidate = String(candidates[index] || '').trim();
      if (!candidate) {
        return tryCandidate(index + 1);
      }
      if (!candidate.startsWith('cloud://')) {
        if (/\.tcb\.qcloud\./i.test(candidate)) {
          return tryCandidate(index + 1);
        }
        if (/^https?:\/\//i.test(candidate)) {
          return downloadByHttpUrl(candidate)
            .then((localPath) => localPath || candidate)
            .catch(() => (legacy ? tryCandidate(index + 1) : candidate));
        }
        return legacy ? tryCandidate(index + 1) : Promise.resolve(candidate);
      }
      if (!wx.cloud) {
        return Promise.resolve('');
      }
      const downloadByCloudFile = () => {
        if (typeof wx.cloud.downloadFile !== 'function') {
          return Promise.reject(new Error('download_not_supported'));
        }
        return wx.cloud.downloadFile({ fileID: candidate })
          .then((res) => {
            const localPath = String(res && res.tempFilePath ? res.tempFilePath : '').trim();
            if (!localPath) {
              throw new Error('video_download_empty_path');
            }
            return localPath;
          });
      };
      if (typeof wx.cloud.getTempFileURL !== 'function') {
        return downloadByCloudFile().catch(() => tryCandidate(index + 1));
      }
      return wx.cloud.getTempFileURL({
        fileList: [candidate]
      })
        .then((res) => {
          const list = res && Array.isArray(res.fileList) ? res.fileList : [];
          const first = list[0] || {};
          const temp = String(first.tempFileURL || first.tempFileUrl || '').trim();
          if (!temp) {
            throw new Error('empty_video_temp_url');
          }
          return downloadByHttpUrl(temp).catch(() => {
            if (isBlockedLegacyMediaUrl(temp)) {
              throw new Error('legacy_tcb_proxy_blocked');
            }
            return temp;
          });
        })
        .catch(() => downloadByCloudFile().catch(() => tryCandidate(index + 1)));
    };
    return tryCandidate(0);
  },

  resolveVideoSources(posts) {
    const source = Array.isArray(posts) ? posts : [];
    if (!source.length) {
      return Promise.resolve([]);
    }
    return this.mapInBatches(source, (item) => {
      const videoFileId = String(item && item.videoFileId ? item.videoFileId : '').trim();
      if (!videoFileId) {
        return Promise.resolve(item);
      }
      return this.resolveVideoSource(videoFileId)
        .then((videoSrc) => ({
          ...item,
          videoSrc: String(videoSrc || '').trim()
        }))
        .catch(() => ({
          ...item,
          videoSrc: ''
        }));
    }, MEDIA_RESOLVE_BATCH_SIZE);
  },

  toTimestamp(value) {
    if (!value) {
      return NaN;
    }
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      return new Date(value.replace(/-/g, '/')).getTime();
    }
    if (value && typeof value.toDate === 'function') {
      return value.toDate().getTime();
    }
    if (value && typeof value._seconds === 'number') {
      return value._seconds * 1000;
    }
    return new Date(value).getTime();
  },

  normalizePost(post) {
    const safePost = post || {};
    const author = safePost.author && typeof safePost.author === 'object' ? safePost.author : {};
    const source = String(safePost.source || '').toLowerCase();
    const role = String(safePost.authorRole || '').toLowerCase();
    const isAdminPost = source === 'admin' || role === 'admin';
    const createdTs = this.toTimestamp(safePost.createdAt || safePost.time || safePost.createdTime);
    let pinUntilTs = this.toTimestamp(safePost.pinUntil);
    if (Number.isNaN(pinUntilTs) && isAdminPost && !Number.isNaN(createdTs)) {
      pinUntilTs = createdTs + ONE_DAY_MS;
    }
    const isPinned = !Number.isNaN(pinUntilTs) && pinUntilTs > Date.now();
    const authorName = isAdminPost
      ? '\u7ba1\u7406\u5458'
      : (author.name || safePost.authorName || '\u533f\u540d\u7528\u6237');
    const authorAvatar = this.normalizeAvatarUrl(author.avatarUrl)
      || this.normalizeAvatarUrl(safePost.authorAvatarUrl)
      || pickRandomAvatar(resolveAvatarSeed({
        _id: safePost.authorId || safePost.authorUserId || '',
        id: safePost._id || safePost.id || '',
        openid: safePost.authorOpenid || '',
        phone: safePost.authorPhone || '',
        name: authorName
      }, (authorName + '_' + String(safePost._id || safePost.id || ''))));
    const tag = isAdminPost ? '\u901a\u77e5' : (safePost.tag || '\u672a\u5206\u7c7b');
    const content = safePost.content || '';
    const videoFileId = this.resolveVideoFileId(safePost);
    const hasVideo = !!videoFileId;
    const postType = String(safePost.postType || '').trim().toLowerCase();
    const isVideoOnlyPost = postType === 'video'
      || (hasVideo && !String(content).trim());

    let uploaderType = String(safePost.uploader_type || safePost.authorRole || author.role || author.uploader_type || '').toLowerCase().trim();
    if (!uploaderType || (uploaderType !== 'coach' && uploaderType !== 'student')) {
      uploaderType = 'student';
    }

    return {
      id: safePost._id || safePost.id || '',
      uploaderId: String(safePost.uploaderId || safePost.authorId || safePost.authorUserId || safePost.userId || ''),
      title: safePost.title || '\u672a\u547d\u540d\u5e16\u5b50',
      content,
      author: {
        name: authorName,
        avatarUrl: authorAvatar,
        uploader_type: uploaderType
      },
      time: this.formatTime(safePost.createdAt || safePost.time || safePost.createdTime),
      createdTs,
      likes: safePost.likes || safePost.likeCount || 0,
      comments: this.getCommentCount(safePost),
      views: safePost.views || safePost.viewCount || 0,
      tag,
      isPinned,
      previewImage: this.resolvePreviewImage(safePost),
      hasVideo,
      videoFileId,
      videoSrc: '',
      isVideoOnlyPost
    };
  },

  handlePreviewImageError(e) {
    const id = String(e.currentTarget.dataset.id || '').trim();
    if (!id) {
      return;
    }
    const sanitize = (list) => (Array.isArray(list) ? list : []).map((item) => {
      if (!item || item.id !== id) {
        return item;
      }
      return {
        ...item,
        previewImage: ''
      };
    });
    this.setData({
      originalPosts: sanitize(this.data.originalPosts),
      posts: sanitize(this.data.posts)
    });
  },

  handleVideoError(e) {
    const id = String(e.currentTarget.dataset.id || '').trim();
    if (!id) {
      return;
    }
    const sanitize = (list) => (Array.isArray(list) ? list : []).map((item) => {
      if (!item || item.id !== id) {
        return item;
      }
      return {
        ...item,
        videoSrc: ''
      };
    });
    this.setData({
      originalPosts: sanitize(this.data.originalPosts),
      posts: sanitize(this.data.posts)
    });
  },

  goToAiAnalyze(e) {
    if (!FEATURE_GATES.communityAiActionAnalyzeEnabled) {
      wx.showToast({
        title: FEATURE_GATES.communityAiActionAnalyzeLockMessage || '社区AI动作分析暂未开放',
        icon: 'none'
      });
      return;
    }
    const fileId = String(e.currentTarget.dataset.fileId || '').trim();
    const videoSrc = String(e.currentTarget.dataset.videoSrc || '').trim();
    const safeFileId = this.resolveAnalyzeCloudFileId(fileId);
    const safeVideoSrc = this.isLocalVideoPath(videoSrc) ? videoSrc : '';
    if (!safeFileId && !safeVideoSrc) {
      wx.showToast({ title: '视频源无效，请稍后重试', icon: 'none' });
      return;
    }
    const query = ['from=community_manage_video_list', 'autoStart=1'];
    if (safeFileId) {
      query.push(`fileID=${encodeURIComponent(safeFileId)}`);
    }
    if (safeVideoSrc) {
      query.push(`videoUrl=${encodeURIComponent(safeVideoSrc)}`);
    }
    wx.navigateTo({
      url: `/pages/student/ai/analyze/analyze?${query.join('&')}`
    });
  },

  sortPosts(posts) {
    const list = Array.isArray(posts) ? posts.slice() : [];
    return list.sort((a, b) => {
      const aPinned = !!(a && a.isPinned);
      const bPinned = !!(b && b.isPinned);
      if (aPinned !== bPinned) {
        return aPinned ? -1 : 1;
      }
      const aTs = Number(a && a.createdTs) || 0;
      const bTs = Number(b && b.createdTs) || 0;
      return bTs - aTs;
    });
  },

  dedupeWelcomePosts(posts) {
    const list = Array.isArray(posts) ? posts : [];
    const seenWelcome = new Set();

    return list.filter((post) => {
      const title = String((post && post.title) || '').trim().toLowerCase();
      if (!title) {
        return true;
      }
      const isWelcomePost = title === 'welcome to roller skating community'
        || title === '欢迎来到轮滑社区';
      if (!isWelcomePost) {
        return true;
      }
      if (seenWelcome.has(title)) {
        return false;
      }
      seenWelcome.add(title);
      return true;
    });
  },

  formatTime(value) {
    if (!value) {
      return '-';
    }

    if (typeof value === 'string') {
      return value;
    }

    let dateObj = null;
    if (value instanceof Date) {
      dateObj = value;
    } else if (value && typeof value.toDate === 'function') {
      dateObj = value.toDate();
    } else {
      dateObj = new Date(value);
    }

    if (!dateObj || Number.isNaN(dateObj.getTime())) {
      return '-';
    }

    const pad = (num) => String(num).padStart(2, '0');
    const year = dateObj.getFullYear();
    const month = pad(dateObj.getMonth() + 1);
    const day = pad(dateObj.getDate());
    const hour = pad(dateObj.getHours());
    const minute = pad(dateObj.getMinutes());
    return `${year}-${month}-${day} ${hour}:${minute}`;
  },

  bindSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value || '' });
    this.searchPosts();
  },

  switchTab(e) {
    const tab = String(e.currentTarget.dataset.tab || '').trim();
    if (!tab || tab === this.data.activeTab) {
      return;
    }
    this.setData({ activeTab: tab });
    this.searchPosts();
  },

  searchPosts() {
    const { searchKeyword, originalPosts } = this.data;
    const keyword = (searchKeyword || '').trim().toLowerCase();

    let filteredPosts = Array.isArray(originalPosts) ? originalPosts : [];
    filteredPosts = filteredPosts.filter((post) => !!(post && post.hasVideo));
    if (keyword) {
      filteredPosts = filteredPosts.filter((post) => (
        (post.title || '').toLowerCase().includes(keyword)
        || (post.content || '').toLowerCase().includes(keyword)
        || (post.tag || '').toLowerCase().includes(keyword)
      ));
    }

    this.setData({ posts: this.sortPosts(filteredPosts) });
  },

  addPost() {
    wx.navigateTo({
      url: '/pages/coach/community/publish/publish?mode=video'
    });
  },

  loadUnreadNotificationCount() {
    if (!this.data.isAdmin) {
      this.setData({ unreadNotificationCount: 0 });
      return;
    }
    if (!wx.cloud) {
      this.setData({ unreadNotificationCount: 0 });
      return;
    }

    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true
    });

    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'getNotificationUnreadCount',
        userId: this.getCurrentUserId(),
        preferUserId: true,
        expectedRole: 'coach_or_admin',
        includeTypes: ['schedule_booking']
      }
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          this.setData({ unreadNotificationCount: 0 });
          return;
        }
        this.setData({
          unreadNotificationCount: Number(result.unreadCount || 0)
        });
      })
      .catch(() => {
        this.setData({ unreadNotificationCount: 0 });
      });
  },

  goToNotificationList() {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅管理员可查看', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: '/pages/notification/list/list?mode=coach'
    });
  },

  confirmModeratePost(e) {
    if (!this.data.isAdmin || this.data.moderating) {
      return;
    }
    const postId = String(e.currentTarget.dataset.id || '').trim();
    const postTitle = String(e.currentTarget.dataset.title || '').trim() || '该帖子';
    if (!postId) {
      wx.showToast({ title: '帖子不存在', icon: 'none' });
      return;
    }

    const reasons = ['色情低俗', '辱骂攻击', '广告引流', '恶意造谣', '政治敏感'];
    wx.showActionSheet({
      itemList: reasons,
      success: (res) => {
        const index = Number(res.tapIndex || 0);
        const reason = reasons[index] || reasons[0];
        this.moderatePost(postId, postTitle, reason);
      }
    });
  },

  moderatePost(postId, postTitle, reason) {
    if (!wx.cloud) {
      wx.showToast({ title: '当前基础库不支持云开发', icon: 'none' });
      return;
    }

    this.setData({ moderating: true });
    wx.showLoading({ title: '处理中...', mask: true });

    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true
    });

    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'moderateCommunityPost',
        userId: this.getCurrentUserId(),
        postId,
        reason: String(reason || '').trim() || '违规内容'
      }
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          const message = String(result.message || '');
          if (message === 'permission_denied') {
            wx.showToast({ title: '没有权限执行该操作', icon: 'none' });
            return;
          }
          if (message === 'admin_user_not_found' || message === 'user_not_found') {
            wx.showToast({ title: '登录态异常，请重新登录后再试', icon: 'none' });
            return;
          }
          if (message === 'post_not_found') {
            wx.showToast({ title: '帖子不存在，已为你刷新', icon: 'none' });
            this.loadPosts();
            return;
          }
          if (message === 'unsupported_type') {
            wx.showToast({ title: '请重新部署 quickstartFunctions', icon: 'none' });
            return;
          }
          wx.showToast({ title: '处理失败，请稍后重试', icon: 'none' });
          return;
        }

        const toastText = `已删除“${postTitle}”`;

        const nextPosts = (this.data.originalPosts || []).filter((item) => item.id !== postId);
        this.setData({
          originalPosts: nextPosts
        });
        this.searchPosts();
        wx.showToast({
          title: toastText,
          icon: 'none',
          duration: 2000
        });
      })
      .catch((error) => {
        console.error('moderate post failed:', error);
        wx.showToast({ title: '处理失败，请稍后重试', icon: 'none' });
      })
      .finally(() => {
        wx.hideLoading();
        this.setData({ moderating: false });
      });
  },

  getCurrentUserId() {
    const userInfo = wx.getStorageSync('userInfo') || {};
    return String(userInfo.id || userInfo._id || '').trim();
  },

  onDeleteCommunityPost(e) {
    const postId = String(e.currentTarget.dataset.id || '').trim();
    const postTitle = String(e.currentTarget.dataset.title || '').trim() || '该视频';
    if (!postId || this.data.deletingPostId) return;

    wx.showModal({
      title: '确认删除',
      content: `确定删除「${postTitle}」吗？删除后无法恢复。`,
      confirmText: '删除',
      confirmColor: '#f45b5b',
      success: (res) => {
        if (!res.confirm) return;
        this.doDeleteCommunityPost(postId, postTitle);
      }
    });
  },

  doDeleteCommunityPost(postId, postTitle) {
    if (!wx.cloud) {
      wx.showToast({ title: '当前不支持云开发', icon: 'none' });
      return;
    }

    this.setData({ deletingPostId: postId });

    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'deleteCommunityPost',
        userId: this.data.currentUserId,
        preferUserId: true,
        postId
      }
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          const msg = String(result.message || '');
          if (msg === 'permission_denied') {
            wx.showToast({ title: '无权删除此视频', icon: 'none' });
          } else if (msg === 'post_not_found') {
            wx.showToast({ title: '视频已不存在', icon: 'none' });
            this.removeCommunityPostFromList(postId);
          } else {
            wx.showToast({ title: '删除失败，请重试', icon: 'none' });
          }
          return;
        }
        this.removeCommunityPostFromList(postId);
        wx.showToast({ title: '已删除', icon: 'success' });
      })
      .catch(() => {
        wx.showToast({ title: '删除失败，请重试', icon: 'none' });
      })
      .finally(() => {
        this.setData({ deletingPostId: '' });
      });
  },

  removeCommunityPostFromList(postId) {
    const filterFn = (list) => (list || []).filter((item) => item.id !== postId);
    this.setData({
      originalPosts: filterFn(this.data.originalPosts),
      posts: filterFn(this.data.posts)
    });
  }
});






