# MySQL 业务云函数部署与验证

## 部署

在微信开发者工具中上传并部署 `mysqlBusiness`，选择“云端安装依赖”。

云函数必须开启私有网络，并选择与 MySQL 相同的网络：

```text
VPC: vpc-jks63nye
子网: subnet-gtr5shp1
```

环境变量（账号密码从云开发 MySQL「账号管理」获取，不要写入代码）：

```text
MYSQL_HOST=sh-cynosdbmysql-grp-izy3npum.sql.tencentcdb.com
MYSQL_PORT=27633
MYSQL_DATABASE=cloud1-1g0419td698cd252
MYSQL_USER=<MySQL账号>
MYSQL_PASSWORD=<MySQL密码>
PASSWORD_HASH_SALT=aiwork_pwd_v1
MIGRATION_ADMIN_OPENID=<执行迁移的管理员_openid>
```

`PASSWORD_HASH_SALT` 必须与旧系统一致，否则已有密码无法校验。

## 1. MySQL 连通检查

线上函数的执行超时必须手动设为至少 20 秒；数据库启用自动暂停时，首次唤醒
可能超过默认的 3 秒。函数还必须加入 MySQL 所属 VPC/子网。

从小程序或云函数控制台调用：

```json
{"type":"health"}
```

预期 `success=true`、`mysql.ok=1`。

如果控制台里找不到测试入口，也可以在微信开发者工具的 Console 执行：

```js
wx.cloud.callFunction({
  name: "mysqlBusiness",
  data: { type: "health" },
}).then((res) => console.log(res.result)).catch(console.error);
```

常见诊断码：

- `MYSQL_CONFIG_MISSING`：没有配置 MySQL 用户名或密码。
- `ER_ACCESS_DENIED_ERROR`：账号或密码错误。
- `ETIMEDOUT`：云函数未接入正确的 VPC/子网，或数据库仍在唤醒。

## 2. 用户数据迁移

手机号首次登录时，如果 MySQL 中没有该用户，云函数会按手机号从文档库
`users` 迁移该账号，然后立即从 MySQL 完成登录。批量迁移仍可按页执行：
每次最多迁移 100 条，按页调用直到 `hasMore=false`：

```json
{"type":"migrateUsersFromDocument","page":1,"pageSize":100}
```

下一页：

```json
{"type":"migrateUsersFromDocument","page":2,"pageSize":100}
```

如果 `errors` 非空，不要删除文档库集合；修复对应记录后重跑该页。

## 3. 登录验证

- `loginByPhonePassword`：手机号密码登录，并在未绑定时写入当前 `_openid`。
- `loginByPhonePassword` 首次登录：仅按手机号迁移当前用户，后续只读 MySQL。
- `loginWechat`：按当前 `_openid` 查询；不存在时创建 MySQL 用户。
- `getCurrentUser`：读取当前微信用户。

## 存储边界

- MySQL：用户和所有结构化业务数据。
- 文档数据库：`skate_sensor_training_samples` 原始 IMU 帧。
- MySQL `skate_action_analysis_records.source_summary.rawSampleId` 保存原始文档关联。
