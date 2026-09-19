# 5. 开发与调试

## 5.1 环境要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10/11 x64 |
| Node.js | 22.12 或更高（`node -v`） |
| npm | 随 Node 安装即可 |
| 网络 | 第一次 `npm ci`、`prepare:nginx`、拉官方版本列表需要 |
| Git | 可选，克隆仓库用 |

不需要预先安装 nginx，也不需要配置 `PATH`。

建议用 PowerShell 或 Windows Terminal，工作目录切到仓库根：

```powershell
cd D:\git_files\soft-tools\NginxDesk
```

## 5.2 第一次把项目跑起来

```powershell
npm ci
npm run prepare:nginx
npm test
npm start
```

| 命令 | 成功时你应看到 |
|------|----------------|
| `npm ci` | `node_modules/` 出现，`electron` 已下载 |
| `prepare:nginx` | `vendor/nginx/nginx.exe` 存在；已存在则立刻 exit 0 |
| `npm test` | 两个测试通过（集成测试约 1–2 分钟，要起真 nginx） |
| `npm start` | 弹出深色窗口「Nginx Desk」 |

`npm ci` 按 `package-lock.json` 安装，团队协作时比 `npm install` 更可复现。只有当你有意升级依赖时才用 `npm install`。

若 `prepare:nginx` 报 checksum mismatch：不要强行跳过。核对 `scripts/prepare-nginx.ps1` 里的版本和 SHA256 是否仍对应 nginx.org 上的文件。

## 5.3 日常开发循环

1. 用编辑器改 `src/` 下文件
2. **关掉** Electron 窗口（主进程代码改了必须重启；只改渲染进程时，有的环境能 reload，但本项目没开热更新，重启最稳）
3. 再执行 `npm start`
4. 改 Manager 或纯函数后跑 `npm test`
5. 改窗口、preload、导航、表单后跑 `npm run test:ui`

渲染进程改动想快一点：窗口聚焦时试 `Ctrl+R` 刷新页面。主进程、preload、Manager **必须整进程重启** 才生效。

## 5.4 调试渲染进程（界面）

窗口打开后：

1. `Ctrl+Shift+I` 打开 Chromium DevTools
2. **Console**：看 `renderer.js` 抛出的错误
3. **Elements**：看 `data-theme`、`.page.active`、按钮 `disabled`
4. **Application → Local Storage**：键 `nd-theme`

在 Console 里可以手动调桥（只读示例）：

```js
await window.desk.state()
```

若这里报错，问题在 preload/主进程/Manager，不是 CSS。

常见界面断点位置：

- `task`：所有按钮点击的入口
- `state`：轮询和状态刷新
- `site-form` 的 `onsubmit`：生成配置

## 5.5 调试主进程（nginx 与 IPC）

`npm start` 所用终端就是主进程的 stdout/stderr。`console.log` 写在 `main.cjs` / `manager.cjs` 会打到这里。

用 VS Code / Cursor 附加调试：

1. 启动配置类型选 `node`，运行 `npx electron .`，或使用 Electron 官方 launch 模板
2. 在 `ipcMain.handle` 回调、`Manager.action`、`Manager.save` 下断点
3. 界面点按钮，断点应命中

判断 IPC 有没有进来：临时在 handler 里打印 `name` 和 `arg`。若完全没打印，检查 preload 方法名是否写错，或页面是否真的调用了 `window.desk.xxx`。

来源校验失败会抛「不可信的请求来源」。UI 冒烟和正常 `loadFile` 都走 `file://` + 绝对路径；不要改成从 http 服务器加载页面，除非同步改这份校验。

## 5.6 调试 nginx 本身

界面「运行日志」读的是工作目录里的文件，不是 Electron 日志。

1. 点「打开工作目录」，确认路径类似 `C:\Users\<你>\AppData\Roaming\nginx-desk\runtime`
2. 看 `logs/error.log`（启动失败、端口占用、配置错误的第一现场）
3. 看 `logs/nginx.pid`：有数字但界面显示已停止 → 归属检测认为 exe 路径不匹配
4. 在该目录用命令行复现（把路径换成你的 root）：

```powershell
.\nginx.exe -p ./ -c conf/nginx.conf -t
.\nginx.exe -p ./ -c conf/nginx.conf -v
```

端口冲突：Windows 上 `netstat -ano | findstr :8080` 看谁占用。本软件**不会**去结束其他进程，只会在启动超时后让你看错误日志。

## 5.7 隔离实验，避免弄脏日常数据

日常 `npm start` 和安装版共用 `%APPDATA%/nginx-desk`。若要干净环境：

- 跑 `npm run test:ui`（自动用临时 userData）
- 或设置环境变量再启动（Electron 支持 `ELECTRON_USER_DATA` 的做法因版本而异；更稳的是在实验用的 main 里 `app.setPath('userData', ...)`，参考 `scripts/ui-smoke.cjs`）

集成测试在 `os.tmpdir()` 下建 `nginx desk test *` 目录，**测完不删除**，方便打开看残留配置。磁盘紧时再手动清 `%TEMP%`。

## 5.8 加一个最小功能：示例

假设要加按钮「仅校验、不保存」。推荐路径：

1. **不要**新开 IPC。`desk.action('test')` 已经存在。
2. 在 `index.html` 概览区已有「校验配置」按钮 `data-action="test"`。
3. 若只是换文案，改 HTML 即可。

假设要加「列出 temp 目录」这种**新**能力：

1. `Manager` 增加严格约束的方法（只读自己的 `root/temp`）
2. `main.cjs` `handlers` 增加一项
3. `preload.cjs` 数组增加名字
4. HTML 加按钮，`renderer.js` 调用并 `output` 结果
5. 在 `test/manager.test.cjs` 加断言
6. 若动到窗口，补 `ui-smoke.cjs` 的一段检查

## 5.9 代码风格约定（与现有文件保持一致）

- 主进程 / Manager / 测试：CommonJS，`require` / `module.exports`
- 能纯函数就纯函数，方便单测
- 用户可见错误用中文短句；不要把内部路径随意拼进无关提示
- 文件名、版本号、URL **先正则再落地**
- 对 nginx 的写操作进 `exclusive`
- 不要为了省事把 `nodeIntegration` 打开

现有源码偏紧凑。新代码可以适当换行，但不要突然引入另一套目录结构或构建工具，除非你打算连文档和 CI 一起改。

## 5.10 开发时常见「我改了没反应」

| 现象 | 原因 | 处理 |
|------|------|------|
| 改了 `manager.cjs` 窗口行为不变 | 没重启 Electron | 关窗再 `npm start` |
| 改了 `preload.cjs` `window.desk` 仍是旧 API | preload 只在窗口创建时加载 | 必须重启 |
| 改了 CSS 没变 | 缓存或没刷新 | `Ctrl+R` 或重启 |
| `window.desk` 是 `undefined` | preload 路径错或沙箱/隔离被改坏 | 检查 `webPreferences` |
| 初始化失败 | 没有 `vendor/nginx` | `npm run prepare:nginx` |
