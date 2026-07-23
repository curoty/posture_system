// 云函数 login/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const { code } = event
  const wxContext = cloud.getWXContext()
  
  // 直接通过云 SDK 获取 openid（不需要 appid 和 secret）
  return {
    openid: wxContext.OPENID,
    unionid: wxContext.UNIONID,
    appid: wxContext.APPID
  }
}
