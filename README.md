# Weibo Reader

Weibo Reader 是一款本地微博阅读工具。可以读取并保存某位微博用户发出和收到的评论、提及该用户的内容、该用户的微博，或专门保存一条微博下面的评论。保存后，可以离线搜索、生成 HTML 报告，也可以让应用按计划检查新评论。

- **macOS（原版）**：Swift + WKWebView 桌面壳，见 `scripts/build-desktop.js` / `scripts/package-desktop.js`
- **Windows（移植版）**：Electron 桌面壳；用户安装见下文，开发细节见 **[WINDOWS.md](WINDOWS.md)**

本工具数据获取完全依赖于微博开放平台CLI服务。如果遇到问题，欢迎反馈。

[macOS 安装包](https://github.com/selnokk/weibo-reader/releases/download/weibo-reader/Weibo-Reader.dmg) · [使用手册](weibo_reader_user_guide.md) · [Windows 移植说明](WINDOWS.md) · [weibo-cli 接口说明](WEIBO-CLI-API.md)

## Windows 安装与使用

| 包 | 用途 |
|----|------|
| `Weibo-Reader-Setup-*-x64.exe` | NSIS 安装版（可自选目录、开始菜单快捷方式） |
| `Weibo-Reader-Portable-*-x64.exe` | 便携版（免安装，直接运行） |

1. 从发布页下载上述任一安装包（或由本仓库 `npm run desktop:win:package` 本地生成到 `dist-win/`）。
2. 安装版按向导完成；便携版双击即可。首次运行若出现 SmartScreen 提示，属**未代码签名**时的常见情况，可点「更多信息 → 仍要运行」。
3. 默认资料目录：`%APPDATA%\selnokk.weibo.reader`。可在应用内改选其他目录。
4. 登录与采集依赖微博开放平台 CLI；授权页在系统浏览器中打开。

### Windows 开发 / 打包（摘要）

```bash
npm install
npm run desktop:win              # 开发启动
npm run desktop:win:package      # 生成 dist-win 安装包与便携版
```

常见问题（OAuth 截断、`EPERM`、路径、签名）：见 [WINDOWS.md](WINDOWS.md) §6。完整命令与架构也在该文档。

> 不要在 Windows 上执行 `desktop:build` / `desktop:package`（仅 macOS）。
