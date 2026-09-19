# 3. 系统架构

## 3.1 总览

一次用户点击的完整路径：

```
用户点击「启动服务」
        │
        ▼
renderer.js  →  window.desk.action('start')
        │
        ▼
preload.cjs  →  ipcRenderer.invoke('desk:action', 'start')
        │
        ▼
main.cjs     →  校验 event.senderFrame.url 是本机 index.html
             →  manager.action('start')
        │
        ▼
manager.cjs  →  进入独占队列
             →  nginx -t
             →  spawn nginx(.exe) -p <runtime>/ -c conf/nginx.conf
             →  轮询 logs/nginx.pid + 核对可执行路径
        │
        ▼
返回 { ok:true, data:'nginx 启动成功' }
        │
        ▼
preload 若 ok 为 false 则 throw，renderer 显示在页脚控制台
```

任何一步抛错，主进程都收成 `{ ok:false, error: 消息 }`，页面只看到中文错误，看不到堆栈（堆栈仍在主进程，调试时看终端或 DevTools 的 main 日志）。

## 3.2 进程与信任边界

```
                    ┌─ Chromium 沙箱 ─────────────────┐
                    │  index.html + renderer.js       │
                    │  只能调用 window.desk           │
                    │  CSP 禁止联网、禁止内联脚本     │
                    └──────────────┬──────────────────┘
                                   │ contextBridge
                    ┌──────────────▼──────────────────┐
                    │  preload.cjs                    │
                    │  固定方法名，无动态 invoke      │
                    └──────────────┬──────────────────┘
                                   │ ipcRenderer.invoke
 Electron 主进程 ──────────────────┼──────────────────
                                   │
                    ┌──────────────▼──────────────────┐
                    │  ipcMain.handle('desk:*')       │
                    │  1. 来源 URL 必须是 file://.../index.html
                    │  2. try/catch 统一包装         │
                    │  3. 转给 Manager / dialog/shell │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │  Manager（可单测）              │
                    │  再往下才是磁盘和 nginx 引擎    │
                    └─────────────────────────────────┘
```

设计原则：**渲染进程不可信，主进程只信白名单 IPC，Manager 再对文件名、版本号、配置内容做第二次校验。**

## 3.3 目录与路径（开发 vs 安装后）

`main.cjs` 在 `app.whenReady` 里构造 Manager：

```text
new Manager(
  userData/runtime,          // 工作目录 root
  内置 nginx 目录 bundled,   // 开发: <仓库>/vendor/nginx
                             // 安装: <安装目录>/resources/nginx
  userData/engines           // 引擎缓存
)
```

`Hub` 会再包一层：默认 `current` 就是上面这份托管 Manager；用户切换到本机已有或远程实例时，另建 `kind: 'local'|'remote'` 的 Manager，通过 `LocalIO` 或 `SshIO` 访问对方的磁盘和进程。连接列表保存在 `userData/connections.json`。

`userData` 由 Electron 根据 `package.json` 的 `"name": "nginx-desk"` 决定：

| 系统 | 默认 userData |
|------|----------------|
| Windows | `%APPDATA%/nginx-desk` |
| macOS | `~/Library/Application Support/nginx-desk` |
| Linux | `~/.config/nginx-desk` |

| 路径 | 开发环境 | 安装后 |
|------|----------|--------|
| 应用代码 | 仓库 `src/` | `resources/app.asar` 内（macOS 在应用包 `Contents/Resources`） |
| 内置 nginx | `vendor/nginx` | `resources/nginx`（`extraResources`） |
| 用户工作目录 | `<userData>/runtime` | 同左（升级/卸载默认保留） |
| 引擎缓存 | `<userData>/engines` | 同左 |
| UI 冒烟测试 | `os.tmpdir()/nginx-desk-ui-<时间戳>` | 不使用正式 userData |

工作目录初始化后的结构：

```
runtime/
├── nginx.exe / nginx  当前启用的引擎（从 bundled 或 pinned 引擎拷来）
├── conf/
│   ├── nginx.conf
│   ├── mime.types     等辅助文件，仅在不存在时从 bundled 拷贝
│   └── sites/
│       └── default.conf
├── logs/
│   ├── nginx.pid
│   ├── error.log
│   └── access.log
├── html/index.html
├── backups/           保存配置前的快照
└── temp/
```

**升级软件不会覆盖已有 `nginx.conf` 和站点文件。** 只会补齐缺失目录，以及在辅助文件不存在时拷贝 `mime.types` 等。用户钉住的引擎版本写在 `engines/active`，升级后仍优先用钉住的引擎文件。

## 3.4 启动生命周期

```
npm start / 用户双击快捷方式
        │
        ▼
requestSingleInstanceLock?
   否 → app.quit()
   是 → whenReady
        │
        ▼
Manager.init()
  · 建 runtime、engines
  · 探测 bundled 版本，拷进 engines/<ver>/
  · 若有 active 且文件在，用 pinned；否则用 bundled
  · 拷到 runtime/nginx.exe 或 runtime/nginx（文件被占用则忽略，只要已存在）
  · 建 conf/logs/html/...
  · 若没有 nginx.conf：写入默认主配置、default.conf、欢迎页
        │
        ▼
注册 ipcMain.handle
创建 BrowserWindow（深色背景、隐藏菜单、preload、沙箱）
loadFile(index.html)
        │
        ▼
renderer 立即 desk.state() + 载入第一个配置文件
每 5 秒轮询一次状态（日志页且勾选自动刷新时顺带拉日志）
```

`init()` 失败（常见原因：没跑 `prepare:nginx`）会弹「初始化失败」然后退出。

## 3.5 退出生命周期

窗口 `close` 被拦住：

1. 查 `manager.status()`
2. 若未运行：直接关
3. 若在运行：三按钮对话框
   - 取消：什么都不做
   - 停止 nginx 并退出：`action('quit')` 再关
   - 保持运行并退出：不杀 nginx，只关窗口
4. `window-all-closed` → `app.quit()`（各平台都没有托盘常驻，关窗即退出应用）

nginx 若以 `detached` 方式启动，保持运行是安全的：主进程结束不会 SIGKILL 子进程。

## 3.6 独占队列（为什么必须有）

Manager 里：

```js
exclusive(fn) {
  const p = this.queue.then(fn);
  this.queue = p.catch(() => {});
  return p;
}
```

`action` / `save` / `installVersion` / `deleteVersion` 都走这条队列。效果是：

- 保存和重载不会交错，避免一半新配置一半旧配置被 `-t`
- 切版本时不会同时 start
- 上一次失败不会堵死队列（`catch` 后继续）

读文件、列备份、拉版本列表**不进队列**，可以并行。

## 3.7 进程归属检测

`status()` 算法：

1. 读 `logs/nginx.pid`，解析成正整数；读不到 → `{running:false}`
2. 按平台核对可执行路径：Windows 用 PowerShell CIM；Linux 读 `/proc/<pid>/exe`；macOS 用 `lsof`，失败再退回 `ps`
3. 和 `runtime/nginx.exe` 或 `runtime/nginx` 比较（Windows 忽略大小写；Unix 还接受 `nginx: master process <path> ...`）
4. 只有确认是本实例才 `{running:true, pid}`

因此：

- 未在「连接实例」中添加的 nginx，即使 PID 文件碰巧留下数字，也不会被「停止」
- 用户明确连接的已有实例，归属检测改为核对**该连接填写的可执行文件**
- 切托管实例的版本必须先停，因为要替换正在运行的引擎文件（Windows 上会 EBUSY；Unix 上覆盖后旧进程仍占着已删除 inode）

## 3.8 配置保存与回滚

`save(name, content)`：

1. 文件名必须是 `nginx.conf` 或 `sites/<安全名>.conf`
2. 内容 ≤ 1 MB
3. 若是主配置：去掉注释后，必须恰好有一条 `pid logs/nginx.pid;`
4. 若旧文件存在：先拷到 `backups/<时间戳>-<名字>.bak`（站点路径里的 `/` 变成 `__`）
5. 写入新内容，立刻 `nginx -t`
6. 失败：新文件删除或写回旧内容，抛「保存未生效，已回滚」
7. 成功：**并不自动 reload**。运行中的 nginx 仍用旧配置，直到用户点「重载配置」

备份恢复不是一键覆盖：用户把备份载入编辑器（编辑器变脏），再走一次「校验并保存」。这样恢复路径和普通编辑同一套校验。

## 3.9 站点生成

`siteConfig({port, host, kind, target})` 是纯函数，主进程和测试都直接调用。

- `proxy`：校验 `http:` / `https:` URL，禁止用户名密码和空白，生成 `proxy_pass` + 常见转发头
- `static`：把 Windows 反斜杠换成 `/`，生成 `root` + `try_files`
- 监听写成 `listen ${port}`（**所有网卡**），和默认站点 `127.0.0.1:8080` 不同。界面上有防火墙提示

渲染进程只负责文件名是否已存在；真正的注入防护在 `siteConfig` 和 `file()`。

## 3.10 引擎版本

```
versions()
  已安装 = engines/ 下形如 1.31.6 且含当前平台引擎文件的目录
  当前   = nginx -v，失败再 probe 磁盘
  可用   = 抓 download.html（10 分钟缓存，刷新按钮强制更新），按 h4 分成 mainline/stable/legacy
           Windows 解析 nginx/Windows-x.y.z；Unix 解析 nginx-x.y.z.tar.gz
           网络失败则退回本地已安装列表

installVersion(ver)
  必须未运行
  版本号 /^\d+\.\d+\.\d+$/
  本地没有则：必须出现在官方列表 → 下载 zip 或 tar.gz → 大小与文件头检查
             → tar 解压 → Windows 只拷 nginx.exe；Unix 编译后拷 objs/nginx（防路径滑出目录）
  拷到 runtime 引擎文件，写 engines/active
  再 -v 核对版本字符串一致

deleteVersion(ver)
  必须已下载
  不能等于当前 -v 或 engines/active
  删除 engines/<ver>/ 目录
```

zip 本身不长期保留；解压目录用完即删。bundled 版本会在 `init()` 时复制进 engines，所以「官方列表失败」时至少还能看到本地副本。

## 3.11 IPC 一览

通道名一律 `desk:<方法>`。preload 与主进程 handlers 必须同步增减。

| 方法 | 参数 | 作用 |
|------|------|------|
| `state` | 无 | 运行状态 + 文件列表 + root + `nginx -v` + 当前连接 |
| `read` | 文件名 | 读配置文本 |
| `save` | `{name,content}` | 备份、写入、`-t`、回滚 |
| `action` | `start\|quit\|reload\|test\|reopen` | 控制当前连接的实例 |
| `logs` | `error\|access` | 文件末尾最多 64 KB |
| `backups` | 无 | 备份文件名列表（新→旧） |
| `backup` | 备份文件名 | 解析出原路径和内容 |
| `versions` | 无 | 当前 / 已装 / 官方列表 |
| `installVersion` | 版本号 | 下载或启用（仅托管实例） |
| `deleteVersion` | 版本号 | 删除本地引擎缓存（仅托管实例） |
| `generate` | 站点表单对象 | `siteConfig` |
| `connections` | 无 | 连接列表（不含密钥） |
| `discover` | 无 | 探测本机常见 nginx 安装 |
| `probe` | 连接草稿 | 测试本机或 SSH，并用 `-V` 补全路径 |
| `saveConnection` | 连接草稿 | 校验、探测、持久化 |
| `deleteConnection` | id | 删除连接（不能删托管实例） |
| `useConnection` | id | 切换当前实例 |
| `unlockConnection` | `{id,password}` | 为未持久化密码的远程连接解锁 |
| `directory` | 无 | 系统选文件夹对话框 |
| `pickFile` | `exe\|key` | 选 nginx 可执行文件或 SSH 私钥 |
| `folder` | 无 | `shell.openPath` 当前本地工作目录 |
| `confirm` | `{message,detail}` | 系统确认框，避免页面 `window.confirm` 卡住原生下拉框 |

主进程**没有**通用「执行任意命令」或「读任意路径」的 IPC。这是安全边界，扩展功能时不要打破它。

## 3.12 界面状态机（渲染进程）

渲染进程自己维护：

| 变量 | 含义 |
|------|------|
| `activePage` | 当前页面 id |
| `currentFile` | 编辑器打开的配置名 |
| `dirty` | 编辑器是否未保存 |
| `busy` | 是否有任务进行中（按钮禁用；表单控件用 CSS 挡住点击，避免给隐藏的 select/input 设置 disabled） |
| `polling` | 5 秒轮询是否在飞，防止重叠 |

`task(fn)` 保证同一时间只有一个用户操作，忙时再次点击会在页脚提示「请等待当前操作完成后再试」。轮询在 `busy` 时跳过，避免和保存打架。确认框走主进程 `desk.confirm`，不用页面里的 `window.confirm`，以免切页后原生 `<select>` 无法弹出。切页动画只做透明度，避免祖先 `transform` 把下拉列表“点了没反应”。

主题存在 `localStorage['nd-theme']`，通过 `<html data-theme="...">` 切换 CSS 变量。
