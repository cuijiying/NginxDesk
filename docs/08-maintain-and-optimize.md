# 8. 维护与优化

本章给「已经能跑、要长期改」的人：升级引擎、加功能、性能、安全、产品边界。改之前先读 [系统架构](03-architecture.md) 的信任边界，避免为了方便把 Node 暴露给页面。

## 8.1 升级捆绑的 nginx

目标：新安装包默认带更新的官方构建。

1. 在 https://nginx.org/en/download.html 确认版本号
2. 下载 Windows zip **以及** Unix tar.gz，分别计算 SHA256
3. 修改 `scripts/prepare-nginx.cjs` 的 `version` 与 `checksums`
4. 删除本地 `vendor/nginx`（以及旧压缩包），在各目标操作系统上执行 `npm run prepare:nginx`
5. `npm test`（集成测试会用新的 bundled 启动）
6. 更新 README / 文档里写死的版本号字样
7. 在各目标操作系统上 `npm run dist`，在干净机器装一次

用户已在「引擎版本」里钉住的 `engines/active` **不会**被这次升级覆盖。这是有意的。若你希望「安装包强制全员升到 bundled」，需要改 `init()` 策略，并想清楚正在运行的实例、自定义补丁、回退路径。

## 8.2 加一个界面页面

最小步骤：

1. `index.html`：`<nav>` 加按钮 `data-page="xxx"`；加 `<section id="xxx" class="page">`
2. `renderer.js`：`titles.xxx = '中文标题'`
3. 若进入页面要拉数据：在 `show()` 里 `if (page==='xxx') await ...`
4. `test:ui` 增加导航断言，防止以后改 HTML 把 id 改丢

不要引入路由库，除非页面状态已经复杂到无法用 `display` 切换。

## 8.3 加一条 IPC（检查表）

- [ ] Manager（或 main 里仅限 dialog）实现，**参数全部校验**
- [ ] 不提供「任意路径」「任意 argv」
- [ ] `main.cjs` `handlers` 登记
- [ ] `preload.cjs` 名字数组登记（与 handlers 相同）
- [ ] renderer 只通过 `window.desk.新方法`
- [ ] 来源 URL 校验仍然套在统一循环上，不要单独 `ipcMain.handle` 绕过
- [ ] 测试：纯校验 + 如有磁盘副作用则集成测试
- [ ] 文档：更新 [架构 IPC 表](03-architecture.md) 和本章

## 8.4 加一种站点模板

现在只有 `proxy` / `static`。若加 `redirect` 或 `php`：

1. 扩展 `siteConfig` 的 `kind` 分支，**同样禁止换行和 nginx 特殊字符**
2. 单测覆盖拒绝用例
3. HTML `<select name="kind">` 加选项
4. 生成结果仍只进编辑器，保存路径不变
5. 集成测试：动态端口 + `fetch` 断言

TLS、upstream 块、缓存这类复杂配置，当前产品选择是「让用户在编辑器里写完整 nginx 语法」，而不是把所有指令做成表单。表单适合**高确定性、易注入**的子集。

## 8.5 主题与视觉

- 颜色只放 CSS 变量，组件不要写死 `#2ee9ff`
- 新主题三处：`style.css` 块、`index.html` 的 `.theme-dot`、`renderer.js` 的 `themes` 数组
- 尊重 `prefers-reduced-motion`
- 装饰层必须 `pointer-events: none`

性能上，当前 CSS 阴影和网格对 1280×860 窗口足够。若以后做超多备份行，给 `#version-list` / `#backup-list` 做虚拟列表才有意义；现在 `max-height + overflow` 即可。

## 8.6 性能与资源

| 点 | 现状 | 优化时注意 |
|----|------|------------|
| 5 秒轮询 `state()` | 每次 `-v` + 读 PID + 平台进程查询 | 勿改成 100ms；可考虑运行中降低 `-v` 频率 |
| 日志 64 KB 尾部 | 避免把巨大 access.log 读进渲染进程 | 不要改成全文件 |
| `command` timeout 15s | 卡住的 nginx 不会永久挂死 UI（busy 锁仍在） | 与 `test:ui` 超时一起考虑 |
| 下载引擎 40 MB 上限 | 防异常响应撑爆内存 | `arrayBuffer` 仍是一次性进内存，极大文件不要盲目放宽 |
| 独占队列 | 正确性优先 | 不要把只读 `logs` 放进队列造成界面卡顿 |
| spawn detached | nginx 独立于 Electron | 不要改回 `execFile` 长驻等待 |

Windows 上 PowerShell 查进程较稳，但每次 status 都 spawn `powershell.exe`。Linux 读 `/proc/<pid>/exe` 更轻；macOS 走 `lsof`/`ps`。若轮询成为 CPU 热点，可评估：

- 缓存「上次 pid + 路径」在短时间内复用
- 改用更轻的 API（需充分测试权限和 32/64 路径）

优化必须仍保证**绝不操作未连接的 nginx**。用户明确添加的附加实例除外。

## 8.7 备份膨胀

每次成功保存前，只要旧文件存在就新增一个 `.bak`。长期编辑会堆积。

当前策略：不自动删除（配置可能含密钥、upstream 地址，误删不可逆）。维护方向可以是：

- 应用内「清理 30 天前备份」按钮（要二次确认）
- 按文件最多保留 N 份
- 不要在 `init()` 里偷偷删

备份与日志都在用户目录，文档和界面应继续提醒用系统权限保护 nginx-desk 用户数据目录。

## 8.8 安全维护清单

已有措施（改动时不要回退）：

- contextIsolation + 无 nodeIntegration + sandbox
- CSP：页面不能 `connect-src` 外网（版本列表由**主进程** `fetch`）
- IPC 来源绑定 `index.html` 的 `file:` URL
- 配置文件名白名单
- 主配置 PID 路径锁定（托管实例）
- 版本号正则；zip/gzip 文件头与解压路径约束
- 官方列表白名单后才下载
- 进程归属按完整 ExecutablePath 比较
- 远程 SSH 只调用指定 nginx 二进制的固定参数；主机/用户/路径拒绝 shell 元字符
- SSH 密码优先 `safeStorage` 加密；无法加密时只放内存，不写明文

明确不做或未做：

- 渲染进程无 XSS 消毒库（当前无 innerHTML 拼接用户配置到 DOM；日志用 `textContent`）。以后若 `innerHTML` 渲染配置，等于把恶意配置变成 XSS，**禁止**
- 未做安装包签名
- 未做下载包的 SHA256（应用内切换版本只检查大小和文件头；`prepare:nginx` 才会核 SHA256）。强化方向：对照官方 `.asc` 或公布哈希列表
- 站点 `listen port` 对所有接口开放，用户自己负责防火墙

## 8.9 产品边界（避免错误的「优化」）

下面这些看起来像功能，但会改变产品定位，需要单独设计：

| 想法 | 为什么不能当小补丁做 |
|------|----------------------|
| 开机自启 + 系统服务 | 权限模型、失败恢复、与「当前用户桌面应用」冲突 |
| 管理机器上已有的 nginx | 必须走「连接实例」显式添加；归属检测仍核对指定 exe。不要在未连接时改 PID 校验去扫全机 |
| 多实例同时运行控制 | UI 一次只操作一个当前连接；切换不会自动停另一边 |
| Let’s Encrypt 自动证书 | 要长期后台任务、端口 80、账户安全 |
| 交叉编译三平台安装包 | 引擎二进制必须在目标 OS 上准备；签名/公证也绑在各平台工具链 |

若做，应开新的架构讨论，而不是在 `action('start')` 里加几个 if。

## 8.10 依赖升级

Electron 和 electron-builder 钉在 `package.json`。升级时：

1. 读 Electron breaking changes（沙箱、`session`、`file:` URL 格式可能影响来源校验）
2. 本地 `npm test` + `test:ui` + `dist` + 安装试跑
3. 确认 `pathToFileURL(page).href` 仍与 `event.senderFrame.url` 一致（这是历史回归高发点）
4. 更新 `artifacts/verification.md` 里的环境版本记录

不要无锁定地使用 `"electron": "latest"`。

## 8.11 文档怎么跟着改

- 用户能感知的行为 → 根目录 `README.md`
- 开发者架构、IPC、目录 → `docs/03-architecture.md` 与本章
- 构建脚本、哈希 → `docs/07-build-and-release.md`
- 你验证过的一次发布 → `artifacts/verification.md`（事实记录，不是教程）

文档入口：[docs/README.md](README.md)。
