# Weibo Reader

Weibo Reader 是一款本地微博阅读工具。可以读取并保存某位微博用户发出和收到的评论、提及该用户的内容、该用户的微博，或专门保存一条微博下面的评论。保存后，可以离线搜索、生成 HTML 报告，也可以让应用按计划检查新评论。

- **macOS（原版）**：Swift + WKWebView 桌面壳，见 `scripts/build-desktop.js` / `scripts/package-desktop.js`
- **Windows（移植版）**：Electron 桌面壳，开发与打包说明见 **[WINDOWS.md](WINDOWS.md)**（给开发者 / AI 接手用）

本工具数据获取完全依赖于微博开放平台CLI服务。如果遇到问题，欢迎反馈。

[macOS 安装包](https://github.com/selnokk/weibo-reader/releases/download/weibo-reader/Weibo-Reader.dmg) · [使用手册](weibo_reader_user_guide.md) · [Windows 移植说明](WINDOWS.md) · [weibo-cli 接口说明](WEIBO-CLI-API.md)
