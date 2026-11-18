# Weibo Reader — Windows 移植说明（给开发者 / AI）

本文说明本仓库在 **Windows** 上的桌面移植版：架构、目录、命令、协议约定与常见坑。后续在 Windows 移植版上加功能时，请先读完本文，再改代码。

相关产品说明仍见 [README.md](README.md)、[weibo_reader_user_guide.md](weibo_reader_user_guide.md)。  
weibo-cli 请求接口见 **[WEIBO-CLI-API.md](WEIBO-CLI-API.md)**。  
macOS 原版打包仍见 `scripts/build-desktop.js` / `scripts/package-desktop.js`（**仅能在 Apple Silicon macOS 上执行**）。

---

## 1. 一句话结论

| 平台 | 桌面壳 | UI | 业务引擎 |
|------|--------|----|----------|
| macOS（原版） | Swift + AppKit + WKWebView（`desktop/WeiboReader.swift`） | `desktop/ui/*` | `desktop/bridge.js` + `lib/*` + `@weibo-ai/weibo-cli` |
| **Windows（移植）** | **Electron**（`desktop/win/*`） | **同一套** `desktop/ui/*` | **同一套** bridge / lib / weibo-cli |

Windows 版目标是：**复用引擎与 Web UI，只替换原生壳**。新功能应优先做在共享层（`desktop/ui`、`desktop/bridge.js`、`lib/`），避免只写进 Electron 或只写进 Swift。

---

## 2. 架构与数据流

```
┌─────────────────────────────────────┐
│  Electron 主进程 desktop/win/main.js │  ← 窗口、对话框、开文件/外链、启停引擎
│  preload.js → window.webkit.messageHandlers.weibo
└───────────────┬─────────────────────┘
                │ IPC: weibo-ui / executeJavaScript(weiboReceive)
┌───────────────▼─────────────────────┐
│  Chromium 渲染：desktop/ui/index.html │  ← 与 macOS WKWebView 相同前端
└───────────────┬─────────────────────┘
                │ 壳 ↔ 引擎：stdin/stdout JSON 行协议
┌───────────────▼─────────────────────┐
│  Node 引擎：desktop/bridge.js         │  ELECTRON_RUN_AS_NODE=1
│  采集/登录：@weibo-ai/weibo-cli        │
│  领域逻辑：lib/*、weibo_cli.js         │
└─────────────────────────────────────┘
```

### 2.1 与 macOS 壳对齐的职责

Electron 主进程应继续对齐 `desktop/WeiboReader.swift` 的行为，包括但不限于：

- 启动 `desktop/bridge.js --workspace <path> --wait-for-ready --native-startup`
- 向引擎写 JSON 行；读引擎 stdout JSON 行并调用 `window.weiboReceive(...)`
- UI → 壳：`window.webkit.messageHandlers.weibo.postMessage(action对象)`（由 preload 注入）
- 处理：`ready` / `frontendAttach`、`chooseWorkspace`、`chooseDataExport` / `chooseDataImport`、`copy`、`external`、`open`（报告/文件夹）、登录与本地查询转发等
- 工作区握手：`library` → `nativeWorkspaceAccepted`
- 退出：向引擎发 `shutdown`，等待空闲后再结束进程

权威行为参考：`desktop/WeiboReader.swift`。Windows 实现：`desktop/win/main.js`。

### 2.2 前端通信约定（不要拆掉）

`desktop/ui/app.js` 发送逻辑：

1. 优先 `window.webkit.messageHandlers.weibo.postMessage(...)`
2. 否则 `window.weiboBrowserHarness(...)`（测试/浏览器夹具）
3. 否则提示「请在 Weibo Reader 应用中执行」

Windows preload **必须**继续提供 `webkit.messageHandlers.weibo`，以便 UI 无需分支。

---

## 3. 关键路径与文件

```
desktop/win/
  main.js            Electron 入口（package.json "main"）
  preload.js         注入 weiboAppInfo + webkit.messageHandlers.weibo
  external-links.js  外链白名单（移植自 ExternalLinks.swift）

desktop/ui/          共享 UI（改功能多半改这里）
desktop/bridge.js    共享桌面引擎（改任务/登录/导出多半改这里）
lib/                 共享领域库
weibo_cli.js         CLI 聚合入口

scripts/
  fix-weibo-cli-open-browser.cjs   Windows OAuth 打开浏览器补丁（postinstall）
  build-desktop.js / package-desktop.js   仅 macOS

dist-win/            Windows 打包输出（gitignore）
```

### 3.1 运行时路径

| 用途 | 路径 |
|------|------|
| 默认资料目录（工作区） | `%APPDATA%\selnokk.weibo.reader` |
| Electron 壳状态（上次工作区等） | `%APPDATA%\weibo-reader\shell-state.json` |
| 开发时工程根 | 仓库根目录；打包后为 `app.getAppPath()` |

---

## 4. 常用命令

环境：Windows x64，已安装 Node.js（建议 18/20/22 LTS；本机曾用 21 也可跑）。

```bash
# 安装依赖（会跑 postinstall 补丁）
npm install

# 若 Electron 二进制下载慢，可先设镜像再装：
#   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
#   set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

# 开发启动 Windows 桌面
npm run desktop:win

# 打 Windows 安装包 + 便携版 → dist-win/
npm run desktop:win:package
```

无证书时脚本会自动 `CSC_IDENTITY_AUTO_DISCOVERY=false` 并关闭可执行文件签名编辑（避免 winCodeSign 符号链接失败）。

### 4.1 打包产物

| 文件 | 含义 |
|------|------|
| `dist-win/Weibo-Reader-Setup-*.exe` | NSIS 安装包 |
| `dist-win/Weibo-Reader-Portable-*.exe` | 便携版 |
| `dist-win/win-unpacked/` | 未压缩应用目录 |

配置在 `package.json` 的 `"build"` 字段与 `scripts/package-win.cjs`。

体积相关（安装包约 60MB 级；未压缩目录大头是 `Weibo Reader.exe` ≈180MB）：

| 手段 | 作用 |
|------|------|
| `electronLanguages: en-US / zh-CN` | 丢掉其余 Chromium 语言包（含 zh-TW） |
| `afterPack`（`scripts/after-pack-win.cjs`） | 删除 `LICENSES.chromium.html`（约 8–9MB）并清多余 locale |
| `compression: maximum` + `nsis.differentialPackage: false` | 提高安装包压缩比（放弃 blockmap 增量更新） |
| `files` 排除 Swift / 测试 / md 许可 / electron 开发依赖 | 应用层约数 MB |
| `npmRebuild: false` | 无原生模块，加快打包 |
| `asar: false` | **有意为之**：引擎用 `ELECTRON_RUN_AS_NODE` 直接跑 `bridge.js` |

启动：`main.js` 先加载 UI、再 `setImmediate` 拉起引擎；去掉应用菜单、关闭拼写检查，并设置 `lang=zh-CN`。再往下压体积需要换壳或裁剪 Electron 本体，性价比低。

### 4.2 代码签名（Authenticode）

未签名安装包首次运行可能被 SmartScreen 拦截，属预期。要消除警告需要 **向 CA 购买的代码签名证书**（OV/EV；自签证书对 SmartScreen 基本无效）。

```bat
set CSC_LINK=C:\certs\weibo-reader.pfx
set CSC_KEY_PASSWORD=你的证书密码
npm run desktop:win:package
```

也可用 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`。证书路径也支持 `file://` 或 https URL（electron-builder 约定）。

签名成功后可用：

```bat
signtool verify /pa "dist-win\Weibo-Reader-Setup-1.0.0-x64.exe"
```

（需安装 Windows SDK 的 `signtool`。）

**不要**把 `.pfx` / 密码提交进仓库；本仓库 `.gitignore` 已忽略 `*.pfx` / `*.pem` / `.env*`。

### 4.3 不要在 Windows 上跑这些

```bash
npm run desktop:build     # 需要 darwin + arm64 + swiftc
npm run desktop:package   # 需要 hdiutil / codesign
```

---

## 5. 在 Windows 版上开发新功能的建议流程

1. **先判断改哪一层**
   - 纯界面 / 交互 → `desktop/ui/`
   - 桌面任务调度、与 CLI 交互 → `desktop/bridge.js` 或 `desktop/*.js`
   - 存储、报告、采集算法 → `lib/`
   - 仅 Windows 系统能力（托盘、开机启动、特殊对话框）→ `desktop/win/main.js`（并在 Swift 侧考虑是否要对齐）

2. **保持 JSON 协议兼容**  
   UI `action` / 引擎 `type` 变更时，同时检查：
   - `desktop/ui/app.js`（及各 UI 模块）
   - `desktop/bridge.js`
   - `desktop/win/main.js` 的转发白名单（`LOCAL_ACTIONS` / `FORWARD_ACTIONS` / `TRANSPORT_SAFE`）
   - `desktop/WeiboReader.swift`（若仍维护 macOS）

3. **本地验证**
   ```bash
   npm run desktop:win
   ```
   打开资料目录与登录状态后，再测采集 / 报告 / 订阅等。

4. **需要分发时再打包**
   ```bash
   npm run desktop:win:package
   ```
   有证书时带上 `CSC_LINK` / `CSC_KEY_PASSWORD`（见 §4.2）。

5. **尽量少改 `node_modules`**  
   对 `@weibo-ai/weibo-cli` 的必要修补应落在 `scripts/fix-weibo-cli-open-browser.cjs`，并由 `postinstall` 自动应用。升级 weibo-cli 后若补丁失效，脚本会告警，需更新补丁。

---

## 6. 已知 Windows 问题与对策

### 6.1 登录页报错缺少 `redirect_uri` / `code_challenge`

**现象：** 浏览器打开授权页后出现  
`Validation failed: query.redirect_uri: Required, query.code_challenge: Required`

**原因：** weibo-cli 在 Windows 用 `cmd /c start` 打开 OAuth URL，`&` 被 cmd 当成命令分隔符，查询串被截断。

**对策：** `scripts/fix-weibo-cli-open-browser.cjs` 将打开方式改为  
`rundll32.exe url.dll,FileProtocolHandler <url>`。  
`npm install` / `postinstall` 会自动打补丁。若手动删过 `node_modules`，请重新 `npm install`。

### 6.2 electron-builder / winCodeSign 解压失败

**现象：** 解压 `winCodeSign` 时提示无法创建符号链接。

**对策：** 无证书打包时 `scripts/package-win.cjs` 已设置  
`CSC_IDENTITY_AUTO_DISCOVERY=false` 且 `signAndEditExecutable=false`。  
有证书签名时会临时打开 `signAndEditExecutable`（可能需要管理员权限或 Developer Mode 以创建符号链接）。

### 6.3 Electron 下载缓慢

设置 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 为 npmmirror（见上文）。

### 6.4 `EPERM: operation not permitted, fsync`

**现象：** 开始获取 / 保存接口响应时报 `EPERM … fsync`（可能连打两次）。

**原因：** 落盘路径会对**父目录**再做一次 `fsync`；Windows/NTFS 对目录句柄的 `fsync` 固定返回 `EPERM`。

**对策：** 已由 `lib/fs-sync.js` 处理——文件仍强制 `fsync`，目录同步在 Windows 上忽略 `EPERM`。请用仓库源码或重新 `npm run desktop:win` / 重新打包后再试；旧的 `dist-win` 需重打才带上修复。

### 6.4b `EPERM … rename '…session.lock.claim-…' -> '…session.lock'`

**现象：** 获取结束或订阅调度时报数据锁改名 `EPERM`；提示已保存正文不受影响。

**原因：** Windows 在目标锁目录已存在时，`rename` 常返回 `EPERM`（不是 Unix 的 `EEXIST`），旧逻辑未走「回收过期锁后重试」。

**对策：** `lib/process-lease.js` 将 Win32 的 `EPERM`/`EACCES` 视为锁冲突并回收后重试。请用新包或 `npm run desktop:win`；若仍失败，关掉重复打开的 Reader 实例，并检查资料目录是否被杀毒拦截。

### 6.5 路径与进程

- 工作区路径用 `path.isAbsolute`（Windows 为 `C:\...`，不要用「必须以 `/` 开头」判断）。
- 引擎子进程通过 `ELECTRON_RUN_AS_NODE=1` + `process.execPath` 启动，与打包后的 Electron 一体，不必再捆绑独立 Node。
- 进程组信号（`kill(-pid)`）在 Windows 上不可用；退出逻辑以 `shutdown` + `child.kill()` 为主（见 `main.js`）。

### 6.6 功能完整度差异（相对 macOS）

Windows Electron 壳已覆盖主路径：窗口、工作区、导入导出对话框、打开报告/文件夹、外链白名单、复制、登录/任务转发。  
以下为简化或未 1:1 移植，改到相关功能时注意：

- 原生菜单栏 / 睡眠唤醒 `followWake` 等
- macOS 完整 FeedbackDiagnostics 持久化与诊断快照（Windows 为简化反馈）
- App 图标仍为 Electron 默认图标（未做 icns/ico 品牌资源）

---

## 7. 协议速查（扩展功能时）

### UI → 壳（部分）

| action | 处理方 |
|--------|--------|
| `ready` | 壳：标记 UI 就绪，发 `frontendAttach` |
| `login` / `account` / `run` / `stop` … | 多数转发引擎 |
| `chooseWorkspace` | 壳：目录对话框 → 引擎 `workspace` |
| `chooseDataExport` / `chooseDataImport` | 壳：存盘/打开 `.wrdpack` |
| `external` | 壳：白名单后 `shell.openExternal` |
| `copy` | 壳：剪贴板 |
| `localExport` / `localInventory` / … | 壳转发引擎（写入类会记入 localWriters） |

### 引擎 → UI（部分）

| type | 含义 |
|------|------|
| `library` | 工作区快照；壳据此 `nativeWorkspaceAccepted` |
| `open` | 壳用系统打开报告或文件夹，再回 `browserOpened` / handoff |
| `started` / `finished` / `log` / `credits` … | UI 状态与进度 |
| `engineStopped` / `engineTransportError` | UI 进入引擎不可用态 |

更完整列表以 `desktop/bridge.js` 的 `publish`/`handle` 与 `desktop/ui/*.js` 的 `weiboReceive` 分支为准。

---

## 8. AI 助手工作备忘

- **默认平台语境：** 用户在本仓库谈「桌面版 / 打包 / 安装」且未写 macOS 时，优先按 **Windows Electron 移植版** 处理。
- **不要**尝试在 Windows 上生成 `.dmg` 或运行 Swift 构建。
- **改 UI/引擎时**同步检查 `desktop/win/main.js` 白名单是否需要新增 `action`。
- **改登录/打开浏览器相关**时核对 weibo-cli 补丁是否仍生效。
- **提交前**不要把 `dist-win/`、个人 `data/`、凭据、`.wrdpack` 打进版本库。
- 用户若只要开发调试：`npm run desktop:win` 即可；只有要分发时才 `desktop:win:package`（签名见 §4.2）。

---

## 9. 版本与依赖锚点（撰写时）

- 应用版本：`package.json` → `version` + `buildNumber`
- Electron：`devDependencies.electron`（曾用 33.4.x）
- 打包：`electron-builder`，输出目录 `dist-win`
- 服务 CLI：`@weibo-ai/weibo-cli`

升级 Electron / weibo-cli / electron-builder 后，请回归：启动、登录授权、选工作区、打开报告、导出/导入、退出。
