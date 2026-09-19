# 9. 故障排查

按「你看见的现象」找小节。查之前先分清三份日志：

| 来源 | 在哪 | 什么问题 |
|------|------|----------|
| Electron 终端 | 运行 `npm start` 的终端 | 主进程抛错、IPC、init 失败 |
| 页脚 CONSOLE OUTPUT | 窗口底部 | 已经传到渲染进程的 `e.message` |
| nginx `error.log` | 工作目录 `logs/error.log` | 端口、配置语法、权限、证书 |

界面「打开工作目录」指向的就是 Manager.root。

## 9.1 初始化失败，窗口一闪或直接退出

提示通常含「开发环境请先运行 npm run prepare:nginx」。

检查：

```bash
# Windows
Test-Path vendor\nginx\nginx.exe

# macOS / Linux
test -x vendor/nginx/nginx && echo ok

npm run prepare:nginx
```

仍失败：看脚本是哈希不匹配、网络下载失败，还是 Unix 编译缺少工具链。公司代理需能为 `nginx.org` 走 HTTPS。

安装包用户若看到类似错误：资源目录里的 nginx 缺失或被杀毒隔离。到安装目录确认 `resources/nginx/nginx.exe` 或 `resources/nginx/nginx` 在。

## 9.2 `npm start` 能开窗，但启动服务失败

页脚提示看错误日志、可能端口冲突。

1. 打开工作目录，读 `logs/error.log` 末尾
2. 典型句：`bind() to 0.0.0.0:8080 failed` 或 `10013`/`10048` → 端口被占

```bash
# Windows
netstat -ano | findstr :8080

# macOS / Linux
lsof -iTCP:8080 -sTCP:LISTEN
```

最后一列是 PID，任务管理器里看是不是别的 nginx、开发服务器、IIS。**不要**让 Desk 去杀它；换站点端口或停掉占用方。

3. 配置语法错误：用界面「校验配置」，或在工作目录：

```bash
# Windows
.\nginx.exe -p ./ -c conf/nginx.conf -t

# macOS / Linux
./nginx -p ./ -c conf/nginx.conf -t
```

4. 主配置被改掉 `pid` 路径：保存阶段就应拦住。若有人手工改磁盘文件，status 会错乱。用备份页恢复，或停进程后把 `pid logs/nginx.pid;` 写回去。

## 9.3 界面显示「已停止」，但浏览器还能打开站点

常见原因：nginx 仍在跑，但归属检测失败。

- PID 文件里的进程，其可执行路径不是 `runtime` 里的引擎（例如用户从 `resources/nginx` 手动启动了一份）
- 软件升级替换 exe 失败（EBUSY）后，磁盘上的 exe 与正在跑的不是同一路径

处理：在工作目录看 `logs/nginx.pid`，任务管理器对照 PID。停掉那份 nginx 后，只用 Desk 的「启动服务」。不要混用两套 prefix。

## 9.4 保存提示回滚

含义：新内容已尝试写入，但 `nginx -t` 失败，磁盘已恢复旧文件（新文件若原本不存在则删除）。

把页脚里 nginx 的语法错误对照编辑器。注意：

- 相对路径相对 **工作目录**，不是 conf 文件所在目录
- `include sites/*.conf` 下任何一个坏文件都会让整次 `-t` 失败
- 主配置必须保留唯一 `pid logs/nginx.pid;`

## 9.5 重载后页面还是旧内容

- 编辑器显示「有未保存的修改」时点重载会被拒绝——先保存
- 保存成功只保证磁盘和 `-t`，**必须再点重载**
- 浏览器缓存：用无痕或强制刷新
- Unix nginx 的 worker 对极快的 reload 通常更及时；Windows nginx 有时要数秒。集成测试会轮询。可看 `error.log` 是否有 reload 报错

## 9.6 引擎列表空白或「无法获取官方列表」

主进程访问 `https://nginx.org/en/download.html` 失败（防火墙、TLS 拦截、超时）。

仍可启用**已经下载过**的版本。离线环境：不要指望在线安装新版本；把 bundled 或先前缓存用起来。

若官方页面改版导致解析失败：`parseOfficialVersions` 会抛「未能解析」。用测试里的 HTML 夹具对照真实页面结构，更新解析再发版。

## 9.7 安装 / 切换版本失败

| 提示 | 含义 |
|------|------|
| 请先停止 nginx | 运行中无法覆盖 runtime 里的引擎文件 |
| 无效的 nginx 版本号 | 不是 `x.y.z` |
| 不在官方发行列表 | 防任意 URL 下载 |
| 安装包过大 / 不是有效 zip 或 tar.gz | 下载内容不像官方发行包 |
| 安装包结构异常 | 解压后没有 `nginx-<ver>/` 或路径试图逃出临时目录 |
| 编译 nginx 失败 | macOS/Linux 缺少 C 编译器、make 或依赖库 |
| 版本切换异常，当前为… | 拷贝后 `-v` 对不上，暂停使用并检查 engines 目录 |

Windows 上 `tar.exe` 不存在时解压会失败。Win10 早期或精简版需确认 `where tar`。

## 9.8 UI 冒烟失败 / 超时

- 本机太慢：`did-finish-load` 后只等 2.5s，可适当加大 `ui-smoke.cjs` 里的等待（并考虑机器性能）
- `vendor/nginx` 缺失：init 失败，窗口可能直接 quit
- 改了导航 id、编辑器默认内容、默认站点表单（不再生成 `proxy_pass`）会打碎断言——同步改测试
- 60s 总超时：官方列表极慢时，「引擎」页可能一直转。测试接受「无法获取官方列表」文案，若连错误提示都没渲染，才失败

## 9.9 `npm test` 集成段失败

1. 看终端断言哪一行（HTTP 正文？reload 字符串？quit？）
2. 到系统临时目录里 `nginx desk test *` 最新目录打开 `logs/error.log`
3. 确认没有杀毒锁定引擎文件
4. 确认没有手动在同一临时目录留着正在运行的 nginx（`finally` 会尝试 quit）
5. 没有 `vendor/nginx` 当前平台引擎时集成段会 skip，只跑纯函数——不要以为「测试全绿」等于 nginx 行为已被验证

## 9.10 打包问题

- `dist` 被占用：关掉正在跑的安装包、杀毒实时扫描、已打开的 exe
- 磁盘空间不足：Electron 缓存 + 输出各一份
- `files` 误删 `src/**/*`：装好后白屏。用 asar 查看工具或安装目录确认
- extraResources 路径 `from: vendor/nginx` 必须是「目录内直接是当前平台引擎」。prepare 失败时可能变成 `vendor/nginx/nginx-1.31.6/...`，运行时 `bundled` 就找不到文件

## 9.11 关闭窗口卡死或退不出

`close` 处理是异步的。若 `status()` 里进程查询挂起（Windows 上 CIM 超时 10s），对话框会晚出现。连续点关闭可能排队。等提示出现；必要时结束 **Nginx Desk** 进程（不是随便结束所有 nginx——你可能选过「保持运行」）。

若选了停止但连接一直不结束：`quit` 会等 worker。页脚可能已显示「正在等待连接结束」。过久则看是否有长连接/上传未完成。

## 9.12 中文路径与空格

集成测试目录名带空格（`nginx desk test`），这是有意覆盖。若你把仓库放在含特殊 Unicode 的路径，优先怀疑 `execFile` 与 nginx `-p`。保持 `-p` 使用正斜杠、末尾 `/`。

用户工作目录在 AppData，一般是 ASCII。自定义安装路径若含中文，抽时间做一次「启动 + -t」验证。

## 9.13 连接本机或远程已有 nginx 失败

1. 先点「测试连接」，不要直接保存。页脚会给出 `nginx -V`、配置路径或 SSH 错误。
2. 本机：确认填写的是**对方**的 `nginx.exe` / `nginx` 和工作目录，而不是 Desk 自己的 `runtime`（探测列表会跳过托管引擎）。「探测本机 nginx」会查找正在运行的进程、PATH 和常见安装目录；像 `D:\java\nginx-1.28.3` 这类自定义路径如果不在 PATH 且进程未启动，需要手动浏览。
3. 远程：当前按 Linux/macOS SSH 设计。认证失败时检查用户名、密码/私钥权限（私钥文件不可被其它用户读取）。`sudo -n` 失败表示远程未配置免密 sudo，可关掉该选项或改用有权限的用户。
4. 主机名不能含空格或 `;|&$`。IPv6 直接填地址即可。
5. 切换实例不会停止另一边的 nginx。若界面显示已停止但站点还在，可能连到了另一份 prefix。

## 9.14 还是不行时的最小复现包

给同事或自己的未来：

1. `package.json` 的 version、Electron 版本
2. `node -v`、操作系统版本
3. 页脚完整错误 + `error.log` 末尾 30 行
4. 是否安装包还是 `npm start`
5. `runtime` 路径、`engines/active` 内容
6. 不要发送含证书私钥、basic auth 的完整 `nginx.conf`；脱敏后再贴

内部验证记录模板见 `artifacts/verification.md`。
