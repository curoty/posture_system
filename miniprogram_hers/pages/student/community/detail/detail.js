const COLLECTION_NAME = 'community_posts';
const USER_COLLECTION = 'users';
const MAX_COMMENT_IMAGE_COUNT = 9;
const DEFAULT_VISIBLE_REPLY_COUNT = 2;
const MAX_DETAIL_COMMENT_COUNT = 30;
const MAX_DETAIL_REPLY_COUNT = 8;
const MAX_DETAIL_MEDIA_PER_ITEM = 4;
const MEDIA_RESOLVE_BATCH_SIZE = 4;
const POST_CARD_MEASURE_DELAY = 180;
const { pickRandomAvatar, resolveAvatarSeed } = require('../../../../utils/avatar');
const { FEATURE_GATES } = require('../../../../utils/feature-gates');

Page({
  data: {
    postId: '',
    post: {},
    postCardHeight: 0,
    windowHeightPx: 0,
    commentSectionTopPx: 260,
    commentSectionHeightPx: 420,
    comments: [],
    isLiked: false,
    likeUpdating: false,
    loading: false,
    loadError: '',
    commentText: '',
    commentImages: [],
    replyingCommentId: '',
    replyingToName: '',
    replyExpandedMap: {},
    canSubmitComment: false,
    submittingComment: false,
    aiAnalysis: null,
    aiAnalysisLoading: false,
    aiAnalysisError: '',
    aiAnalysisVideoKey: '',
    aiAnalysisExpanded: false
  },

  onLoad(options) {
    const postId = options.id || '';
    let windowHeightPx = 0;
    try {
      if (typeof wx.getWindowInfo === 'function') {
        const info = wx.getWindowInfo();
        windowHeightPx = info && info.windowHeight ? Number(info.windowHeight) : 0;
      } else {
        const info = wx.getSystemInfoSync();
        windowHeightPx = info && info.windowHeight ? Number(info.windowHeight) : 0;
      }
    } catch (e) {
      windowHeightPx = 0;
    }
    this._pageUnloaded = false;
    this._mediaLocalCache = {};
    this.setData({ postId, windowHeightPx });
    this.loadPostDetail(postId, false, true);
  },

  onPullDownRefresh() {
    this.loadPostDetail(this.data.postId, true, false);
  },

  onUnload() {
    this._pageUnloaded = true;
    if (this._postCardMeasureTimer) {
      clearTimeout(this._postCardMeasureTimer);
      this._postCardMeasureTimer = null;
    }
    if (this._postCardMeasureQueueTimer) {
      clearTimeout(this._postCardMeasureQueueTimer);
      this._postCardMeasureQueueTimer = null;
    }
  },

  loadPostDetail(postId, isPullDown, shouldTrackView) {
    this.setData({ loading: true, loadError: '' });

    if (!wx.cloud || !postId) {
      this.loadLocalPost(postId);
      this.clearAutoAiAnalyzeState();
      this.initLikeState(postId);
      this.refreshPostCardHeight();
      this.setData({ loading: false });
      if (isPullDown) {
        wx.stopPullDownRefresh();
      }
      return;
    }

    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true
    });

    const db = wx.cloud.database();
    db.collection(COLLECTION_NAME)
      .doc(postId)
      .get()
      .then((res) => {
        const doc = res && res.data ? res.data : null;
        if (!doc) {
          throw new Error('post_not_found');
        }
        const normalized = this.normalizeCloudPost(doc);
        const currentPostId = normalized.post.id || postId;
        return this.resolveNormalizedMedia(normalized)
          .catch(() => normalized)
          .then((resolved) => {
            const finalData = resolved || normalized;
            const commentList = this.applyReplyExpandState(finalData.comments);
            this.setData({
              post: finalData.post,
              comments: commentList
            });
            this.refreshPostCardHeight();
            this.initLikeState(currentPostId);
            if (shouldTrackView) {
              this.increasePostView(currentPostId);
            }
          });
      })
      .catch((error) => {
        console.error('load post detail failed:', error);
        this.loadLocalPost(postId);
        this.setData({
          loadError: 'Load post failed, please retry later'
        });
        this.clearAutoAiAnalyzeState();
        this.refreshPostCardHeight();
      })
      .finally(() => {
        this.setData({ loading: false });
        if (isPullDown) {
          wx.stopPullDownRefresh();
        }
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

  normalizeImageList(post) {
    if (!post || typeof post !== 'object') {
      return [];
    }
    const rawList = Array.isArray(post.images)
      ? post.images
      : (Array.isArray(post.imageList) ? post.imageList : []);

    if (!rawList.length) {
      return [];
    }

    return rawList
      .map((item) => {
        if (typeof item === 'string') {
          return this.normalizeCloudFileRef(item);
        }
        if (item && typeof item === 'object') {
          return this.normalizeCloudFileRef(item.fileID || item.url || '');
        }
        return '';
      })
      .filter(Boolean);
  },

  normalizeCloudFileRef(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }
    if (raw.startsWith('cloud://')) {
      return raw;
    }
    const legacy = this.parseLegacyTcbUrl(raw);
    const candidates = this.buildCloudFileIdCandidates(raw);
    if (!candidates.length) {
      return legacy ? '' : raw;
    }
    const first = String(candidates[0] || '').trim();
    if (/\.tcb\.qcloud\./i.test(first)) {
      return '';
    }
    return first;
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

    const app = getApp && getApp();
    const envFromApp = app && app.globalData ? String(app.globalData.env || '').trim() : '';
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

  resolveMediaRef(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return Promise.resolve('');
    }
    const candidates = this.buildCloudFileIdCandidates(raw);
    if (!candidates.length) {
      return Promise.resolve('');
    }

    const isLegacyTcb = !!this.parseLegacyTcbUrl(raw);
    const cache = this._mediaLocalCache || {};
    const isBlockedLegacyMediaUrl = (url) => /\.tcb\.qcloud\./i.test(String(url || '').trim());
    const useHttpUrl = (url) => {
      const safeUrl = String(url || '').trim();
      if (!safeUrl) {
        return Promise.resolve('');
      }
      if (isBlockedLegacyMediaUrl(safeUrl)) {
        return Promise.reject(new Error('legacy_tcb_proxy_blocked'));
      }
      // Use temp URL directly to avoid heavy local downloads on detail page.
      return Promise.resolve(safeUrl);
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
          return useHttpUrl(tempUrl).catch(() => {
            if (isBlockedLegacyMediaUrl(tempUrl)) {
              throw new Error('legacy_tcb_proxy_blocked');
            }
            return tempUrl;
          });
        });
    };
    const downloadByCloudFile = (fileID) => {
      if (!wx.cloud || typeof wx.cloud.downloadFile !== 'function') {
        return Promise.reject(new Error('download_cloud_not_supported'));
      }
      return wx.cloud.downloadFile({ fileID })
        .then((res) => {
          const localPath = String(res && res.tempFilePath ? res.tempFilePath : '').trim();
          if (!localPath) {
            throw new Error('download_empty_path');
          }
          return localPath;
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
        return Promise.resolve(cache[candidate]);
      }
      if (!candidate.startsWith('cloud://') || !wx.cloud) {
        if (/\.tcb\.qcloud\./i.test(candidate)) {
          return tryCandidate(index + 1);
        }
        if (/^https?:\/\//i.test(candidate)) {
          return useHttpUrl(candidate)
            .then((localPath) => localPath || candidate)
            .catch(() => (isLegacyTcb ? tryCandidate(index + 1) : candidate));
        }
        return isLegacyTcb ? tryCandidate(index + 1) : Promise.resolve(candidate);
      }

      return resolveByTempUrl(candidate)
        .catch(() => downloadByCloudFile(candidate))
        .then((res) => {
          const localPath = String(res && res.tempFilePath ? res.tempFilePath : '').trim();
          const mediaPath = localPath || String(res || '').trim();
          if (!mediaPath) {
            throw new Error('download_empty_path');
          }
          cache[candidate] = mediaPath;
          this._mediaLocalCache = cache;
          return mediaPath;
        })
        .catch(() => tryCandidate(index + 1));
    };

    return tryCandidate(0)
      .then((url) => {
        const finalUrl = String(url || '').trim();
        return finalUrl;
      });
  },

  resolveMediaList(list) {
    const source = Array.isArray(list) ? list : [];
    if (!source.length) {
      return Promise.resolve([]);
    }
    return this.mapInBatches(
      source,
      (item) => this.resolveMediaRef(item).catch(() => ''),
      MEDIA_RESOLVE_BATCH_SIZE
    ).then((urls) => urls.filter((item) => String(item || '').trim()));
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

  resolveCommentMedia(comment) {
    const safeComment = comment || {};
    const replies = Array.isArray(safeComment.replies) ? safeComment.replies : [];

    return Promise.all([
      this.resolveMediaList(safeComment.images),
      this.mapInBatches(
        replies,
        (reply) => this.resolveMediaList(reply && reply.images).then((replyImages) => ({
          ...(reply || {}),
          images: replyImages
        })),
        MEDIA_RESOLVE_BATCH_SIZE
      )
    ]).then(([images, nextReplies]) => ({
      ...safeComment,
      images,
      replies: nextReplies
    }));
  },

  resolveCommentMediaBatch(comments) {
    const source = Array.isArray(comments) ? comments : [];
    if (!source.length) {
      return Promise.resolve([]);
    }
    const batchSize = 6;
    const result = [];
    let cursor = 0;

    const runNext = () => {
      if (cursor >= source.length) {
        return Promise.resolve(result);
      }
      const batch = source.slice(cursor, cursor + batchSize);
      cursor += batchSize;
      return Promise.all(batch.map((comment) => this.resolveCommentMedia(comment).catch(() => comment)))
        .then((items) => {
          result.push(...items);
          return runNext();
        });
    };

    return runNext();
  },

  resolveNormalizedMedia(normalized) {
    const safe = normalized && typeof normalized === 'object' ? normalized : {};
    const post = safe.post && typeof safe.post === 'object' ? safe.post : {};
    const comments = Array.isArray(safe.comments) ? safe.comments : [];

    return Promise.all([
      this.resolveMediaList(post.images),
      this.resolveVideoMedia(post.video),
      this.resolveCommentMediaBatch(comments)
    ]).then(([postImages, postVideo, nextComments]) => ({
      post: {
        ...post,
        images: postImages,
        video: postVideo
      },
      comments: nextComments
    }));
  },

  normalizeVideo(post) {
    if (!post || typeof post !== 'object') {
      return null;
    }
    const rawVideo = post.video;
    if (!rawVideo) {
      return null;
    }
    if (typeof rawVideo === 'string') {
      return {
        fileID: rawVideo,
        src: ''
      };
    }
    if (typeof rawVideo === 'object') {
      const fileID = rawVideo.fileID || rawVideo.url || '';
      if (!fileID) {
        return null;
      }
      return {
        fileID,
        src: '',
        duration: rawVideo.duration || 0,
        size: rawVideo.size || 0,
        width: rawVideo.width || 0,
        height: rawVideo.height || 0
      };
    }
    return null;
  },

  resolveVideoMedia(video) {
    const safeVideo = video && typeof video === 'object' ? video : null;
    if (!safeVideo || !safeVideo.fileID) {
      return Promise.resolve(null);
    }

    const rawFile = String(safeVideo.fileID || safeVideo.src || '').trim();
    if (!rawFile) {
      return Promise.resolve(null);
    }

    const candidates = this.buildCloudFileIdCandidates(rawFile);
    if (!candidates.length) {
      return Promise.resolve(null);
    }

    const isBlockedLegacyMediaUrl = (url) => /\.tcb\.qcloud\./i.test(String(url || '').trim());
    const useHttpUrl = (url) => {
      const safeUrl = String(url || '').trim();
      if (!safeUrl) {
        return Promise.resolve('');
      }
      if (isBlockedLegacyMediaUrl(safeUrl)) {
        return Promise.reject(new Error('legacy_tcb_proxy_blocked'));
      }
      // Use temp URL directly to avoid blocking JS thread with downloadFile.
      return Promise.resolve(safeUrl);
    };
    const resolveByTempUrl = (fileID) => {
      if (!wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') {
        return Promise.reject(new Error('video_temp_url_not_supported'));
      }
      return wx.cloud.getTempFileURL({
        fileList: [fileID]
      })
        .then((res) => {
          const list = res && Array.isArray(res.fileList) ? res.fileList : [];
          const item = list[0] || {};
          const tempUrl = String(item.tempFileURL || item.tempFileUrl || '').trim();
          if (!tempUrl) {
            throw new Error('video_temp_url_empty');
          }
          return useHttpUrl(tempUrl).then((src) => ({
            ...safeVideo,
            fileID,
            src: String(src || tempUrl).trim()
          }));
        });
    };
    const downloadByCloudFile = (fileID) => {
      if (!wx.cloud || typeof wx.cloud.downloadFile !== 'function') {
        return Promise.reject(new Error('download_not_supported'));
      }
      return wx.cloud.downloadFile({ fileID })
        .then((res) => {
          const localPath = String(res && res.tempFilePath ? res.tempFilePath : '').trim();
          if (!localPath) {
            throw new Error('video_download_empty_path');
          }
          return {
            ...safeVideo,
            fileID,
            src: localPath
          };
        });
    };
    const tryCandidate = (index) => {
      if (index >= candidates.length) {
        return Promise.resolve(null);
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
          return useHttpUrl(candidate)
            .then((localPath) => ({
              ...safeVideo,
              fileID: candidate,
              src: String(localPath || candidate).trim()
            }))
            .catch(() => ({
              ...safeVideo,
              fileID: candidate,
              src: candidate
            }));
        }
        return Promise.resolve({
          ...safeVideo,
          fileID: candidate,
          src: candidate
        });
      }
      if (!wx.cloud) {
        return tryCandidate(index + 1);
      }
      return resolveByTempUrl(candidate)
        .catch(() => downloadByCloudFile(candidate))
        .catch(() => tryCandidate(index + 1));
    };

    return tryCandidate(0);
  },

  resolveAuthorName(authorValue, fallbackName) {
    if (typeof authorValue === 'string' && authorValue) {
      return authorValue;
    }
    if (authorValue && typeof authorValue === 'object') {
      return authorValue.name || authorValue.nickName || fallbackName;
    }
    return fallbackName;
  },

  normalizeReply(item, index, parentComment) {
    const safeItem = item || {};
    const authorName = this.resolveAuthorName(safeItem.author, safeItem.authorName || 'Anonymous');
    const replyTo = safeItem.replyTo && typeof safeItem.replyTo === 'object' ? safeItem.replyTo : {};
    const replyToName = String(
      replyTo.name
      || safeItem.replyToName
      || (parentComment && parentComment.author)
      || 'Anonymous'
    );

    return {
      id: safeItem.id || safeItem._id || `reply_${index + 1}`,
      parentCommentId: safeItem.parentCommentId || (parentComment && parentComment.id) || '',
      author: authorName,
      authorId: safeItem.authorId || '',
      authorOpenId: safeItem.authorOpenId || '',
      replyToName,
      time: this.formatTime(safeItem.createdAt || safeItem.time),
      content: safeItem.content || '',
      images: this.normalizeImageList(safeItem).slice(0, MAX_DETAIL_MEDIA_PER_ITEM)
    };
  },

  normalizeComment(item, index) {
    const safeItem = item || {};
    const authorName = this.resolveAuthorName(safeItem.author, safeItem.authorName || 'Anonymous');
    const rawReplies = Array.isArray(safeItem.replies) ? safeItem.replies : [];
    const limitedReplies = rawReplies.slice(0, MAX_DETAIL_REPLY_COUNT);
    const baseComment = {
      id: safeItem.id || safeItem._id || `comment_${index + 1}`,
      author: authorName,
      authorId: safeItem.authorId || '',
      authorOpenId: safeItem.authorOpenId || '',
      time: this.formatTime(safeItem.createdAt || safeItem.time),
      content: safeItem.content || '',
      images: this.normalizeImageList(safeItem).slice(0, MAX_DETAIL_MEDIA_PER_ITEM),
      replies: []
    };

    baseComment.replies = limitedReplies.map((reply, replyIndex) => this.normalizeReply(reply, replyIndex, baseComment));
    return baseComment;
  },

  applyReplyExpandState(comments, replyExpandedMap) {
    const sourceList = Array.isArray(comments) ? comments : [];
    const expandedMap = replyExpandedMap || this.data.replyExpandedMap || {};

    return sourceList.map((comment) => {
      const replies = Array.isArray(comment && comment.replies) ? comment.replies : [];
      const total = replies.length;
      const canExpandReplies = total > DEFAULT_VISIBLE_REPLY_COUNT;
      const isRepliesExpanded = canExpandReplies ? !!expandedMap[comment.id] : false;
      const displayReplies = canExpandReplies && !isRepliesExpanded
        ? replies.slice(0, DEFAULT_VISIBLE_REPLY_COUNT)
        : replies;

      return {
        ...comment,
        displayReplies,
        canExpandReplies,
        isRepliesExpanded,
        hiddenReplyCount: canExpandReplies ? Math.max(0, total - DEFAULT_VISIBLE_REPLY_COUNT) : 0
      };
    });
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

  normalizeCloudPost(doc) {
    const safeDoc = doc || {};
    const author = safeDoc.author && typeof safeDoc.author === 'object' ? safeDoc.author : {};
    const source = String(safeDoc.source || '').toLowerCase();
    const role = String(safeDoc.authorRole || '').toLowerCase();
    const isAdminPost = source === 'admin' || role === 'admin';
    const authorName = isAdminPost
      ? 'Admin'
      : (author.name || safeDoc.authorName || 'Anonymous');
    const authorAvatar = this.normalizeAvatarUrl(author.avatarUrl)
      || this.normalizeAvatarUrl(safeDoc.authorAvatarUrl)
      || pickRandomAvatar(resolveAvatarSeed({
        _id: safeDoc.authorId || safeDoc.authorUserId || '',
        id: safeDoc._id || safeDoc.id || '',
        openid: safeDoc.authorOpenid || '',
        phone: safeDoc.authorPhone || '',
        name: authorName
      }, (authorName + '_' + String(safeDoc._id || safeDoc.id || ''))));
    const rawComments = Array.isArray(safeDoc.commentList)
      ? safeDoc.commentList
      : (Array.isArray(safeDoc.comments) ? safeDoc.comments : []);
    const limitedComments = rawComments.slice(0, MAX_DETAIL_COMMENT_COUNT);

    return {
      post: {
        id: safeDoc._id || safeDoc.id || '',
        title: safeDoc.title || '\u672a\u547d\u540d\u5e16\u5b50',
        content: safeDoc.content || '',
        author: {
          name: authorName,
          avatarUrl: authorAvatar
        },
        authorRoleText: isAdminPost ? '官方' : '学员',
        time: this.formatTime(safeDoc.createdAt || safeDoc.time || safeDoc.createdTime),
        likes: safeDoc.likes || safeDoc.likeCount || 0,
        comments: this.getCommentCount(safeDoc),
        views: safeDoc.views || safeDoc.viewCount || 0,
        tag: isAdminPost ? '\u901a\u77e5' : (safeDoc.tag || '\u672a\u5206\u7c7b'),
        images: this.normalizeImageList(safeDoc).slice(0, MAX_DETAIL_MEDIA_PER_ITEM),
        video: this.normalizeVideo(safeDoc),
        durationText: this.formatVideoDuration(safeDoc)
      },
      comments: limitedComments.map((item, index) => this.normalizeComment(item, index))
    };
  },

  formatVideoDuration(post) {
    const safe = post || {};
    const rawVideo = safe.video && typeof safe.video === 'object' ? safe.video : {};
    const duration = Number(rawVideo.duration || safe.videoDuration || safe.duration || 0);
    if (!(duration > 0)) {
      return '';
    }
    const totalSeconds = Math.max(1, Math.round(duration));
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
  },

  clearAutoAiAnalyzeState() {
    this.setData({
      aiAnalysis: null,
      aiAnalysisLoading: false,
      aiAnalysisError: '',
      aiAnalysisVideoKey: '',
      aiAnalysisExpanded: false
    });
  },

  toggleAiAnalysisExpanded() {
    if (!this.data.aiAnalysis && !this.data.aiAnalysisLoading) {
      return;
    }
    this.setData({
      aiAnalysisExpanded: !this.data.aiAnalysisExpanded
    });
  },

  buildAutoAiSummaryByScore(score, weakestMetricName, strongestMetricName) {
    const safeScore = Number(score) || 0;
    const weakText = weakestMetricName ? `，当前短板在${weakestMetricName}` : '';
    const strongText = strongestMetricName ? `，优势项为${strongestMetricName}` : '';
    if (safeScore >= 85) {
      return `整体动作表现优秀${strongText}，可逐步提升动作难度。`;
    }
    if (safeScore >= 75) {
      return `整体动作表现良好${weakText}${strongText}，建议继续做针对性细化训练。`;
    }
    if (safeScore >= 60) {
      return `当前已具备基础动作能力${weakText}，建议先补齐薄弱环节再提速。`;
    }
    return `当前动作控制仍需加强${weakText}，建议先进行稳定性与重心控制训练。`;
  },

  buildAutoAiTipsByMetrics(metrics) {
    const adviceMap = {
      balance: '重心控制偏弱，建议做单脚滑行与重心转移练习。',
      stability: '动作稳定性不足，建议降速后做短距离重复滑行。',
      posture: '姿态控制待提升，注意上身微前倾并保持视线向前。',
      legDrive: '蹬伸发力不足，建议加强侧向伸展与回收动作。',
      rhythm: '节奏连贯性不足，建议配合节拍器做连续动作训练。'
    };
    const sorted = Array.isArray(metrics) ? metrics.slice().sort((a, b) => (a.score || 0) - (b.score || 0)) : [];
    const lowItems = sorted.filter((item) => Number(item.score) < 75).slice(0, 2);
    const tips = lowItems
      .map((item) => adviceMap[item.key] || `${item.name || '当前维度'}仍有提升空间，建议分解训练。`)
      .filter(Boolean);
    if (!tips.length) {
      return ['动作整体完成度较好，建议维持当前训练频率并逐步增加强度。'];
    }
    return tips;
  },

  normalizeStringList(value, limit) {
    const maxLen = Number(limit) > 0 ? Number(limit) : 5;
    return Array.isArray(value)
      ? value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, maxLen)
      : [];
  },

  normalizeAutoPhaseScores(value, metrics) {
    const phaseFromRaw = Array.isArray(value)
      ? value
        .map((item) => ({
          key: String(item && item.key ? item.key : '').trim(),
          name: String(item && item.name ? item.name : '').trim(),
          score: Math.max(0, Math.min(100, Number(item && item.score) || 0)),
          comment: String(item && item.comment ? item.comment : '').trim()
        }))
        .filter((item) => item.name)
        .slice(0, 3)
      : [];

    if (phaseFromRaw.length) {
      return phaseFromRaw;
    }
    if (!Array.isArray(metrics) || !metrics.length) {
      return [];
    }
    const scoreMap = {};
    metrics.forEach((item) => {
      scoreMap[item.key] = Number(item.score) || 0;
    });
    const warmup = Math.round((scoreMap.posture || 65) * 0.45 + (scoreMap.balance || 65) * 0.35 + (scoreMap.rhythm || 65) * 0.2);
    const execution = Math.round((scoreMap.legDrive || 65) * 0.45 + (scoreMap.stability || 65) * 0.35 + (scoreMap.balance || 65) * 0.2);
    const recovery = Math.round((scoreMap.stability || 65) * 0.4 + (scoreMap.posture || 65) * 0.35 + (scoreMap.rhythm || 65) * 0.25);
    return [
      {
        key: 'warmup',
        name: '起势与入动',
        score: Math.max(0, Math.min(100, warmup)),
        comment: warmup >= 75 ? '起势较自然，重心转换顺畅。' : '起势阶段偏紧，建议先降速完成动作入动。'
      },
      {
        key: 'execution',
        name: '主体动作执行',
        score: Math.max(0, Math.min(100, execution)),
        comment: execution >= 75 ? '动作执行稳定，连贯性较好。' : '执行阶段有抖动或断节，建议加强分解训练。'
      },
      {
        key: 'recovery',
        name: '收势与衔接',
        score: Math.max(0, Math.min(100, recovery)),
        comment: recovery >= 75 ? '收势平顺，节奏保持良好。' : '收势节奏偏乱，建议慢速回收练习。'
      }
    ];
  },

  normalizeAutoDetailItems(value, limit) {
    const maxLen = Number(limit) > 0 ? Number(limit) : 3;
    return Array.isArray(value)
      ? value
        .map((item) => ({
          key: String(item && item.key ? item.key : '').trim(),
          name: String(item && item.name ? item.name : '').trim(),
          score: Math.max(0, Math.min(100, Number(item && item.score) || 0)),
          note: String(item && item.note ? item.note : '').trim()
        }))
        .filter((item) => item.name)
        .slice(0, maxLen)
      : [];
  },

  buildAutoStrengthWeaknessByMetrics(metrics) {
    const sorted = Array.isArray(metrics) ? metrics.slice().sort((a, b) => (b.score || 0) - (a.score || 0)) : [];
    const strengths = sorted.slice(0, 2).map((item) => ({
      key: item.key,
      name: item.name,
      score: item.score,
      note: '该维度表现较好，可作为进阶动作训练基础。'
    }));
    const weaknesses = sorted.slice(-2).reverse().map((item) => ({
      key: item.key,
      name: item.name,
      score: item.score,
      note: '建议分解训练该维度，并结合慢速复拍纠正动作细节。'
    }));
    return { strengths, weaknesses };
  },

  buildAutoRiskAlerts(metrics) {
    const scoreMap = {};
    (Array.isArray(metrics) ? metrics : []).forEach((item) => {
      scoreMap[item.key] = Number(item.score) || 0;
    });
    const alerts = [];
    if ((scoreMap.balance || 0) < 62) {
      alerts.push('重心偏移风险较高，动作中可能出现身体晃动。');
    }
    if ((scoreMap.stability || 0) < 62) {
      alerts.push('稳定性不足，建议暂不提升速度或难度。');
    }
    if ((scoreMap.posture || 0) < 60) {
      alerts.push('姿态控制不足，长时训练可能增加关节负担。');
    }
    return alerts.slice(0, 3);
  },

  buildAutoTrainingPlanByMetrics(metrics) {
    const scoreMap = {};
    (Array.isArray(metrics) ? metrics : []).forEach((item) => {
      scoreMap[item.key] = Number(item.score) || 0;
    });
    const weakKey = Object.keys(scoreMap).sort((a, b) => (scoreMap[a] || 0) - (scoreMap[b] || 0))[0] || 'balance';
    const weakMap = {
      balance: '重心控制专项',
      stability: '稳定性专项',
      posture: '姿态控制专项',
      legDrive: '蹬伸发力专项',
      rhythm: '节奏连贯专项'
    };
    return [
      {
        day: '第1天',
        focus: '动作基础稳定',
        duration: '20-25分钟',
        tasks: [
          '热身 5 分钟：动态拉伸 + 低速直线滑行',
          '主练 12 分钟：低速动作分解循环',
          '收身 5 分钟：下肢拉伸与动作复盘'
        ]
      },
      {
        day: '第2天',
        focus: `${weakMap[weakKey] || '薄弱项补强'}`,
        duration: '25-30分钟',
        tasks: [
          '固定机位侧拍，每两组回看一次动作',
          '每组间歇 45 秒，优先保证动作质量',
          '做 3 组慢速到中速节奏递进训练'
        ]
      },
      {
        day: '第3天',
        focus: '连贯性与实战节奏',
        duration: '20分钟',
        tasks: [
          '配合节拍器进行连续动作训练',
          '重点观察起势-执行-收势的衔接',
          '训练后补拍 8-12 秒动作短视频复测'
        ]
      }
    ];
  },

  normalizeAutoTrainingPlan(value, metrics) {
    const plan = Array.isArray(value)
      ? value
        .map((item) => ({
          day: String(item && item.day ? item.day : '').trim(),
          focus: String(item && item.focus ? item.focus : '').trim(),
          duration: String(item && item.duration ? item.duration : '').trim(),
          tasks: this.normalizeStringList(item && item.tasks, 5)
        }))
        .filter((item) => item.day || item.focus || item.tasks.length)
        .slice(0, 3)
      : [];
    return plan.length ? plan : this.buildAutoTrainingPlanByMetrics(metrics);
  },

  normalizeAutoVideoQuality(value) {
    const raw = value && typeof value === 'object' ? value : {};
    return {
      score: Math.max(0, Math.min(100, Number(raw.score) || 0)),
      issues: this.normalizeStringList(raw.issues, 3),
      recommendation: String(raw.recommendation || '').trim()
    };
  },

  isGenericAutoSummary(summary) {
    const text = String(summary || '').trim().toLowerCase();
    if (!text) {
      return true;
    }
    return text.includes('动作分析完成')
      || text.includes('下面是结果分析')
      || text.includes('analysis complete')
      || text.includes('result analysis');
  },

  isPlaceholderAutoAnalysis(raw) {
    if (!raw) {
      return false;
    }
    let merged = '';
    try {
      merged = JSON.stringify(raw);
    } catch (e) {
      merged = String(raw || '');
    }
    const text = String(merged || '').toLowerCase();
    return text.includes('keypointmodelservice')
      || text.includes('upstream_keypoint_url')
      || text.includes('placeholder')
      || text.includes('stub')
      || text.includes('鍗犱綅')
      || text.includes('璇锋帴鍏ョ湡瀹炲叧閿偣妯″瀷')
      || text.includes('upstream_not_configured_stub')
      || text.includes('upstream_failed_fallback_stub');
  },

  normalizeAutoAiAnalysis(raw) {
    const safe = raw && typeof raw === 'object' ? raw : null;
    if (!safe) {
      return null;
    }

    const scoreNum = Number(safe.overallScore);
    if (Number.isNaN(scoreNum)) {
      return null;
    }

    const metrics = Array.isArray(safe.metrics)
      ? safe.metrics
        .map((item) => ({
          key: String(item && item.key ? item.key : '').trim(),
          name: String(item && item.name ? item.name : '').trim(),
          score: Math.max(0, Math.min(100, Number(item && item.score) || 0))
        }))
        .filter((item) => item.name)
        .slice(0, 5)
      : [];

    const rawTips = Array.isArray(safe.tips)
      ? safe.tips.map((item) => String(item || '').trim()).filter(Boolean)
      : [];

    const tips = rawTips
      .filter((tip) => {
        const lower = tip.toLowerCase();
        return !lower.includes('keypointmodelservice')
          && !lower.includes('upstream_keypoint_url')
          && !lower.includes('placeholder')
          && !tip.includes('缁х画淇濇寔瑙嗛鎷嶆憚瑙掑害绋冲畾')
          && !tip.includes('鎻愰珮鍏抽敭鐐硅瘑鍒巼');
      })
      .slice(0, 3);

    const normalizedScore = Math.max(0, Math.min(100, Math.round(scoreNum)));
    const sortedMetrics = metrics.slice().sort((a, b) => (a.score || 0) - (b.score || 0));
    const weakestMetric = sortedMetrics[0] || null;
    const strongestMetric = sortedMetrics[sortedMetrics.length - 1] || null;
    const descMetrics = metrics.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
    const summaryText = String(safe.summary || '').trim();
    const shouldUseGeneratedSummary = this.isPlaceholderAutoAnalysis(safe)
      || this.isGenericAutoSummary(summaryText)
      || !summaryText;
    const normalizedTips = tips.length ? tips : this.buildAutoAiTipsByMetrics(metrics);
    const detailFromMetrics = this.buildAutoStrengthWeaknessByMetrics(metrics);
    const strengths = this.normalizeAutoDetailItems(safe.strengths, 2);
    const weaknesses = this.normalizeAutoDetailItems(safe.weaknesses, 2);
    const phaseScores = this.normalizeAutoPhaseScores(safe.phaseScores, metrics);
    const riskAlerts = this.normalizeStringList(safe.riskAlerts, 3);
    const trainingPlan = this.normalizeAutoTrainingPlan(safe.trainingPlan, metrics);
    const videoQuality = this.normalizeAutoVideoQuality(safe.videoQuality);
    const scoreLevelText = normalizedScore >= 85
      ? '优秀'
      : (normalizedScore >= 75 ? '良好' : (normalizedScore >= 60 ? '达标' : '待提升'));
    const scoreLevelClass = normalizedScore >= 85
      ? 'excellent'
      : (normalizedScore >= 75 ? 'good' : (normalizedScore >= 60 ? 'pass' : 'improve'));

    return {
      overallScore: normalizedScore,
      summary: shouldUseGeneratedSummary
        ? this.buildAutoAiSummaryByScore(
          normalizedScore,
          weakestMetric && weakestMetric.name ? weakestMetric.name : '',
          strongestMetric && strongestMetric.name ? strongestMetric.name : ''
        )
        : summaryText,
      tips: normalizedTips,
      metrics: descMetrics,
      phaseScores,
      strengths: strengths.length ? strengths : detailFromMetrics.strengths,
      weaknesses: weaknesses.length ? weaknesses : detailFromMetrics.weaknesses,
      riskAlerts: riskAlerts.length ? riskAlerts : this.buildAutoRiskAlerts(metrics),
      trainingPlan,
      videoQuality,
      scoreLevelText,
      scoreLevelClass
    };
  },

  getAutoAiActionType(post) {
    const tagText = String(post && post.tag ? post.tag : '').toLowerCase();
    const titleText = String(post && post.title ? post.title : '').toLowerCase();
    const contentText = String(post && post.content ? post.content : '').toLowerCase();
    const combined = `${tagText}|${titleText}`;

    if (combined.includes('brake') || combined.includes('stop') || combined.includes('刹车')) {
      return '刹车控制';
    }
    if (combined.includes('cross') || combined.includes('交叉')) {
      return '交叉步';
    }
    if (combined.includes('slalom') || combined.includes('蛇形') || combined.includes('绕桩')) {
      return '蛇形绕桩';
    }
    if (combined.includes('single leg') || combined.includes('one foot') || combined.includes('单脚')) {
      return '单脚滑行';
    }
    if (contentText.includes('刹车')) {
      return '刹车控制';
    }
    if (contentText.includes('交叉')) {
      return '交叉步';
    }
    if (contentText.includes('蛇形') || contentText.includes('绕桩')) {
      return '蛇形绕桩';
    }
    if (contentText.includes('单脚')) {
      return '单脚滑行';
    }
    return '基础滑行';
  },

  getVideoAnalyzeSource(post) {
    const video = post && post.video && typeof post.video === 'object' ? post.video : null;
    if (!video) {
      return '';
    }
    const fileID = this.resolveAnalyzeCloudFileId(video.fileID || video.src || '');
    return fileID || '';
  },

  getVideoAnalyzeMeta(post) {
    const video = post && post.video && typeof post.video === 'object' ? post.video : null;
    if (!video) {
      return {};
    }
    return {
      duration: Number(video.duration) || 0,
      size: Number(video.size) || 0,
      width: Number(video.width) || 0,
      height: Number(video.height) || 0
    };
  },

  startAutoAiAnalyze(post, rawDoc) {
    const safePost = post && typeof post === 'object' ? post : {};
    if (!FEATURE_GATES.communityAiActionAnalyzeEnabled) {
      const hasVideo = !!(safePost.video && typeof safePost.video === 'object');
      if (hasVideo) {
        this.setData({
          aiAnalysis: null,
          aiAnalysisLoading: false,
          aiAnalysisError: FEATURE_GATES.communityAiActionAnalyzeLockMessage || '社区AI动作分析暂未开放',
          aiAnalysisVideoKey: '',
          aiAnalysisExpanded: false
        });
        this.refreshPostCardHeight();
      } else {
        this.clearAutoAiAnalyzeState();
      }
      return;
    }
    const source = this.getVideoAnalyzeSource(safePost);
    if (!source) {
      const hasVideo = !!(safePost.video && typeof safePost.video === 'object');
      if (hasVideo) {
        this.setData({
          aiAnalysis: null,
          aiAnalysisLoading: false,
          aiAnalysisError: '视频源无效，暂时无法分析，请稍后重试。',
          aiAnalysisVideoKey: ''
        });
        this.refreshPostCardHeight();
      } else {
        this.clearAutoAiAnalyzeState();
      }
      return;
    }

    const nextKey = `${safePost.id || this.data.postId || ''}|${source}`;
    const cachedRaw = rawDoc && (
      rawDoc.aiAnalysis
      || rawDoc.actionAnalysis
      || rawDoc.videoAnalysis
    );
    const hasPlaceholderCache = this.isPlaceholderAutoAnalysis(cachedRaw);
    const cachedFromDoc = this.normalizeAutoAiAnalysis(cachedRaw);
    const hasGenericCache = !!(cachedFromDoc && this.isGenericAutoSummary(cachedFromDoc.summary));
    const shouldForceRefresh = hasPlaceholderCache || hasGenericCache || !cachedFromDoc;

    if (cachedFromDoc) {
      this.setData({
        aiAnalysis: cachedFromDoc,
        aiAnalysisLoading: false,
        aiAnalysisError: '',
        aiAnalysisVideoKey: nextKey,
        aiAnalysisExpanded: false
      });
      this.refreshPostCardHeight();
      if (!shouldForceRefresh) {
        return;
      }
    }

    if (this.data.aiAnalysisVideoKey === nextKey && this.data.aiAnalysis && !shouldForceRefresh) {
      return;
    }

    if (!wx.cloud) {
      this.setData({
        aiAnalysis: cachedFromDoc || null,
        aiAnalysisLoading: false,
        aiAnalysisError: '当前基础库不支持云能力，无法完成动作分析。',
        aiAnalysisVideoKey: nextKey,
        aiAnalysisExpanded: false
      });
      this.refreshPostCardHeight();
      return;
    }

    this.setData({
      aiAnalysis: cachedFromDoc || this.data.aiAnalysis || null,
      aiAnalysisLoading: true,
      aiAnalysisError: '',
      aiAnalysisVideoKey: nextKey,
      aiAnalysisExpanded: false
    });
    this.refreshPostCardHeight();

    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true
    });

    wx.cloud.callFunction({
      name: 'skateActionAnalyze',
      data: {
        type: 'analyze',
        fileID: source,
        actionType: this.getAutoAiActionType(safePost),
        note: `community auto analysis: ${String(safePost.title || '').slice(0, 24)}`,

        videoInfo: this.getVideoAnalyzeMeta(safePost),
        userId: String(this.getCurrentUserId() || '').trim()
      }
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success || !result.analysis) {
          throw new Error(result.message || 'analyze_failed');
        }
        const normalized = this.normalizeAutoAiAnalysis(result.analysis);
        if (!normalized) {
          throw new Error('analysis_invalid');
        }
        this.setData({
          aiAnalysis: normalized,
          aiAnalysisLoading: false,
          aiAnalysisError: '',
          aiAnalysisExpanded: false
        });
        this.refreshPostCardHeight();
      })
      .catch((error) => {
        console.error('auto ai analyze failed:', error);
        const msg = String((error && error.message) || '');
        let errorText = 'AI 动作分析失败，请稍后重试。';
        if (
          msg.includes('FunctionName parameter could not be found')
          || msg.includes('function not found')
          || msg.includes('skateActionAnalyze')
        ) {
          errorText = 'AI 分析服务未部署，请先上传部署 skateActionAnalyze 云函数。';
        } else if (msg.includes('file_id_required')) {
          errorText = '视频源无效，请重新上传后再试。';
        }
        this.setData({
          aiAnalysis: cachedFromDoc || this.data.aiAnalysis || null,
          aiAnalysisLoading: false,
          aiAnalysisError: errorText,
          aiAnalysisExpanded: false
        });
        this.refreshPostCardHeight();
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

  getLikeStorageKey(postId) {
    return `community_post_liked_${postId}`;
  },

  initLikeState(postId) {
    if (!postId) {
      this.setData({ isLiked: false });
      return;
    }
    const liked = !!wx.getStorageSync(this.getLikeStorageKey(postId));
    this.setData({ isLiked: liked });
  },

  persistLikeState(postId, liked) {
    if (!postId) {
      return;
    }
    const key = this.getLikeStorageKey(postId);
    if (liked) {
      wx.setStorageSync(key, 1);
    } else {
      wx.removeStorageSync(key);
    }
  },

  increasePostView(postId) {
    if (!wx.cloud || !postId) {
      return;
    }

    const userId = String(this.getCurrentUserId() || '').trim();

    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'viewCommunityPost',
        postId,
        userId
      }
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success || typeof result.views !== 'number') {
          return;
        }
        this.setData({
          post: {
            ...this.data.post,
            views: result.views
          }
        });
      })
      .catch((error) => {
        console.error('increase post view failed:', error);
      });
  },
  togglePostLike() {
    if (this.data.likeUpdating) {
      return;
    }

    const postId = this.data.post.id || this.data.postId;
    if (!postId) {
      return;
    }

    if (!wx.cloud) {
      const nextLiked = !this.data.isLiked;
      const currentLikes = Number(this.data.post.likes || 0);
      const nextLikes = nextLiked ? currentLikes + 1 : Math.max(0, currentLikes - 1);
      this.setData({
        isLiked: nextLiked,
        post: {
          ...this.data.post,
          likes: nextLikes
        }
      });
      this.persistLikeState(postId, nextLiked);
      return;
    }

    this.setData({ likeUpdating: true });
    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'toggleCommunityLike',
        postId
      }
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (typeof result.success === 'undefined') {
          throw new Error('function_not_updated');
        }
        if (!result.success) {
          throw new Error(result.message || 'toggle_like_failed');
        }

        const liked = !!result.liked;
        const likes = typeof result.likes === 'number' ? result.likes : Number(this.data.post.likes || 0);
        this.setData({
          isLiked: liked,
          post: {
            ...this.data.post,
            likes
          }
        });
        this.persistLikeState(postId, liked);
      })
      .catch((error) => {
        console.error('toggle like failed:', error);
        const errorText = String((error && error.message) || '');
        const isMissingFunction = errorText.includes('FunctionName parameter could not be found')
          || errorText.includes('function not found')
          || errorText.includes('quickstartFunctions');
        const isOldFunction = errorText.includes('function_not_updated');
        wx.showToast({
          title: isMissingFunction || isOldFunction
            ? 'Please deploy/update cloud function quickstartFunctions'
            : 'Like failed, retry later',
          icon: 'none'
        });
      })
      .finally(() => {
        this.setData({ likeUpdating: false });
      });
  },

  getCurrentRole() {
    const role = wx.getStorageSync('userRole');
    return role === 'coach' ? 'coach' : 'student';
  },

  resolveCurrentAuthor() {
    const localUserInfo = wx.getStorageSync('userInfo') || {};
    const localName = localUserInfo.name || localUserInfo.nickName || '';
    const localAvatar = this.normalizeAvatarUrl(localUserInfo.avatarUrl);

    if (localName) {
      return Promise.resolve({
        name: localName,
        avatarUrl: localAvatar
      });
    }

    const role = this.getCurrentRole();
    const defaultName = role === 'coach' ? '\u6559\u7ec3' : '\u5b66\u5458';

    if (!wx.cloud) {
      return Promise.resolve({
        name: defaultName,
        avatarUrl: pickRandomAvatar(resolveAvatarSeed(localUserInfo, defaultName))
      });
    }

    const db = wx.cloud.database();
    return db.collection(USER_COLLECTION)
      .where({ role })
      .limit(1)
      .get()
      .then((res) => {
        const list = res && res.data ? res.data : [];
        if (!list.length) {
          return { name: defaultName, avatarUrl: pickRandomAvatar(resolveAvatarSeed({}, defaultName)) };
        }
        const item = list[0] || {};
        return {
          name: item.name || defaultName,
          avatarUrl: this.normalizeAvatarUrl(item.avatarUrl) || pickRandomAvatar(resolveAvatarSeed(item, item.name || defaultName))
        };
      })
      .catch(() => ({
        name: defaultName,
        avatarUrl: pickRandomAvatar(resolveAvatarSeed({}, defaultName))
      }));
  },

  bindCommentInput(e) {
    this.setData({
      commentText: (e.detail.value || '').slice(0, 200)
    });
    this.updateCommentSubmitState();
  },

  updateCommentSubmitState() {
    const hasText = (this.data.commentText || '').trim().length > 0;
    const hasImages = Array.isArray(this.data.commentImages) && this.data.commentImages.length > 0;
    this.setData({ canSubmitComment: hasText || hasImages });
  },

  chooseCommentImages() {
    const current = this.data.commentImages || [];
    const remain = MAX_COMMENT_IMAGE_COUNT - current.length;
    if (remain <= 0) {
      wx.showToast({
        title: `\u6700\u591a\u4e0a\u4f20${MAX_COMMENT_IMAGE_COUNT}\u5f20\u56fe\u7247`,
        icon: 'none'
      });
      return;
    }

    wx.chooseImage({
      count: Math.min(9, remain),
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const selected = res && res.tempFilePaths ? res.tempFilePaths : [];
        this.setData({
          commentImages: current.concat(selected).slice(0, MAX_COMMENT_IMAGE_COUNT)
        }, () => {
          this.updateCommentSubmitState();
          this.refreshPostCardHeight();
        });
      }
    });
  },

  removeCommentImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isNaN(index)) {
      return;
    }
    const nextImages = (this.data.commentImages || []).filter((_, i) => i !== index);
    this.setData({ commentImages: nextImages }, () => {
      this.updateCommentSubmitState();
      this.refreshPostCardHeight();
    });
  },

  previewSelectedCommentImage(e) {
    const index = Number(e.currentTarget.dataset.index) || 0;
    const images = this.data.commentImages || [];
    if (!images.length) {
      return;
    }
    wx.previewImage({
      current: images[index] || images[0],
      urls: images
    });
  },

  getFileExt(filePath, fallbackExt) {
    const match = String(filePath || '').match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    return match && match[1] ? match[1].toLowerCase() : fallbackExt;
  },

  uploadFileToCloud(filePath, folder, fallbackExt) {
    const ext = this.getFileExt(filePath, fallbackExt);
    const cloudPath = `community/comments/${folder}/${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`;
    return wx.cloud.uploadFile({
      cloudPath,
      filePath
    }).then((res) => (res && res.fileID ? res.fileID : ''));
  },

  uploadCommentImages() {
    const images = Array.isArray(this.data.commentImages) ? this.data.commentImages : [];

    const imageTasks = images.map((path) => this.uploadFileToCloud(path, 'images', 'jpg'));
    return Promise.all(imageTasks).then((imageFileIDs) => imageFileIDs.filter(Boolean));
  },

  previewPostImage(e) {
    const index = Number(e.currentTarget.dataset.index) || 0;
    const images = (this.data.post && Array.isArray(this.data.post.images)) ? this.data.post.images : [];
    if (!images.length) {
      return;
    }
    wx.previewImage({
      current: images[index] || images[0],
      urls: images
    });
  },

  handlePostImageError(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isNaN(index)) {
      return;
    }
    const currentImages = (this.data.post && Array.isArray(this.data.post.images))
      ? this.data.post.images
      : [];
    if (!currentImages.length) {
      return;
    }
    const nextImages = currentImages.filter((_, i) => i !== index);
    this.setData({
      post: {
        ...(this.data.post || {}),
        images: nextImages
      }
    });
  },

  handlePostVideoError() {
    this.setData({
      post: {
        ...(this.data.post || {}),
        video: null
      }
    });
  },
  goToAiAnalyze() {
    if (!FEATURE_GATES.communityAiActionAnalyzeEnabled) {
      wx.showToast({
        title: FEATURE_GATES.communityAiActionAnalyzeLockMessage || '社区AI动作分析暂未开放',
        icon: 'none'
      });
      return;
    }
    const post = this.data.post || {};
    const video = post.video && typeof post.video === 'object' ? post.video : null;
    const rawFileID = String(video && video.fileID ? video.fileID : '').trim();
    const rawSrc = String(video && video.src ? video.src : '').trim();
    const safeFileID = this.resolveAnalyzeCloudFileId(rawFileID);
    const safeSrc = this.isLocalVideoPath(rawSrc) ? rawSrc : '';
    if (!safeFileID && !safeSrc) {
      wx.showToast({ title: 'Invalid video source', icon: 'none' });
      return;
    }

    const query = [
      'from=community_detail',
      `postId=${encodeURIComponent(String(post.id || this.data.postId || '').trim())}`
    ];
    if (safeFileID) {
      query.push(`fileID=${encodeURIComponent(safeFileID)}`);
    }
    if (safeSrc) {
      query.push(`videoUrl=${encodeURIComponent(safeSrc)}`);
    }
    wx.navigateTo({
      url: `/pages/student/ai/analyze/analyze?${query.join('&')}`
    });
  },

  previewCommentImage(e) {
    const commentIndex = Number(e.currentTarget.dataset.commentIndex);
    const imageIndex = Number(e.currentTarget.dataset.imageIndex) || 0;
    const replyIndexRaw = e.currentTarget.dataset.replyIndex;
    const replyIndex = typeof replyIndexRaw === 'undefined' || replyIndexRaw === '' ? NaN : Number(replyIndexRaw);
    if (Number.isNaN(commentIndex)) {
      return;
    }
    const comments = Array.isArray(this.data.comments) ? this.data.comments : [];
    const comment = comments[commentIndex] || {};
    let images = Array.isArray(comment.images) ? comment.images : [];
    if (!Number.isNaN(replyIndex)) {
      const replies = Array.isArray(comment.replies) ? comment.replies : [];
      const reply = replies[replyIndex] || {};
      images = Array.isArray(reply.images) ? reply.images : [];
    }
    if (!images.length) {
      return;
    }
    wx.previewImage({
      current: images[imageIndex] || images[0],
      urls: images
    });
  },

  handleCommentImageError(e) {
    const commentIndex = Number(e.currentTarget.dataset.commentIndex);
    const imageIndex = Number(e.currentTarget.dataset.imageIndex);
    const replyIndexRaw = e.currentTarget.dataset.replyIndex;
    const replyIndex = typeof replyIndexRaw === 'undefined' || replyIndexRaw === '' ? NaN : Number(replyIndexRaw);

    if (Number.isNaN(commentIndex) || Number.isNaN(imageIndex)) {
      return;
    }

    const source = Array.isArray(this.data.comments) ? this.data.comments : [];
    if (!source.length || !source[commentIndex]) {
      return;
    }

    const nextComments = source.map((comment, cIdx) => {
      if (cIdx !== commentIndex) {
        return comment;
      }
      const safeComment = comment || {};
      if (Number.isNaN(replyIndex)) {
        const commentImages = Array.isArray(safeComment.images) ? safeComment.images : [];
        return {
          ...safeComment,
          images: commentImages.filter((_, idx) => idx !== imageIndex)
        };
      }

      const replies = Array.isArray(safeComment.replies) ? safeComment.replies : [];
      const displayReplies = Array.isArray(safeComment.displayReplies) ? safeComment.displayReplies : [];
      const nextReplies = replies.map((reply, rIdx) => {
        if (rIdx !== replyIndex) {
          return reply;
        }
        const replyImages = Array.isArray(reply && reply.images) ? reply.images : [];
        return {
          ...(reply || {}),
          images: replyImages.filter((_, idx) => idx !== imageIndex)
        };
      });
      const nextDisplayReplies = displayReplies.map((reply, rIdx) => {
        if (rIdx !== replyIndex) {
          return reply;
        }
        const replyImages = Array.isArray(reply && reply.images) ? reply.images : [];
        return {
          ...(reply || {}),
          images: replyImages.filter((_, idx) => idx !== imageIndex)
        };
      });
      return {
        ...safeComment,
        replies: nextReplies,
        displayReplies: nextDisplayReplies
      };
    });

    this.setData({ comments: nextComments });
  },

  getCurrentUserId() {
    const localUserInfo = wx.getStorageSync('userInfo') || {};
    return localUserInfo.id || localUserInfo._id || '';
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
  handleCommentSubmitFailure(result) {
    const message = String(result && result.message ? result.message : '');
    if (message.includes('community_blocked')) {
      const blockedUntil = this.formatBlockedUntil(result.blockedUntil);
      const remain = Number(result.remainingMinutes || 0);
      const detail = blockedUntil
        ? `?????????? ${blockedUntil} ????`
        : `??????????????? ${remain || 1} ????`;
      wx.showModal({
        title: '????',
        content: detail,
        showCancel: false
      });
      return;
    }
    if (message.includes('post_unavailable')) {
      wx.showToast({ title: 'Post is unavailable or deleted', icon: 'none' });
      return;
    }
    if (message.includes('user_not_found')) {
      wx.showToast({ title: 'User info not found. Please login again', icon: 'none' });
      return;
    }
    if (message.includes('parent_comment_not_found')) {
      wx.showToast({ title: 'Reply target not found, page refreshed', icon: 'none' });
      this.loadPostDetail(this.data.postId, false, false);
      this.cancelReply();
      return;
    }
    wx.showToast({ title: 'Comment failed, retry later', icon: 'none' });
  },

  beginReply(e) {
    const commentId = String(e.currentTarget.dataset.commentId || '');
    const author = String(e.currentTarget.dataset.author || '');
    if (!commentId) {
      return;
    }
    this.setData({
      replyingCommentId: commentId,
      replyingToName: author || 'User'
    }, () => {
      this.refreshPostCardHeight();
    });
  },

  refreshPostCardHeight() {
    const now = Date.now();
    const throttleMs = 160;
    const lastAt = Number(this._postCardMeasureLastAt || 0);
    if (lastAt > 0 && now - lastAt < throttleMs) {
      if (!this._postCardMeasureQueueTimer) {
        const waitMs = Math.max(16, throttleMs - (now - lastAt));
        this._postCardMeasureQueueTimer = setTimeout(() => {
          this._postCardMeasureQueueTimer = null;
          this.refreshPostCardHeight();
        }, waitMs);
      }
      return;
    }
    this._postCardMeasureLastAt = now;

    if (this._postCardMeasureTimer) {
      clearTimeout(this._postCardMeasureTimer);
      this._postCardMeasureTimer = null;
    }
    if (this._postCardMeasureQueueTimer) {
      clearTimeout(this._postCardMeasureQueueTimer);
      this._postCardMeasureQueueTimer = null;
    }

    const measure = () => {
      if (this._pageUnloaded) {
        return;
      }
      const query = this.createSelectorQuery();
      query.select('.post-card').boundingClientRect();
      query.select('.comment-input-bar').boundingClientRect();
      query.exec((res) => {
        if (this._pageUnloaded) {
          return;
        }
        const rect = res && res[0] ? res[0] : null;
        const inputRect = res && res[1] ? res[1] : null;
        const height = rect && rect.height ? Math.ceil(rect.height) : 0;
        if (!height) {
          return;
        }
        const nextHeight = height + 12;
        const windowHeight = Number(this.data.windowHeightPx || 0);
        const safeWindowHeight = windowHeight > 0 ? windowHeight : 780;
        const postBottom = rect && rect.bottom ? Number(rect.bottom) : (20 + height);
        const commentTop = Math.max(0, Math.ceil(postBottom + 10));
        const inputTop = inputRect && inputRect.top ? Number(inputRect.top) : (safeWindowHeight - 120);
        const commentHeight = Math.max(420, Math.floor(inputTop - commentTop - 10));

        if (
          nextHeight === this.data.postCardHeight
          && commentTop === this.data.commentSectionTopPx
          && commentHeight === this.data.commentSectionHeightPx
        ) {
          return;
        }
        this.setData({
          postCardHeight: nextHeight,
          commentSectionTopPx: commentTop,
          commentSectionHeightPx: commentHeight
        });
      });
    };

    if (typeof wx.nextTick === 'function') {
      wx.nextTick(measure);
    } else {
      setTimeout(measure, 0);
    }
    this._postCardMeasureTimer = setTimeout(() => {
      this._postCardMeasureTimer = null;
      measure();
    }, POST_CARD_MEASURE_DELAY);
  },

  toggleReplyExpand(e) {
    const commentId = String(e.currentTarget.dataset.commentId || '');
    if (!commentId) {
      return;
    }

    const replyExpandedMap = {
      ...(this.data.replyExpandedMap || {})
    };
    replyExpandedMap[commentId] = !replyExpandedMap[commentId];

    this.setData({
      replyExpandedMap,
      comments: this.applyReplyExpandState(this.data.comments, replyExpandedMap)
    }, () => {
      this.refreshPostCardHeight();
    });
  },

  cancelReply() {
    this.setData({
      replyingCommentId: '',
      replyingToName: ''
    }, () => {
      this.refreshPostCardHeight();
    });
  },

  resetCommentDraft() {
    this.setData({
      commentText: '',
      commentImages: [],
      canSubmitComment: false
    }, () => {
      this.refreshPostCardHeight();
    });
  },
  submitComment() {
    if (this.data.submittingComment) {
      return;
    }

    const content = (this.data.commentText || '').trim();
    const hasImages = Array.isArray(this.data.commentImages) && this.data.commentImages.length > 0;

    if (!content && !hasImages) {
      wx.showToast({ title: 'Please enter comment text or upload image', icon: 'none' });
      return;
    }

    if (!wx.cloud) {
      wx.showToast({ title: 'Cloud capability unavailable', icon: 'none' });
      return;
    }

    const postId = this.data.post.id || this.data.postId;
    if (!postId) {
      wx.showToast({ title: 'Post is unavailable or deleted', icon: 'none' });
      return;
    }

    this.setData({ submittingComment: true });

    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true
    });

    const replyingCommentId = String(this.data.replyingCommentId || '');
    const replyingToName = String(this.data.replyingToName || '');

    Promise.all([this.resolveCurrentAuthor(), this.uploadCommentImages()])
      .then(([author, images]) => wx.cloud.callFunction({
        name: 'quickstartFunctions',
        data: {
          type: 'addCommunityComment',
          postId,
          content,
          author,
          source: this.getCurrentRole(),
          images: images || [],
          userId: this.getCurrentUserId(),
          parentCommentId: replyingCommentId,
          replyToName: replyingToName
        }
      }))
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (typeof result.success === 'undefined') {
          throw new Error('function_not_updated');
        }
        if (!result.success) {
          this.handleCommentSubmitFailure(result);
          return;
        }

        this.resetCommentDraft();
        this.cancelReply();
        this.loadPostDetail(postId, false, false);
        wx.showToast({ title: replyingCommentId ? 'Reply posted' : 'Comment posted', icon: 'success' });
      })
      .catch((error) => {
        console.error('submit comment failed:', error);
        const errorText = String((error && error.message) || '');
        const isMissingFunction = errorText.includes('FunctionName parameter could not be found')
          || errorText.includes('function not found')
          || errorText.includes('quickstartFunctions');
        const isOldFunction = errorText.includes('function_not_updated');
        if (errorText.includes('community_blocked')) {
          this.handleCommentSubmitFailure({ message: 'community_blocked' });
          return;
        }
        wx.showToast({
          title: isMissingFunction || isOldFunction
            ? 'Please deploy/update cloud function quickstartFunctions'
            : 'Comment failed, retry later',
          icon: 'none'
        });
      })
      .finally(() => {
        this.setData({ submittingComment: false });
      });
  },

  loadLocalPost(postId) {
    const mockPost = {
      id: postId || 'local_post',
      title: 'Local Community Post',
      content: 'This is a local demo post. Real content will show after cloud data is available.',
      author: {
        name: 'System',
        avatarUrl: pickRandomAvatar(resolveAvatarSeed({ id: postId || 'local_post', name: 'System' }, 'system'))
      },
      authorRoleText: '学员',
      time: '2026-02-25 12:00',
      likes: 0,
      comments: 0,
      views: 0,
      tag: '\u516c\u544a',
      images: [],
      video: null,
      durationText: ''
    };

    this.setData({
      post: mockPost,
      comments: []
    });
  },
  onShareAppMessage() {
    const { post } = this.data;
    return {
      title: post.title || 'Community Post Detail',
      path: `/pages/student/community/detail/detail?id=${post.id || this.data.postId || ''}`
    };
  }
});
