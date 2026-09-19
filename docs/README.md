# Nginx Desk 开发者文档

这套文档面向**第一次接触本仓库的开发者**。读完后，你应当能够：

- 说清楚软件做什么、不做什么
- 画出 Electron 三进程和 nginx 工作目录的关系
- 独立完成环境搭建、改代码、调试、跑测试、打安装包
- 按既有约定扩展功能，并知道常见故障从哪里查

仓库根目录的 [README.md](../README.md) 是产品说明和快速命令；这里是完整的系统说明书。

## 建议阅读顺序

| 顺序 | 文档 | 解决什么问题 |
|------|------|----------------|
| 1 | [项目概览](01-overview.md) | 这是什么软件？nginx 在这里扮演什么角色？ |
| 2 | [技术栈](02-tech-stack.md) | 用了哪些工具？每个工具负责哪一层？ |
| 3 | [系统架构](03-architecture.md) | 进程怎么分工？数据存在哪？一次点击如何落到 nginx？ |
| 4 | [源码导读](04-source-guide.md) | 每个文件、每条 IPC、每个关键函数做什么？ |
| 5 | [开发与调试](05-develop-and-debug.md) | 怎么跑起来、怎么改、怎么用 DevTools？ |
| 6 | [测试体系](06-testing.md) | 改完怎么证明没坏？测试覆盖了什么、没覆盖什么？ |
| 7 | [构建与发布](07-build-and-release.md) | 安装包怎么打出来？nginx 怎么打进包里？ |
| 8 | [维护与优化](08-maintain-and-optimize.md) | 升级引擎、加页面、加接口、性能与安全注意点 |
| 9 | [故障排查](09-troubleshooting.md) | 启动失败、端口占用、打包失败时怎么查 |

## 最短上手路径

如果你只想立刻改代码，按下面做即可，细节再回看对应文档：

```powershell
# 需要：Windows 10/11 x64，Node.js 22.12 或更高
npm ci
npm run prepare:nginx
npm test
npm start
```

- 业务逻辑几乎都在 `src/manager.cjs`
- 窗口、IPC、退出确认在 `src/main.cjs`
- 界面交互在 `src/renderer.js` / `src/index.html` / `src/style.css`
- 渲染进程只能通过 `window.desk.*` 访问主进程，接口定义在 `src/preload.cjs`

## 名词速查

| 词 | 含义 |
|----|------|
| 主进程 (Main) | Electron 的 Node.js 进程，能读写磁盘、拉起 nginx |
| 预加载 (Preload) | 夹在主进程和页面之间的桥，只暴露白名单 API |
| 渲染进程 (Renderer) | 真正画界面的 Chromium 页面，**没有 Node.js** |
| IPC | 渲染进程和主进程之间的消息通道 |
| 工作目录 / prefix | nginx `-p` 指向的根目录，配置和日志都相对它 |
| 内置引擎 | 安装包或 `vendor/nginx` 里自带的 `nginx.exe` |
| 用户引擎缓存 | `%APPDATA%/nginx-desk/engines`，下载过的版本放这里 |
| 独占队列 | Manager 把启动/保存/切版本串行化，避免并发踩踏 |

## 仓库地图

```
NginxDesk/
├── src/                    应用源码（会打进安装包）
├── scripts/                准备 nginx、UI 冒烟测试
├── test/                   Node 测试（含真实 nginx 集成）
├── vendor/nginx/           开发用官方 nginx（gitignore，需 prepare）
├── artifacts/              截图与验证记录（不进安装包）
├── dist/                   electron-builder 输出（gitignore）
├── docs/                   本目录
├── package.json            脚本、依赖、打包配置
└── README.md               产品说明
```
