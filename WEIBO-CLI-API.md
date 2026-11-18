# weibo-cli 接口说明（给开发者 / AI）

> 基于本仓库依赖 `@weibo-ai/weibo-cli@0.9.8` 的源码，以及登录后拉取的平台命令目录快照（共 **75** 条，分组：article, attitudes, comments, friendships, search, short_url, statuses, tags, users, wbindex）。  
> 快照日期：2026-11-18。平台会增减命令与改价，**以线上 `commands list / show` 为准**。

相关文档：[README.md](README.md) · [WINDOWS.md](WINDOWS.md) · 上游 README：`node_modules/@weibo-ai/weibo-cli/README.md`

---

## 1. 两层模型：CLI 命令 ≠ 唯一 HTTP 路径

`weibo-cli` 对调用方暴露的是 **命令行**：

```bash
weibo-cli <group> <action> [--flag value ...] [--output json]
```

对开放平台，绝大多数业务命令最终都走同一个业务入口：

| 层级 | 说明 |
|------|------|
| **固定 HTTP 面** | OAuth、账号元数据、命令目录、统一调用、Skills 等（见第 3 节） |
| **动态业务面** | `POST /cli/invoke`，body 里带 `group` + `action` + `args`；具体有哪些 group/action 由服务端目录决定（见第 5 节） |

因此：**写文档时要区分「CLI 内建命令」和「平台动态 API」**。动态 API 不要写死成永久契约，升级后应用 `commands show` 再确认 flags / 定价。

---

## 2. 环境与基址

| 项 | 生产 | 开发（`NODE_ENV=development`） |
|----|------|----------------------------------|
| App 基址 | `https://open.weibo.com/cli` | `https://open-dev.weibo.com/cli` |
| API 基址（`DEFAULT_API_BASE_URL`） | `https://open.weibo.com/cli/api` | `https://open-dev.weibo.com/cli/api` |
| 本地配置目录 | `~/.weibo-cli` | `~/.weibo-cli-dev` |

认证：请求头 `Authorization: Bearer <access_token>`。  
令牌优先级：环境变量 `WEIBO_CLI_TOKEN` / `WEIBO_TOKEN`（或 refresh 对应变量）> 本机钥匙串 / 加密文件 > `--token`（不推荐）。

全局 CLI 参数：`--output json|table|yaml|raw` · `--agent <name>` · `-h/--help`。

---

## 3. 固定 HTTP 接口（CLI 源码内写死）

以下路径均相对 **API 基址**（默认 `https://open.weibo.com/cli/api`）。

### 3.1 OAuth / 会话

| Method | Path | 功能 |
|--------|------|------|
| GET（浏览器） | `/oauth/authorize` | 授权码 + PKCE 登录页；需 `response_type`, `client_id=weibo-cli`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`，可选 `device_name` |
| POST | `/oauth/token` | 换票：`authorization_code`（需 `code`+`code_verifier`+`redirect_uri`）或 `refresh_token`；设备码则用 `urn:ietf:params:oauth:grant-type:device_code` |
| POST | `/oauth/device/code` | 发起设备码登录 |
| POST | `/oauth/revoke` | 吊销会话 |
| GET | `/oauth/userinfo` | 用 access token 取用户基本信息 |

本地回跳：`http://127.0.0.1:<port>/callback`（CLI 起临时 HTTP 服务接收 `code`）。

对应 CLI：`auth login`（`--browser` / `--device`）、`auth logout` / `auth revoke`。

### 3.2 注册引导

| Method | Path | 功能 | CLI |
|--------|------|------|-----|
| POST | `/onboarding/sms/send` | 发送短信验证码，body: `{ phone }` | `auth sms-send --phone` |
| POST | `/onboarding/register` | 短信注册/登录，body: phone + code + 可选会话名 | `auth register` |

### 3.3 CLI 元数据与统一调用

| Method | Path | 功能 | CLI |
|--------|------|------|-----|
| GET | `/cli/whoami` | 当前用户、套餐、余额、服务状态等 | `auth whoami`、`me`、`doctor` |
| GET | `/cli/version` | 服务端公布的最新 CLI 版本 | `version` / `check_update` / `upgrade` |
| GET | `/cli/commands` | 命令目录；可用 `?group=` 过滤 | `commands list` |
| GET | `/cli/commands/{group}/{action}` | 单命令元数据（flags、定价、schema） | `commands show`；业务调用前也会先查 |
| POST | `/cli/invoke` | **统一业务调用** | `weibo-cli <group> <action> ...` |

#### `POST /cli/invoke` 请求体（概念）

```json
{
  "group": "comments",
  "action": "by_me/other",
  "args": { "uid": "123", "count": "50", "page": "1" }
}
```

CLI 会先 `GET /cli/commands/{group}/{action}` 校验允许的 flags，再 POST invoke。  
可选请求头：`User-Agent: weibo-cli/<ver>`、`X-Weibo-Agent-Source` / `X-Weibo-Agent-Host` / `X-Weibo-Source-Method`（`--agent`）。

### 3.4 Skills（Agent 技能市场）

| Method | Path | 功能 | CLI |
|--------|------|------|-----|
| GET | `/skills` | 列表 | `skill list` |
| GET | `/skills?search=` | 搜索 | `skill search` |
| GET | `/skills/{name}` | 详情 | `skill info` |
| GET | `/skills/{name}/bundle` | 下载安装包（可带 version） | `skill install` |
| POST | `/cli/skills/publish` | 发布技能（含 zip_base64 等） | `skill publish` |

Hub 页面：`https://open.weibo.com/cli/skills` · 套餐页：`https://open.weibo.com/cli/plan`。

---

## 4. 内建 CLI 命令（非 /cli/invoke）

| 命令 | 作用 |
|------|------|
| `auth login [--browser\|--device] [--name]` | OAuth 登录 |
| `auth sms-send` / `auth register` | 短信注册登录 |
| `auth whoami` / `auth token[--export]` / `auth logout` | 会话查询与退出 |
| `me` | 账户、余额、用量（基于 whoami 等） |
| `doctor` | 登录与服务就绪检查 |
| `commands list\|show` | 浏览/查看平台命令定义 |
| `skill …` | 技能市场 |
| `version` / `check_update` / `upgrade` | 版本与升级提示（upgrade 只打印 npm 命令） |

`update`、`check-update`、`auth revoke` 为兼容别名。

---

## 5. 平台动态业务命令目录（快照）

命名习惯：

- `…/biz`：多针对**当前登录用户**（`is_myself`）
- `…/other`：查询**其他用户**（通常要 `uid` / `uids` / `screen_name`）
- `…/all`：更广范围列表（如某条微博下全部评论）

单价单位为 **credit**；下表为文档生成时的快照，**以 `commands show` 实时返回为准**。参数名后 `*` 表示目录标记为必填。


### article — 头条文章 / V+ 专栏（8）

| Method | action | 标题 | 单价（快照） | 主要参数 |
|---|---|---|---|---|
| POST | `collections/create` | 创建付费专栏 | 3 credit/次 | `type` `money*` `title*` `images*` `content*` `sale_money` `video_nums*` `category_id*` `is_recommend` `sale_end_time` |
| POST | `collections/delete` | 删除专栏 | 15 credit/次 | `id*` |
| GET | `collections/info` | 查询专栏详情 | 3 credit/次 | `id` |
| GET | `collections/list` | 查询专栏列表 | 3 credit/次 | `page*` `limit*` `short_play*` |
| POST | `collections/update` | 更新专栏 | 3 credit/次 | `id*` `money*` `title*` `images*` `content*` `change_img` `sale_money` `video_nums*` `category_id*` `is_recommend` `sale_end_time` |
| GET | `config` | 查询发文配置 | 3 credit/次 | — |
| GET | `preview` | 生成文章预览链接 | 3 credit/次 | `cover` `title*` `content*` `summary` `pay_type*` `free_content*` |
| POST | `publish` | 发布文章 | 15 credit/次 | `text*` `cover` `money` `title*` `writer` `content*` `is_word` `summary` `pay_type*` `freecontent` `collection_id` `follow_to_read` `vclub_single_pay_money` |

### attitudes — 表态（点赞等）（3）

| Method | action | 标题 | 单价（快照） | 主要参数 |
|---|---|---|---|---|
| POST | `create` | 发布一条表态 | 10 credit/次 | `id*` `attitude` `attitude_type` |
| POST | `destroy` | 删除一条表态 | 10 credit/次 | `id*` `attid` |
| GET | `show/biz` | 根据微博ID返回某条微博的赞列表 | 3 credit/次 | `id*` `page` `count` `max_id` `since_id` |

### comments — 评论（14）

| Method | action | 标题 | 单价（快照） | 主要参数 |
|---|---|---|---|---|
| GET | `by_me/biz` | 获取当前登录用户发出的评论列表 | 3 credit/次 | `page` `count` `max_id` `since_id` `filter_by_source` |
| GET | `by_me/other` | 获取某个用户发出的评论列表 | 3 credit/次 | `uid*` `page` `count` `max_id` `since_id` `filter_by_source` |
| POST | `create` | 评论一条微博 | 15 credit/次 | `id*` `comment*` `pic_ids` `is_repost` `comment_ori` |
| POST | `destroy` | 删除一条评论 | 15 credit/次 | `cid*` |
| GET | `mentions/biz` | 获取@当前登录用户的评论 | 3 credit/次 | `page` `count` `max_id` `since_id` `filter_by_author` `filter_by_source` |
| GET | `mentions/other` | 获取@某人的评论 | 3 credit/次 | `uid*` `page` `count` `max_id` `since_id` `filter_by_author` `filter_by_source` |
| POST | `reply` | 回复一条评论 | 15 credit/次 | `id*` `cid*` `comment*` `pic_ids` `is_repost` `comment_ori` `without_mention` |
| GET | `show_batch/biz` | 批量获取评论内容 | 3 credit/次 | `cids*` |
| GET | `show/all` | 返回一条微博的全部评论列表 | 3 credit/次 | `id*` `page` `count` `max_id` `since_id` `filter_by_author` |
| GET | `show/biz` | 获取当前登录用户发布的微博下的评论列表 | 3 credit/次 | `id*` `page` `count` `max_id` `since_id` `filter_by_author` |
| GET | `timeline/biz` | 获取当前登录用户发出及收到的评论列表 | 3 credit/次 | `page` `count` `max_id` `since_id` `trim_user` |
| GET | `timeline/other` | 获取某个用户发出和收到的评论列表 | 3 credit/次 | `uid*` `page` `count` `max_id` `since_id` `trim_user` |
| GET | `to_me/biz` | 获取当前登录用户收到的评论列表 | 3 credit/次 | `page` `count` `max_id` `since_id` `filter_by_author` `filter_by_source` |
| GET | `to_me/other` | 获取某个用户收到的评论列表 | 3 credit/次 | `uid*` `page` `count` `max_id` `since_id` `filter_by_author` `filter_by_source` |

### friendships — 关注与粉丝（11）

| Method | action | 标题 | 单价（快照） | 主要参数 |
|---|---|---|---|---|
| GET | `followers/active_list` | 获取授权用户活跃或互动粉丝TOP20列表 | 3000 credit/次 | `flag*` |
| GET | `followers/age_group_count` | 获取某用户粉丝的年龄段、性别细分数据 | 20000–40000 credit | `uid*` |
| GET | `followers/biz` | 获取当前登录用户的粉丝列表 | 3 credit/次 | `age` `city` `flag` `type` `bucket` `gender` `max_time` `province` `cursor_uid` |
| GET | `followers/demographics_day` | 获取用户粉丝的星座、兴趣标签和粉丝量级的细分数据 | 40000–80000 credit | `uid*` `property*` |
| GET | `followers/influence_top20` | 获取近7天转发或互动最多的粉丝TOP20（仅蓝V） | 3000 credit/次 | `uid*` `flag*` `time_span*` |
| GET | `followers/location_count` | 获取用户粉丝的地区细分数据 | 20000–40000 credit | `uid` |
| GET | `followers/online_time/biz` | 获取当前登录用户粉丝最近一周在线时段比例分布 | 9000 credit/次 | `type*` |
| GET | `followers/source` | 获取某用户粉丝的关注来源 | 20000–40000 credit | `uid` |
| GET | `followers/trend_other/biz` | 获取当前登录用户的粉丝每天增加和减少数量 | 3 credit/次 | `endtime*` `starttime*` |
| GET | `followers/unfollower_count` | 获取最长近90天内每天取消关注该账户的用户数 | 30 credit/次 | `uid*` `endtime*` `starttime*` |
| GET | `friends/biz` | 获取当前登录用户的关注列表 | 3 credit/次 | `page` `count` `trim_status` |

### search — 搜索（4）

| Method | action | 标题 | 单价（快照） | 主要参数 |
|---|---|---|---|---|
| GET | `hot_word_cate/biz` | 搜索分类榜单 | 900 credit/次 | `count` `category*` |
| GET | `hot_word/biz` | 微博热搜主榜 | 450 credit/次 | `count` |
| GET | `statuses/limited` | 搜索含某关键词的微博 | 3 credit/次 | `q*` `dup` `ids` `city` `hasv` `page` `sort` `type*` `count` `hasat` `istag` `hasori` `haspic` `hasret` `endtime` `haslink` `hastext` `antispam` `base_app` `hasmusic` `hasvideo` `is_batch` `starttime` |
| GET | `suggestions/users/biz` | 搜用户搜索建议 | 3 credit/次 | `q*` `count` |

### short_url — 短链（2）

| Method | action | 标题 | 单价（快照） | 主要参数 |
|---|---|---|---|---|
| POST | `expand` | 将一个或多个短链接还原成原始的长链接 | 3 credit/次 | `url_short*` |
| POST | `shorten` | 将一个或多个长链接转换成短链接 | 3 credit/次 | `url_long*` |

### statuses — 微博（博文）（19）

| Method | action | 标题 | 单价（快照） | 主要参数 |
|---|---|---|---|---|
| GET | `count_sp/biz` | 批量获取指定授权微博的转发数、评论数、赞数、阅读数 | 3 credit/次 | `ids*` `exclude_comment_like` |
| GET | `count/biz` | 批量获取指定微博的转发数评论数喜欢数 | 3 credit/次 | `ids*` `exclude_comment_like` |
| POST | `destroy` | 删除微博信息 | 15 credit/次 | `id*` |
| GET | `mentions/biz` | 获取@当前登录用户的微博列表 | 3 credit/次 | `page` `count` `max_id` `since_id` `filter_by_type` `filter_by_author` `filter_by_source` |
| GET | `mentions/other` | 获取@某人的微博 | 3 credit/次 | `uid*` `page` `count` `max_id` `since_id` `filter_by_type` `filter_by_author` `filter_by_source` |
| GET | `queryid/biz` | 通过微博（评论、私信）MID获取其ID | 3 credit/次 | `mid*` `type*` `inbox` `isBase62` `is_batch` |
| GET | `querymid/biz` | 通过微博（评论、私信）ID获取其MID | 3 credit/次 | `id*` `type*` `is_batch` |
| POST | `repost` | 转发一条微博信息 | 15 credit/次 | `id*` `status*` `list_id` `visible` `is_comment` `annotations` |
| GET | `repost_timeline/all` | 返回一条微博的全部转发微博列表 | 3 credit/次 | `id*` `page` `count` `max_id` `since_id` `filter_by_author` |
| GET | `repost_timeline/biz` | 获取当前登录用户发布的一条原创微博的最新转发微博 | 3 credit/次 | `id*` `page` `count` `max_id` `since_id` `filter_by_author` |
| GET | `show_batch/biz` | 根据微博ID批量获取微博信息 | 3 credit/次 | `ids*` `trim_user` `isGetLongText` |
| GET | `statistic/biz` | 返回近90天内发布的授权微博每天的被转发数、被评论数、被喜欢数、被点击数（区分短链、图片、视频点击） | 300 credit/次 | `id*` `endtime*` `starttime*` |
| POST | `update` | 发布一条微博信息 | 15 credit/次 | `lat` `long` `status*` `list_id` `visible` `annotations` `is_longtext` `mblog_statement` |
| POST | `upload` | 上传图片并发布一条微博 | 20 credit/次 | `lat` `pic*` `long` `status*` `list_id` `visible` `annotations` |
| POST | `upload_pic` | 上传图片，返回图片id | 5 credit/次 | `pic*` |
| POST | `upload_url_text` | 发布一条带单/多图的微博（需要组合上传图片接口） | 15 credit/次 | `lat` `long` `pic_id*` `status*` `list_id` `visible` `annotations` `is_longtext` `mblog_statement` |
| GET | `user_timeline_batch` | 批量获取用户个人微博列表 | 3 credit/次 | `flag` `page` `uids` `count` `feature` `base_app` |
| GET | `user_timeline/biz` | 获取当前登录用户发布的微博 | 3 credit/次 | `flag` `page` `count` `max_id` `feature` `base_app` `since_id` `trim_user` `exclude_comment_like` |
| GET | `user_timeline/other` | 获取其他用户发布的微博 | 3 credit/次 | `uid*` `flag` `page` `count` `max_id` `feature` `base_app` `end_time` `since_id` `start_time` |

### tags — 用户标签（2）

| Method | action | 标题 | 单价（快照） | 主要参数 |
|---|---|---|---|---|
| GET | `biz` | 获取当前登录用户的标签 | 3 credit/次 | `page` `count` |
| GET | `tags_batch/other` | 批量获取用户标签 | 3 credit/次 | `uids*` |

### users — 用户资料与统计（7）

| Method | action | 标题 | 单价（快照） | 主要参数 |
|---|---|---|---|---|
| GET | `behavior_trend` | 获取授权用户行为数据每日变化趋势 | 300 credit/次 | `endtime*` `starttime*` |
| GET | `behavior_trend/biz` | 获取他人用户行为数据每日变化趋势 | 100 credit/次 | `uid*` `endtime*` `starttime*` |
| GET | `counts_batch/other` | 批量获取用户的粉丝数、关注数、微博数 | 3 credit/次 | `uids*` |
| GET | `receive_like_count` | 获取某用户近90天每天的被喜欢数 | 3000 credit/次 | `uid` `endtime*` `starttime*` |
| GET | `show_batch/other` | 批量获取其他用户的基本信息 | 3 credit/次 | `uids` `screen_name` |
| GET | `show/biz` | 获取当前登录用户信息 | 3 credit/次 | — |
| GET | `statistic/biz` | 获取当前登录用户近90天每天的被点击数（区分短链、图片点击）、被阅读数、用户去重的被阅读数 | 300 credit/次 | `endtime*` `starttime*` |

### wbindex — 微博指数榜单（5）

| Method | action | 标题 | 单价（快照） | 主要参数 |
|---|---|---|---|---|
| GET | `ranking/showComing` | 综艺-待播榜 | 3000 credit/次 | `pageNum` `pageSize` `timeType` `timeRange` `portraitType` `portraitValue` |
| GET | `ranking/showHot` | 综艺-热播榜 | 3000 credit/次 | `pageNum` `pageSize` `timeType` `timeRange` `portraitType` `portraitValue` |
| GET | `ranking/tvComing` | 剧集-待播榜 | 3000 credit/次 | `pageNum` `pageSize` `timeType` `timeRange` `portraitType` `portraitValue` |
| GET | `ranking/tvHot` | 剧集-热播榜 | 3000 credit/次 | `pageNum` `pageSize` `timeType` `timeRange` `portraitType` `portraitValue` |
| GET | `ranking/tvRole` | 剧集-热议角色榜 | 3000 credit/次 | `pageNum` `pageSize` `timeType` `timeRange` `portraitType` `portraitValue` |


---

## 6. Weibo Reader 实际用到的接口

本仓库 `lib/config.js` 的 `ENDPOINTS` 与采集逻辑主要映射：

| Reader 模式 | CLI 命令 | 说明 |
|-------------|----------|------|
| 发出的评论 `sent` | `comments by_me/other --uid` | 某用户发出的评论 |
| 收到的评论 `received` | `comments to_me/other --uid` | 某用户收到的评论 |
| 发出+收到 `both` | `comments timeline/other --uid` | 合并时间线 |
| 被 @ 的评论 | `comments mentions/other --uid` | |
| 微博下评论 `post-comments` | `comments show/all --id` | 单条微博全部评论；Reader 常配 `filter_by_author` |
| 被 @ 的微博 | `statuses mentions/other --uid` | |
| 用户微博 | `statuses user_timeline/other --uid` | 支持 `start_time`/`end_time` 等 |
| 补全文/详情 | `statuses show_batch/biz --ids [--isGetLongText 1]` | |
| 用户资料 | `users show_batch/other` / `users show/biz` | 昵称或 UID |
| 账户与余额 | `me`（→ `/cli/whoami`） | 桌面「账户与设置」 |
| 登录 | `auth login --browser` | 桌面壳拉起 |
| 预检定价/能力 | `commands show <group> <action>` | 付费请求前校验 flags |

分页常用：`page`、`count`、`since_id`、`max_id`。计费一般按**接口实际返回条数/次**，本地缓存复用不计 credit（以产品说明与账单为准）。

---

## 7. 如何刷新本目录

登录后执行：

```bash
node node_modules/@weibo-ai/weibo-cli/dist/index.js commands list --all --output json > scripts/_weibo-cli-commands.json
node scripts/gen-weibo-cli-api-doc.cjs
```

或：

```bash
weibo-cli commands list --group comments --output json
weibo-cli commands show comments by_me/other --output json
```

单条 `commands show` 含完整 `flags[].description`、`pricing`、`usage_notes`、`input_schema`，实现新采集路径前应先看这一份。

---

## 8. AI / 开发注意

1. **新业务优先走** `weibo-cli <group> <action>` / `POST /cli/invoke`，不要臆造未在目录中的 action。  
2. **改 Reader 采集**时同步改 `lib/config.js` `ENDPOINTS`，并用 `commands show` 确认 flags。  
3. **Windows 登录**打开浏览器有 URL `&` 截断问题，见 [WINDOWS.md](WINDOWS.md) 与 `scripts/fix-weibo-cli-open-browser.cjs`。  
4. 单价与套餐权限会变；高价接口（如部分粉丝洞察、指数榜）调用前先展示定价。  
5. `/biz` 与 `/other` 不要混用：查别人用 `other`+`uid`，查自己用 `biz`。  
