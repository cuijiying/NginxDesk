# 4. 源码导读

按「启动时加载顺序」读，比按文件名排序更容易建立心智模型。

## 4.1 入口：`package.json`

```json
"main": "src/main.cjs"
```

Electron 启动后立刻执行 `src/main.cjs`。`scripts` 和 `build` 字段见 [构建与发布](07-build-and-release.md)。

依赖只有开发依赖：`electron`、`electron-builder`。运行时不需要再 `npm install` 业务库。

## 4.2 `src/main.cjs` — 桌面壳

文件很短，职责却完整。建议从上到下记这几块：

### 单实例

```js
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win.restore(); win.focus(); });
  // ...
}
```

第二个进程拿到锁失败会立刻退出；第一个进程收到 `second-instance` 后把窗口拉到前台。

### 构造 Manager

```js
const userData = app.getPath('userData');
manager = new Manager(
  path.join(userData, 'runtime'),
  app.isPackaged
    ? path.join(process.resourcesPath, 'nginx')
    : path.join(__dirname, '../vendor/nginx'),
  path.join(userData, 'engines')
);
await manager.init();
```

`app.isPackaged` 是「我是安装包还是 `electron .`」的分界。开发时 nginx 必须已由 `prepare:nginx` 放到 `vendor/nginx`。

### IPC 注册

`handlers` 是一张纯对象表。循环里统一：

1. 通道名 `desk:` + key
2. 检查 `event.senderFrame.url === pathToFileURL(page).href`
3. 成功 `{ok:true, data}`，失败 `{ok:false, error:e.message}`

`directory` 和 `folder` 不经过 Manager：一个弹选目录框，一个用系统资源管理器打开工作目录。

### 窗口安全

```js
webPreferences: {
  preload: path.join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
}
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
win.webContents.on('will-navigate', e => e.preventDefault());
```

菜单栏 `autoHideMenuBar: true`，默认看不到 Electron 的 File/Edit。开发时可用快捷键打开 DevTools（见 [开发与调试](05-develop-and-debug.md)）。

### 关闭确认

`closing` 标志位防止「已经决定退出」后再次弹窗死循环：第一次 `close` 被 `preventDefault`，异步问完再设 `closing=true` 并再次 `win.close()`。

初始化 `catch` 会提示「开发环境请先运行 npm run prepare:nginx」。

## 4.3 `src/preload.cjs` — 唯一桥梁

```js
for (const name of [
  'state','read','save','action','logs','backups','backup',
  'versions','installVersion','deleteVersion','generate','directory','folder'
]) {
  api[name] = async arg => {
    const r = await ipcRenderer.invoke('desk:' + name, arg);
    if (!r.ok) throw Error(r.error);
    return r.data;
  };
}
contextBridge.exposeInMainWorld('desk', api);
```

页面里写成 `await window.desk.save({name, content})`，失败就是普通 `Error`，和本地函数一样用 `try/catch`。

**加新能力的三步（缺一不可）：**

1. `manager` 或 `main` 实现逻辑
2. `handlers` 增加一项
3. preload 数组增加同名字符串
4. （可选）`renderer.js` 调用

不要在 preload 里写 `ipcRenderer.invoke(任意字符串)`，否则页面一旦 XSS 就能打任意通道。

## 4.4 `src/manager.cjs` — 领域核心

这是本仓库最重要的文件。导出：

```js
module.exports = {
  Manager, siteConfig, assertVersion, parseNginxVersion, parseWindowsVersions
};
```

后四个是纯函数，测试可以直接喂字符串，不必起 nginx。

### 纯函数

| 函数 | 输入 | 输出 / 抛错 |
|------|------|-------------|
| `assertVersion` | 字符串 | 必须 `x.y.z` 数字三段 |
| `parseNginxVersion` | `nginx -v` 文本 | `1.31.6` 或空串 |
| `parseWindowsVersions` | download.html | `{version, channel}[]`，按 h4 分区 |
| `siteConfig` | 表单字段 | 一段 `server { ... }` |

`parseWindowsVersions` 用 `<h4>Mainline/Stable/Legacy` 切块，再抓 `nginx/Windows-x.y.z`。抓不到分区时退化为整页扫描，channel 记为 `release`。主版本号 `< 1` 的旧包直接丢掉。

### `Manager` 构造

```js
constructor(root, bundled, enginesRoot)
```

- `root`：用户工作目录
- `bundled`：只读的官方发行目录（含 `nginx.exe` 和 `conf/mime.types` 等）
- `enginesRoot`：可写缓存；缺省为 `root/engines`（测试里常省略第三参）

`this.exe` 永远是 `root/nginx.exe`，所有 `command()` 都打这一份。

### `init()`

顺序固定，改动时注意「不覆盖用户配置」：

1. `mkdir` root、engines
2. 探测 bundled 版本，`copyFile(..., COPYFILE_EXCL)` 进 engines（已存在则忽略）
3. 有 `engines/active` 且对应 exe 在 → 用它；否则用 bundled
4. 拷到 `root/nginx.exe`；若 EBUSY/EPERM（正在运行）则只要文件还在就放过
5. 建 `conf`、`conf/sites`、`logs`、`backups`、`html`、`temp`
6. 辅助 conf 文件不存在才从 bundled 拷
7. 没有 `nginx.conf` 才写默认三件套

默认主配置要点：`pid logs/nginx.pid;`、`include sites/*.conf;`、`error_log` / `access_log` 固定相对路径。日志页写死读这两个文件名。

### `file(name)` / `files()` / `read()`

路径白名单：

- `nginx.conf`
- `sites/` + `[a-zA-Z0-9_-]+` + `.conf`

`../`、绝对路径、奇怪扩展名一律抛「无效配置文件名」。这是防路径穿越的第一道闸。

### `command(args)`

```text
nginx.exe -p <root正斜杠>/ -c conf/nginx.conf <额外参数>
cwd = root
timeout 15s
把 stdout+stderr 拼成一个字符串
失败时优先抛 stderr（nginx -t 的报错在 stderr）
```

`-p` 末尾必须有 `/`，Windows 混用反斜杠时 nginx 有时会解析错 prefix。

### `action(name)`

| name | 行为 |
|------|------|
| `test` | 只 `-t`，不要求正在运行 |
| `start` | 已运行则直接返回；否则 `-t`，`spawn` + `detached`，最多约 3 秒轮询 status |
| `quit` | `-s quit`，轮询直到不 running，或提示「正在等待连接结束」 |
| `reload` | 先 `-t` 再 `-s reload` |
| `reopen` | `-s reopen`，让 nginx 重新打开日志文件 |

未知 name 抛错。除 `test`/`start` 外，未运行会拒绝。

### `save` / `backups` / `backup`

备份文件名正则：

```text
<毫秒时间戳>-(nginx.conf|sites__<安全名>.conf).bak
```

`backup()` 再把 `__` 还原成 `/`，得到编辑器该打开的逻辑文件名。载入备份**不会**立刻写盘。

### `logs(type)`

打开 `logs/error.log` 或 `access.log`，从 `max(0, size-65536)` 读到末尾。文件不存在返回「暂无日志」。注意用 `fs.open` + `finally close`，避免句柄泄漏。

### 版本相关方法

| 方法 | 说明 |
|------|------|
| `probeVersion(exe)` | 对任意 exe 跑 `-v`，失败当空 |
| `pinnedVersion()` | 读 `engines/active` 并确认 exe 存在 |
| `installedEngines()` | 扫版本号目录 |
| `fetchOfficialVersions()` | HTTPS GET，20s 超时，UA=`NginxDesk` |
| `downloadEngine` | 40 MB 上限、zip 魔数 `PK`、`tar -xf`、路径必须在临时目录内 |
| `installVersion` | 独占、必须停止、官方白名单、拷 exe、写 active、核对 `-v` |
| `deleteVersion` | 独占、必须已下载、禁止删除当前/钉住版本、删除 `engines/<ver>` |

## 4.5 `src/index.html` — 结构即功能

没有前端框架。约定：

- `<section class="page" id="...">` 对应导航 `data-page`
- 服务按钮 `data-action="start|quit|reload|test|reopen"`
- 需要主进程的控件带稳定 `id`（`editor`、`files`、`output`…）
- CSP 在 `<meta>`：`script-src 'self'`，所以**不能**写内联 `onclick=`

改 UI 文案或加一块面板，先改 HTML，再在 `renderer.js` 绑事件。

## 4.6 `src/renderer.js` — 界面逻辑

建议按块阅读：

1. **主题**：`applyTheme` ↔ `localStorage` ↔ `.theme-dot`
2. **`output` / `task`**：页脚控制台 + 全局忙锁
3. **`state`**：把 Manager 状态填进概览卡片和文件下拉框
4. **`show(page)`**：切 `.active`，logs/backups/engines 进入时刷新
5. **事件委托**：导航、`data-action`、保存、站点表单、备份载入
6. **启动**：`task` 里 `state()` + `loadFile(第一个文件)`
7. **定时器**：5 秒刷新状态；日志页且勾选才拉日志

脏检查出现在：切换文件、切到生成站点、载入备份、`beforeunload`。重载按钮在 `dirty` 时直接抛错，防止把磁盘上的旧文件 reload 上去却以为编辑器里的新内容已生效。

Tab 键在 textarea 里插入四个空格，避免焦点跑掉。

站点表单：`FormData` → `desk.generate` → 把结果放进编辑器并跳到 config。磁盘上此时**还没有**新文件，必须再点「校验并保存」。

## 4.7 `src/style.css` — 视觉约定

- `:root` / `[data-theme=...]` 定义一套 CSS 变量（`--bg`、`--accent`…）
- 布局：左侧 `aside` 固定 236px，`main` `margin-left: 236px`
- `.page { display:none }` / `.page.active { display:block }`
- 装饰层 `.fx-*` `pointer-events:none`，不影响点击
- `prefers-reduced-motion: reduce` 时关掉动画

加主题：在 CSS 加一套 `[data-theme="xxx"]`，在 HTML 加一个 `.theme-dot`，在 `renderer.js` 的 `themes` 数组加名字。三处要齐。

## 4.8 脚本与测试（不属于安装包 UI）

| 文件 | 谁调用 | 做什么 |
|------|--------|--------|
| `scripts/prepare-nginx.ps1` | `npm run prepare:nginx` / `dist` | 下载并校验官方 zip 到 `vendor/nginx` |
| `scripts/ui-smoke.cjs` | `npm run test:ui` | 改 `userData` 后 `require('../src/main.cjs')`，窗口加载完注入断言 |
| `test/manager.test.cjs` | `npm test` | 输入约束 + 真实 nginx 集成（非 Windows 跳过集成段） |
| `artifacts/verification.md` | 人工记录 | 某次环境的测试/打包结果，不是自动生成 |

UI 冒烟**复用真实 main**，所以能测到 preload、IPC 来源校验、`init()` 默认配置。它把 `userData` 指到临时目录，不会污染你的日常 `%APPDATA%`。

## 4.9 改动时的依赖方向

```
index.html ──► renderer.js ──► window.desk
                                  │
style.css  ──► index.html         │
                                  ▼
                              preload.cjs
                                  │
                                  ▼
                               main.cjs ──► dialog / shell
                                  │
                                  ▼
                              manager.cjs ──► nginx.exe / 磁盘 / nginx.org
                                  ▲
                                  │
                         test/manager.test.cjs
```

依赖应当单向。**不要**让 `manager.cjs` `require('electron')`，否则测试和未来的 CLI 复用都会变难。
