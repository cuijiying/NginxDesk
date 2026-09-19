# 6. 测试体系

本项目测试分成两层，都应该在改核心逻辑后本地跑一遍。它们**不替代**你亲手点一遍安装包，但能挡住大部分回归。

## 6.1 总览

| 命令 | 跑什么 | 要不要 GUI | 要不要真实 nginx | 典型耗时 |
|------|--------|------------|------------------|----------|
| `npm test` | `test/*.test.cjs` | 否 | 是（有 bundled 引擎时） | 约 1–2 分钟 |
| `npm run test:ui` | `scripts/ui-smoke.cjs` | 是，会闪真实窗口 | 会 `init()` 拷贝引擎，但不断言 HTTP 服务已启动 | 约 10–20 秒 |

`package.json`：

```json
"test": "node --test test/*.test.cjs",
"test:ui": "electron scripts/ui-smoke.cjs"
```

使用 Node 内置测试运行器，无 Jest/Mocha 依赖。

## 6.2 `npm test` 里有什么

文件：`test/manager.test.cjs`、`test/connections.test.cjs`。

### 用例 1：注入与路径约束（纯 CPU，很快）

- `siteConfig` 拒绝：端口 `0`、`65536`、`'80;'`，域名 `x;}`，路径里的 `"` `;`
- `Manager.file` 拒绝：`../secrets`、`sites/../../secrets`
- `assertVersion` 拒绝：空、两段、四段、字母后缀、路径穿越、夹换行
- `parseNginxVersion` 从 `nginx version: nginx/1.31.6` 抽出版本
- `parseWindowsVersions` / `parseOfficialVersions` 用伪造 HTML：Windows 只收 zip 链接，Unix 只收 tar.gz，忽略 `0.8.55` 和签名文件
- `sameExecutable` 拒绝空路径和别人的 nginx
- `parseNginxBuild` / pid / 日志指令解析；主机名、用户名、路径拒绝 `;|&$` 和 `..`
- Hub 不能删除托管实例；非法远程主机会被拒绝；附加本机实例 `init()` 不改写已有配置

**改校验规则时先改这一段**，否则集成测试会在真 nginx 上浪费时间。

### 用例 2：真实 nginx 集成（有 bundled 引擎时）

```js
{ skip: !hasBundled, timeout: 120000 }
```

`hasBundled` 检查 `vendor/nginx/nginx.exe`（Windows）或 `vendor/nginx/nginx`（Unix）。没有引擎时跳过，避免在未 prepare 的 CI 上误报。

在临时目录 `os.tmpdir()/nginx desk test *` 建 Manager，bundled 指向仓库 `vendor/nginx`。流程相当于一份「用户说明书」的自动化：

1. `init()` 写出默认配置
2. 把 `8080` 换成系统分配的空闲端口（避免和你本机已启动的 Desk 冲突）
3. 保存合法站点配置
4. 写入非法配置 → 必须拒绝，磁盘仍是旧内容
5. 新建非法 `sites/broken.conf` → 文件必须被删掉（回滚）
6. 主配置去掉 `pid logs/nginx.pid;` → 拒绝
7. 此时应已有备份
8. `status().running === false` → `start` → running
9. `fetch` 默认页，正文匹配 `Nginx Desk`
10. 起一个本地 HTTP 上游，保存 proxy 站点，reload 后能读到 `upstream-ok`
11. 保存 static 站点，能读到工作目录 html
12. 改 default 为 `return 200 "reload-success";`，reload 后轮询直到响应变化
13. `reopen` 后 access 日志能匹配 `GET`
14. 运行中 `installVersion(当前版本)` 必须因「请先停止」失败；非法版本号失败
15. `quit` 后 running false；再 `installVersion(当前版本)` 成功，pinned 与 `-v` 一致
16. `deleteVersion(当前版本)` 失败；非法/未下载失败；删除一份非当前缓存后 `installedEngines` 不再包含它

`finally` 里会停 nginx。**临时目录故意保留**，失败时去系统临时目录打开对应文件夹看 `logs/error.log`。

### 测试自己申请端口的方式

```js
async function port() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const p = server.address().port;
  await new Promise(r => server.close(r));
  return p;
}
```

`listen(0)` 让操作系统给空闲端口。注意这不是原子租约：关闭后再用仍有极小竞争窗口，实践中够用。

## 6.3 `npm run test:ui` 里有什么

`scripts/ui-smoke.cjs` 在加载 `main.cjs` **之前**把 `userData` 指到临时目录，这样：

- 不会启动/停止你平时用的那份 nginx
- 每次都是全新 `init()`

然后监听 `browser-window-created`，等 `did-finish-load` 后再等 2.5 秒（给 renderer 初始 `state()` + `loadFile` 时间），在页面里 `executeJavaScript` 一段 async IIFE：

| 检查 | 失败信息 |
|------|----------|
| 初始未运行，且文件列表含 `nginx.conf` | Bad initial state |
| 编辑器含 `worker_processes` | Editor did not load |
| 点「连接实例」，下拉框含 `managed` | Connections navigation / missing managed |
| 点「引擎版本」，列表出现 `nginx 1.` 或离线提示 | Engines navigation / Version list |
| 再进配置页，文件下拉框可用且含 `nginx.conf` | Config files select stayed disabled / missing |
| 再进新建站点，类型下拉框可切换 | Site kind select stayed disabled / did not change |
| 提交默认表单，编辑器出现 `proxy_pass` | Site generation failed |
| 自动跳到 config 页 | Navigation failed |
| 主题切到 violet 再切回 cyan | Theme switch failed |

通过则截图 `artifacts/desktop-smoke.png` 并打印 `UI_SMOKE_OK {...}`，`app.exit(0)`。60 秒总超时。

**它没有点击「启动服务」**，也不断言真实 HTTP。启动/代理/回滚交给 `npm test`。两边互补，不要删掉其中一层去「省时间」却失去覆盖。

冒烟失败时：终端有堆栈；若窗口一闪而过，把超时调高或看临时 userData 下是否写出了 runtime。

## 6.4 改代码时该跑哪些

| 你改了 | 至少跑 |
|--------|--------|
| `siteConfig` / 版本解析 / `file()` | `npm test` |
| `Manager` 启动停止保存切版本 / `Hub` 连接 | `npm test`（必须） |
| `preload` / `main` IPC | `npm run test:ui` + 必要时手点 |
| HTML/CSS/导航/主题/表单 | `npm run test:ui` |
| 打包配置 `package.json` `build` | `npm run dist`（见下一章） |
| `prepare-nginx.cjs` | 删掉 `vendor/nginx` 再 prepare，核对 SHA256 |

提交前完整集：

```bash
npm test
npm run test:ui
```

## 6.5 怎么加测试（建议写法）

1. **纯函数**：直接 `assert.throws` / `assert.equal`，不建 Manager。
2. **磁盘与进程**：`mkdtemp`，`try/finally` 里 `quit`。不要用开发者的正式 userData。
3. **端口**：动态分配，不要写死 8080。
4. **断言用户可见字符串**时，改文案会打碎测试，这是有意的：界面/错误是产品的一部分。
5. 不要在测试里 `download` 真实新版本（慢、依赖外网、给 nginx.org 添流量）。切版本用例复用**当前已有** bundled 版本即可。

## 6.6 已知覆盖缺口

`artifacts/verification.md` 也写了：下列需要人工或后续补测：

- 各平台安装向导 / DMG / AppImage 的完整安装卸载
- Windows 11、域策略、无 `tar.exe` 的精简系统
- macOS Gatekeeper / 未签名公证；Linux 各发行版依赖差异
- 安装包代码签名
- 大规模并发、官方 Windows nginx 的性能上限
- 备份目录膨胀后的清理策略（产品尚未自动清理）
- 关闭对话框三个按钮的 UI 自动化
- 「保持 nginx 运行并退出」后再启动软件的衔接

补测时优先自动化「关窗策略」和「安装/卸载是否保留用户数据」，这两项和数据安全相关。
