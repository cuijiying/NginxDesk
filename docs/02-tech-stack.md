# 2. 技术栈

本项目刻意保持小：没有 React/Vue、没有 TypeScript、没有打包器（Vite/Webpack）。界面就是三个静态文件，业务就是几个 CommonJS 模块。对小白来说，这意味着你改完保存，重启 Electron 就能看到结果。

## 2.1 分层对照

```
┌─────────────────────────────────────────────────────────┐
│  界面层   HTML + CSS + 原生 JS                          │
│           src/index.html  src/style.css  src/renderer.js│
├─────────────────────────────────────────────────────────┤
│  桥梁层   Electron Preload + contextBridge              │
│           src/preload.cjs  →  window.desk.*             │
├─────────────────────────────────────────────────────────┤
│  桌面层   Electron Main                                 │
│           src/main.cjs  窗口、对话框、IPC、单实例       │
├─────────────────────────────────────────────────────────┤
│  领域层   纯 Node.js（不依赖 Electron）                 │
│           src/manager.cjs  nginx 进程、配置、版本、日志 │
│           src/platform.cjs 操作系统差异                 │
│           src/unix-build.cjs  macOS/Linux 源码编译      │
├─────────────────────────────────────────────────────────┤
│  系统层   Windows / macOS / Linux + 官方 nginx          │
└─────────────────────────────────────────────────────────┘
```

**领域层不依赖 Electron** 是刻意设计：`test/manager.test.cjs` 可以直接 `require` Manager，用临时目录跑真实 nginx，不必打开窗口。

## 2.2 运行时与语言

| 技术 | 版本（以 `package.json` 为准） | 用途 |
|------|--------------------------------|------|
| Node.js | ≥ 22.12 | 开发、测试、打包脚本；主进程也是 Node |
| JavaScript | CommonJS（`.cjs`）+ 浏览器 ES | 主进程/测试用 CJS；渲染进程是普通 `<script>` |
| Electron | 44.4.1 | 把 Chromium 页面和 Node 主进程包成桌面程序 |
| electron-builder | 26.8.1 | 打 Windows NSIS、macOS DMG/ZIP、Linux AppImage/deb |
| nginx | 开发默认 1.31.6（可在应用内切换） | 真正提供 HTTP 服务 |
| node:test | Node 内置 | 单元测试 + 真实 nginx 集成测试 |

为什么文件叫 `.cjs`：仓库没有 `"type": "module"`，但用 `.cjs` 可以明确「这是 CommonJS，给 Electron 主进程和 Node 测试用」，避免以后若改成 ESM 时主进程加载混乱。

## 2.3 Electron 三件套（必须先懂）

Electron 同时开了两个世界：

1. **主进程**：一个 Node.js 进程。可以 `require('fs')`、`child_process`、弹系统对话框。本项目入口是 `package.json` 的 `"main": "src/main.cjs"`。
2. **渲染进程**：一个（或多个）Chromium 标签页。默认**不能**直接读盘或启动进程。本项目只有一个窗口。
3. **预加载脚本**：在页面 JS 运行之前执行，能同时碰到有限的 Electron API。它用 `contextBridge.exposeInMainWorld('desk', api)` 把安全函数挂到 `window.desk`。

本项目的安全开关（见 `src/main.cjs`）：

| 开关 | 值 | 含义 |
|------|----|------|
| `contextIsolation` | `true` | 页面 JS 和 preload 不在同一个 JS 世界，页面改不了桥 |
| `nodeIntegration` | `false` | 页面里没有 `require`、`process` |
| `sandbox` | `true` | 渲染进程进一步锁死 |
| CSP | `default-src 'self'` 等 | 页面不能外连、不能内联脚本 |
| 导航 | `will-navigate` 全部拦截 | 页面不能跳到外站 |
| 弹窗 | `setWindowOpenHandler` deny | 不能 `window.open` |

因此：**所有危险操作必须走 IPC**。preload 里写死了 12 个方法名，主进程再校验「请求来自本机 `index.html`」。

## 2.4 没有选用的技术（以及原因）

| 常见选择 | 本项目为什么不用 |
|----------|------------------|
| React / Vue | 六个静态页面 + 少量 DOM 操作，框架成本高于收益 |
| TypeScript | 代码量小，CJS + 测试已能约束关键输入 |
| Express / 本地 HTTP API | 桌面应用用 IPC 即可，不必再开端口 |
| 系统服务 | 产品定位是当前用户的桌面管理器 |
| 前端打包器 | 三个静态文件，Electron `loadFile` 直接加载 |
| 自动更新 | 未做；发布走 GitHub Releases |

以后若要加复杂表单或状态管理，优先仍保持「渲染进程无 Node」，新能力加在 Manager + IPC，而不是把 `fs` 暴露给页面。

## 2.5 关键 Node 能力怎么用

`src/manager.cjs` 只用标准库，操作系统细节交给 `src/platform.cjs`：

| API | 用在哪 |
|-----|--------|
| `fs/promises` | 读配置、写备份、拷贝引擎、扫目录 |
| `child_process.execFile` | `nginx -t / -s / -v`，以及各平台的进程查询和 `tar` |
| `child_process.spawn` | **启动** nginx：`detached: true`，让它脱离 Electron 生命周期 |
| `fetch` | 拉 `https://nginx.org/en/download.html` 和官方发行包 |
| `path` | 拼接工作目录；`file()` 用正则白名单防路径穿越 |

启动不用 `execFile` 而用 `spawn` + `detached` + `unref`：否则 Electron 退出时可能把 nginx 一起带走，和「保持 nginx 运行并退出」冲突。

## 2.6 构建期工具

- **`scripts/prepare-nginx.cjs`**：若 `vendor/nginx` 里还没有当前平台的引擎，就从 nginx.org 下载固定版本并校验 SHA256。Windows 解压官方 zip；macOS / Linux 解压官方源码后编译到 `vendor/nginx/nginx`。开发、测试、打包都依赖它。`scripts/prepare-nginx.ps1` 只是调用同一脚本的薄封装。
- **`electron-builder`**：把 `src/**/*` 和 `package.json` 打进应用，再把 `vendor/nginx` 作为 `extraResources` 拷到资源目录 `nginx`。详见 [构建与发布](07-build-and-release.md)。
- **`scripts/ui-smoke.cjs`**：用临时 `userData` 启动真实窗口，在页面里执行 JS 断言，并截图到 `artifacts/desktop-smoke.png`。

## 2.7 各平台依赖

| 系统 | 开发 / 打包还需要 |
|------|-------------------|
| Windows 10/11 | 系统自带的 `powershell.exe`（查进程路径）、`tar.exe`（解压官方 zip） |
| macOS 12+ | Xcode Command Line Tools（`clang`、`make`、`tar`）；`lsof` 或 `ps` 用于核对进程 |
| Linux | `gcc`、`make`、`tar`；建议安装 pcre/zlib/openssl 开发库。进程路径读 `/proc/<pid>/exe` |

没有这些，版本切换或「是否为本实例」检测会失败。安装包用户不需要 Node.js；macOS / Linux 安装包里已经带上构建机编译好的引擎。应用内再装其他版本时，macOS / Linux 仍需要本机编译工具。
