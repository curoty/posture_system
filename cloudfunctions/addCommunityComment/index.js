const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function getCommentCount(doc) {
  if (!doc || typeof doc !== 'object') {
    return 0;
  }
  if (Array.isArray(doc.commentList)) {
    return doc.commentList.length;
  }
  if (Array.isArray(doc.comments)) {
    return doc.comments.length;
  }
  if (typeof doc.comments === 'number') {
    return doc.comments;
  }
  if (typeof doc.commentCount === 'number') {
    return doc.commentCount;
  }
  return 0;
}

function normalizeAuthor(author, source) {
  const safeAuthor = author && typeof author === 'object' ? author : {};
  const fallbackName = source === 'coach' ? '教练' : '学员';
  return {
    name: safeAuthor.name || safeAuthor.nickName || fallbackName,
    avatarUrl: safeAuthor.avatarUrl || ''
  };
}

exports.main = async (event) => {
  try {
    const postId = event && event.postId ? String(event.postId) : '';
    const content = event && event.content ? String(event.content).trim() : '';
    const source = event && event.source === 'coach' ? 'coach' : 'student';
    const author = normalizeAuthor(event && event.author, source);
    const now = new Date();

    if (!postId) {
      return { success: false, message: 'post_id_required' };
    }
    if (!content) {
      return { success: false, message: 'content_required' };
    }
    if (content.length > 200) {
      return { success: false, message: 'content_too_long' };
    }

    const postRes = await db.collection('community_posts').doc(postId).get();
    const doc = postRes && postRes.data ? postRes.data : null;
    if (!doc) {
      return { success: false, message: 'post_not_found' };
    }

    const currentList = Array.isArray(doc.commentList)
      ? doc.commentList.slice()
      : (Array.isArray(doc.comments) ? doc.comments.slice() : []);

    const nextCount = getCommentCount(doc) + 1;
    const commentDoc = {
      id: `comment_${Date.now()}`,
      author,
      authorName: author.name,
      content,
      source,
      time: now,
      createdAt: now
    };

    const nextCommentList = currentList.concat(commentDoc);

    await db.collection('community_posts').doc(postId).update({
      data: {
        commentList: nextCommentList,
        comments: nextCount,
        commentCount: nextCount,
        updatedAt: db.serverDate()
      }
    });

    return {
      success: true,
      comment: commentDoc,
      commentCount: nextCount
    };
  } catch (error) {
    return {
      success: false,
      message: error && error.message ? error.message : 'add_comment_failed',
      error
    };
  }
};
