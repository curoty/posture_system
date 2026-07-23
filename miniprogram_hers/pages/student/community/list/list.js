const COLLECTION_NAME = 'community_posts';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POST_FETCH = 30;
const MAX_POST_RENDER = 12;
const MEDIA_RESOLVE_BATCH_SIZE = 4;
const CATEGORY_CACHE_TTL_MS = 30 * 1000;
const { pickRandomAvatar, resolveAvatarSeed } = require('../../../../utils/avatar');
const { FEATURE_GATES } = require('../../../../utils/feature-gates');

Page({
  data: {
    posts: [],
    originalPosts: [],
    searchKeyword: '',
    activeTab: 'video',
    activeCategory: 'recommend',
    loading: false,
    loadError: '',
    currentUserId: '',
    deletingPostId: ''
  },

  onLoad() {
    // 婵☆偓绲鹃悧妤咁敃閸忓吋浜ゆ繛鎴灻鍐裁归崗闂翠孩鐞氭繈鏌?onShow闂佹寧绋戦惌浣烘崲閺嶎厽鐓傞悘鐐靛亾閿熴儵姊婚崶锝呬壕闂備焦褰冪粔鎾囬懠顒佸珰闂佸灝顑囧﹢?
    this._previewLocalCache = {};
    this._categoryPostCache = {};
  },

  onShow() {
    this.setData({ currentUserId: this.getCurrentUserId() });
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 1
      });
    }
    this.loadPosts();
  },

  onPullDownRefresh() {
    this.loadPosts(true);
  },

  loadPosts(isPullDown) {
    const cacheKey = this.getCommunityCacheKey();
    const cached = !isPullDown && this._categoryPostCache && this._categoryPostCache[cacheKey];
    const cacheFresh = cached && Date.now() - Number(cached.cachedAt || 0) < CATEGORY_CACHE_TTL_MS;
    if (cacheFresh) {
      this.setData({
        originalPosts: Array.isArray(cached.posts) ? cached.posts : [],
        loading: false,
        loadError: ''
      });
      this.searchPosts();
      return;
    }
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
        loadError: 'Cloud is not available'
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

    this.fetchCommunityPostsFromCloud()
      .catch(() => {
        const db = wx.cloud.database();
        return this.fetchAllPosts(db, true)
          .catch(() => this.fetchAllPosts(db, false));
      })
      .then((docs) => {
        const normalized = (docs || []).map((item) => this.normalizePost(item));
        const deduped = this.dedupeWelcomePosts(normalized);
        const sorted = deduped.slice(0, MAX_POST_RENDER);
        return this.resolvePreviewImages(sorted);
      })
      .then((list) => {
        const safeList = Array.isArray(list) ? list : [];
        if (!this._categoryPostCache) {
          this._categoryPostCache = {};
        }
        this._categoryPostCache[cacheKey] = {
          posts: safeList,
          cachedAt: Date.now()
        };
        this.setData({
          originalPosts: safeList
        });
        this.searchPosts();
      })
      .catch((error) => {
        console.error('load community posts failed:', error);
        this.setData({
          originalPosts: [],
          loadError: 'Load posts failed, retry later'
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

  getCommunityCacheKey() {
    return [
      this.data.activeCategory || 'recommend',
      String(this.data.searchKeyword || '').trim().toLowerCase()
    ].join('|');
  },

  fetchCommunityPostsFromCloud() {
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'listCommunityPosts',
        category: this.data.activeCategory || 'recommend',
        keyword: this.data.searchKeyword || '',
        limit: MAX_POST_RENDER
      }
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        throw new Error(String(result.message || 'list_community_posts_failed'));
      }
      return Array.isArray(result.posts) ? result.posts : [];
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
      if (!safeUrl) {
        return Promise.resolve('');
      }
      if (isBlockedLegacyMediaUrl(safeUrl)) {
        return Promise.reject(new Error('legacy_tcb_proxy_blocked'));
      }
      // Use CDN temp URL directly to avoid heavy local downloading in list rendering.
      return Promise.resolve(safeUrl);
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
      }, `${authorName}_${String(safePost._id || safePost.id || '')}`));
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

    const durationText = this.resolveDurationText(safePost);

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
      durationText,
      isVideoOnlyPost
    };
  },

  resolveDurationText(post) {
    const safe = post || {};
    const rawVideo = safe.video && typeof safe.video === 'object' ? safe.video : {};
    const durationValue = Number(
      rawVideo.duration
      || safe.duration
      || safe.videoDuration
      || 0
    );
    if (durationValue > 0) {
      const total = Math.max(1, Math.round(durationValue));
      const minutes = String(Math.floor(total / 60)).padStart(2, '0');
      const seconds = String(total % 60).padStart(2, '0');
      return `${minutes}:${seconds}`;
    }
    return '';
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

  goToAiAnalyze(e) {
    if (!FEATURE_GATES.communityAiActionAnalyzeEnabled) {
      wx.showToast({
        title: FEATURE_GATES.communityAiActionAnalyzeLockMessage || '社区 AI 动作分析暂未开放',
        icon: 'none'
      });
      return;
    }
    const fileId = String(e.currentTarget.dataset.fileId || '').trim();
    const videoSrc = String(e.currentTarget.dataset.videoSrc || '').trim();
    const safeFileId = this.resolveAnalyzeCloudFileId(fileId);
    const safeVideoSrc = this.isLocalVideoPath(videoSrc) ? videoSrc : '';
    if (!safeFileId && !safeVideoSrc) {
      wx.showToast({ title: 'Invalid video source, retry later', icon: 'none' });
      return;
    }
    const query = ['from=community_video_list'];
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
      const isWelcomePost = title === 'welcome to roller skating community';
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
    this.loadPosts();
  },

  switchTab(e) {
    const tab = String(e.currentTarget.dataset.tab || '').trim();
    if (!tab || tab === this.data.activeTab) {
      return;
    }
    this.setData({ activeTab: tab });
    this.searchPosts();
  },

  switchCategory(e) {
    const category = String(e.currentTarget.dataset.category || '').trim();
    if (!category || category === this.data.activeCategory) {
      return;
    }
    this.setData({ activeCategory: category });
    this.loadPosts();
  },

  searchPosts() {
    const { searchKeyword, originalPosts, activeCategory } = this.data;
    const keyword = (searchKeyword || '').trim().toLowerCase();

    let filteredPosts = Array.isArray(originalPosts) ? originalPosts : [];
    filteredPosts = filteredPosts.filter((post) => !!(post && post.hasVideo));
    if (activeCategory === 'latest') {
      filteredPosts = filteredPosts.slice().sort((a, b) => (Number(b.createdTs) || 0) - (Number(a.createdTs) || 0));
    }
    if (keyword) {
      filteredPosts = filteredPosts.filter((post) => (
        (post.title || '').toLowerCase().includes(keyword)
        || (post.content || '').toLowerCase().includes(keyword)
        || (post.author && post.author.name ? post.author.name.toLowerCase().includes(keyword) : false)
        || (post.tag || '').toLowerCase().includes(keyword)
      ));
    }

    this.setData({ posts: filteredPosts });
  },

  addPost() {
    wx.navigateTo({
      url: '/pages/student/community/publish/publish?mode=video'
    });
  },

  getCurrentUserId() {
    const localUserInfo = wx.getStorageSync('userInfo') || {};
    return String(localUserInfo.id || localUserInfo._id || '').trim();
  },

  isAdminAccount() {
    const localUserInfo = wx.getStorageSync('userInfo') || {};
    const role = String(localUserInfo.role || '').trim().toLowerCase();
    const storedRole = String(wx.getStorageSync('userRole') || '').toLowerCase();
    return role === 'admin' || storedRole === 'admin';
  },

  canDeletePost(item) {
    if (!item || !this.data.currentUserId) return false;
    if (this.isAdminAccount()) return true;
    return item.uploaderId && item.uploaderId === this.data.currentUserId;
  },

  onDeletePost(e) {
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
        this.doDeletePost(postId, postTitle);
      }
    });
  },

  doDeletePost(postId, postTitle) {
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
            this.removePostFromList(postId);
          } else {
            wx.showToast({ title: '删除失败，请重试', icon: 'none' });
          }
          return;
        }
        this.removePostFromList(postId);
        wx.showToast({ title: '已删除', icon: 'success' });
      })
      .catch(() => {
        wx.showToast({ title: '删除失败，请重试', icon: 'none' });
      })
      .finally(() => {
        this.setData({ deletingPostId: '' });
      });
  },

  removePostFromList(postId) {
    const filterFn = (list) => (list || []).filter((item) => item.id !== postId);
    this.setData({
      originalPosts: filterFn(this.data.originalPosts),
      posts: filterFn(this.data.posts)
    });
  }
});





