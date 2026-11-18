'use strict';
const fs = require('node:fs');
const path = require('node:path');

const catalogPath = path.join(__dirname, '_weibo-cli-commands.json');
const tablesPath = path.join(__dirname, '_weibo-cli-tables.md');
const outPath = path.join(__dirname, '..', 'WEIBO-CLI-API.md');

const j = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const cmds = j.commands || [];
const by = {};
for (const c of cmds) (by[c.group] ??= []).push(c);

const groupDesc = {
  article: '头条文章 / V+ 专栏',
  attitudes: '表态（点赞等）',
  comments: '评论',
  friendships: '关注与粉丝',
  search: '搜索',
  short_url: '短链',
  statuses: '微博（博文）',
  tags: '用户标签',
  users: '用户资料与统计',
  wbindex: '微博指数榜单'
};

function esc(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
function flags(c) {
  const list = (c.flags || []).map(f => '`' + f.name + (f.required ? '*' : '') + '`');
  return list.length ? list.join(' ') : '—';
}
function price(c) {
  const p = c.pricing;
  if (p && p.unit_price != null) return p.unit_price + ' credit/次';
  if (p && p.min_price != null) {
    return p.min_price + (p.max_price != null && p.max_price !== p.min_price ? '–' + p.max_price : '') + ' credit';
  }
  return '—';
}

let tables = '';
for (const g of Object.keys(by).sort()) {
  tables += '\n### ' + g + ' — ' + (groupDesc[g] || g) + '（' + by[g].length + '）\n\n';
  tables += '| Method | action | 标题 | 单价（快照） | 主要参数 |\n|---|---|---|---|---|\n';
  for (const c of by[g].sort((a, b) => a.action.localeCompare(b.action))) {
    tables += '| ' + c.method + ' | `' + c.action + '` | ' + esc(c.title || c.description) + ' | ' + price(c) + ' | ' + flags(c) + ' |\n';
  }
}
fs.writeFileSync(tablesPath, tables);

const generatedAt = new Date().toISOString().slice(0, 10);
const doc = `# weibo-cli 接口说明（给开发者 / AI）

> 基于本仓库依赖 \`@weibo-ai/weibo-cli@${require('../node_modules/@weibo-ai/weibo-cli/package.json').version}\` 的源码，以及登录后拉取的平台命令目录快照（共 **${j.total}** 条，分组：${(j.groups || []).join(', ')}）。  
> 快照日期：${generatedAt}。平台会增减命令与改价，**以线上 \`commands list / show\` 为准**。

相关文档：[README.md](README.md) · [WINDOWS.md](WINDOWS.md) · 上游 README：\`node_modules/@weibo-ai/weibo-cli/README.md\`

---

## 1. 两层模型：CLI 命令 ≠ 唯一 HTTP 路径

\`weibo-cli\` 对调用方暴露的是 **命令行**：

\`\`\`bash
weibo-cli <group> <action> [--flag value ...] [--output json]
\`\`\`

对开放平台，绝大多数业务命令最终都走同一个业务入口：

| 层级 | 说明 |
|------|------|
| **固定 HTTP 面** | OAuth、账号元数据、命令目录、统一调用、Skills 等（见第 3 节） |
| **动态业务面** | \`POST /cli/invoke\`，body 里带 \`group\` + \`action\` + \`args\`；具体有哪些 group/action 由服务端目录决定（见第 5 节） |

因此：**写文档时要区分「CLI 内建命令」和「平台动态 API」**。动态 API 不要写死成永久契约，升级后应用 \`commands show\` 再确认 flags / 定价。

---

## 2. 环境与基址

| 项 | 生产 | 开发（\`NODE_ENV=development\`） |
|----|------|----------------------------------|
| App 基址 | \`https://open.weibo.com/cli\` | \`https://open-dev.weibo.com/cli\` |
| API 基址（\`DEFAULT_API_BASE_URL\`） | \`https://open.weibo.com/cli/api\` | \`https://open-dev.weibo.com/cli/api\` |
| 本地配置目录 | \`~/.weibo-cli\` | \`~/.weibo-cli-dev\` |

认证：请求头 \`Authorization: Bearer <access_token>\`。  
令牌优先级：环境变量 \`WEIBO_CLI_TOKEN\` / \`WEIBO_TOKEN\`（或 refresh 对应变量）> 本机钥匙串 / 加密文件 > \`--token\`（不推荐）。

全局 CLI 参数：\`--output json|table|yaml|raw\` · \`--agent <name>\` · \`-h/--help\`。

---

## 3. 固定 HTTP 接口（CLI 源码内写死）

以下路径均相对 **API 基址**（默认 \`https://open.weibo.com/cli/api\`）。

### 3.1 OAuth / 会话

| Method | Path | 功能 |
|--------|------|------|
| GET（浏览器） | \`/oauth/authorize\` | 授权码 + PKCE 登录页；需 \`response_type\`, \`client_id=weibo-cli\`, \`redirect_uri\`, \`state\`, \`code_challenge\`, \`code_challenge_method=S256\`，可选 \`device_name\` |
| POST | \`/oauth/token\` | 换票：\`authorization_code\`（需 \`code\`+\`code_verifier\`+\`redirect_uri\`）或 \`refresh_token\`；设备码则用 \`urn:ietf:params:oauth:grant-type:device_code\` |
| POST | \`/oauth/device/code\` | 发起设备码登录 |
| POST | \`/oauth/revoke\` | 吊销会话 |
| GET | \`/oauth/userinfo\` | 用 access token 取用户基本信息 |

本地回跳：\`http://127.0.0.1:<port>/callback\`（CLI 起临时 HTTP 服务接收 \`code\`）。

对应 CLI：\`auth login\`（\`--browser\` / \`--device\`）、\`auth logout\` / \`auth revoke\`。

### 3.2 注册引导

| Method | Path | 功能 | CLI |
|--------|------|------|-----|
| POST | \`/onboarding/sms/send\` | 发送短信验证码，body: \`{ phone }\` | \`auth sms-send --phone\` |
| POST | \`/onboarding/register\` | 短信注册/登录，body: phone + code + 可选会话名 | \`auth register\` |

### 3.3 CLI 元数据与统一调用

| Method | Path | 功能 | CLI |
|--------|------|------|-----|
| GET | \`/cli/whoami\` | 当前用户、套餐、余额、服务状态等 | \`auth whoami\`、\`me\`、\`doctor\` |
| GET | \`/cli/version\` | 服务端公布的最新 CLI 版本 | \`version\` / \`check_update\` / \`upgrade\` |
| GET | \`/cli/commands\` | 命令目录；可用 \`?group=\` 过滤 | \`commands list\` |
| GET | \`/cli/commands/{group}/{action}\` | 单命令元数据（flags、定价、schema） | \`commands show\`；业务调用前也会先查 |
| POST | \`/cli/invoke\` | **统一业务调用** | \`weibo-cli <group> <action> ...\` |

#### \`POST /cli/invoke\` 请求体（概念）

\`\`\`json
{
  "group": "comments",
  "action": "by_me/other",
  "args": { "uid": "123", "count": "50", "page": "1" }
}
\`\`\`

CLI 会先 \`GET /cli/commands/{group}/{action}\` 校验允许的 flags，再 POST invoke。  
可选请求头：\`User-Agent: weibo-cli/<ver>\`、\`X-Weibo-Agent-Source\` / \`X-Weibo-Agent-Host\` / \`X-Weibo-Source-Method\`（\`--agent\`）。

### 3.4 Skills（Agent 技能市场）

| Method | Path | 功能 | CLI |
|--------|------|------|-----|
| GET | \`/skills\` | 列表 | \`skill list\` |
| GET | \`/skills?search=\` | 搜索 | \`skill search\` |
| GET | \`/skills/{name}\` | 详情 | \`skill info\` |
| GET | \`/skills/{name}/bundle\` | 下载安装包（可带 version） | \`skill install\` |
| POST | \`/cli/skills/publish\` | 发布技能（含 zip_base64 等） | \`skill publish\` |

Hub 页面：\`https://open.weibo.com/cli/skills\` · 套餐页：\`https://open.weibo.com/cli/plan\`。

---

## 4. 内建 CLI 命令（非 /cli/invoke）

| 命令 | 作用 |
|------|------|
| \`auth login [--browser\\|--device] [--name]\` | OAuth 登录 |
| \`auth sms-send\` / \`auth register\` | 短信注册登录 |
| \`auth whoami\` / \`auth token[--export]\` / \`auth logout\` | 会话查询与退出 |
| \`me\` | 账户、余额、用量（基于 whoami 等） |
| \`doctor\` | 登录与服务就绪检查 |
| \`commands list\\|show\` | 浏览/查看平台命令定义 |
| \`skill …\` | 技能市场 |
| \`version\` / \`check_update\` / \`upgrade\` | 版本与升级提示（upgrade 只打印 npm 命令） |

\`update\`、\`check-update\`、\`auth revoke\` 为兼容别名。

---

## 5. 平台动态业务命令目录（快照）

命名习惯：

- \`…/biz\`：多针对**当前登录用户**（\`is_myself\`）
- \`…/other\`：查询**其他用户**（通常要 \`uid\` / \`uids\` / \`screen_name\`）
- \`…/all\`：更广范围列表（如某条微博下全部评论）

单价单位为 **credit**；下表为文档生成时的快照，**以 \`commands show\` 实时返回为准**。参数名后 \`*\` 表示目录标记为必填。

${tables}

---

## 6. Weibo Reader 实际用到的接口

本仓库 \`lib/config.js\` 的 \`ENDPOINTS\` 与采集逻辑主要映射：

| Reader 模式 | CLI 命令 | 说明 |
|-------------|----------|------|
| 发出的评论 \`sent\` | \`comments by_me/other --uid\` | 某用户发出的评论 |
| 收到的评论 \`received\` | \`comments to_me/other --uid\` | 某用户收到的评论 |
| 发出+收到 \`both\` | \`comments timeline/other --uid\` | 合并时间线 |
| 被 @ 的评论 | \`comments mentions/other --uid\` | |
| 微博下评论 \`post-comments\` | \`comments show/all --id\` | 单条微博全部评论；Reader 常配 \`filter_by_author\` |
| 被 @ 的微博 | \`statuses mentions/other --uid\` | |
| 用户微博 | \`statuses user_timeline/other --uid\` | 支持 \`start_time\`/\`end_time\` 等 |
| 补全文/详情 | \`statuses show_batch/biz --ids [--isGetLongText 1]\` | |
| 用户资料 | \`users show_batch/other\` / \`users show/biz\` | 昵称或 UID |
| 账户与余额 | \`me\`（→ \`/cli/whoami\`） | 桌面「账户与设置」 |
| 登录 | \`auth login --browser\` | 桌面壳拉起 |
| 预检定价/能力 | \`commands show <group> <action>\` | 付费请求前校验 flags |

分页常用：\`page\`、\`count\`、\`since_id\`、\`max_id\`。计费一般按**接口实际返回条数/次**，本地缓存复用不计 credit（以产品说明与账单为准）。

---

## 7. 如何刷新本目录

登录后执行：

\`\`\`bash
node node_modules/@weibo-ai/weibo-cli/dist/index.js commands list --all --output json > scripts/_weibo-cli-commands.json
node scripts/gen-weibo-cli-api-doc.cjs
\`\`\`

或：

\`\`\`bash
weibo-cli commands list --group comments --output json
weibo-cli commands show comments by_me/other --output json
\`\`\`

单条 \`commands show\` 含完整 \`flags[].description\`、\`pricing\`、\`usage_notes\`、\`input_schema\`，实现新采集路径前应先看这一份。

---

## 8. AI / 开发注意

1. **新业务优先走** \`weibo-cli <group> <action>\` / \`POST /cli/invoke\`，不要臆造未在目录中的 action。  
2. **改 Reader 采集**时同步改 \`lib/config.js\` \`ENDPOINTS\`，并用 \`commands show\` 确认 flags。  
3. **Windows 登录**打开浏览器有 URL \`&\` 截断问题，见 [WINDOWS.md](WINDOWS.md) 与 \`scripts/fix-weibo-cli-open-browser.cjs\`。  
4. 单价与套餐权限会变；高价接口（如部分粉丝洞察、指数榜）调用前先展示定价。  
5. \`/biz\` 与 \`/other\` 不要混用：查别人用 \`other\`+\`uid\`，查自己用 \`biz\`。  
`;

fs.writeFileSync(outPath, doc);
console.log('Wrote', outPath, 'bytes', fs.statSync(outPath).size);
