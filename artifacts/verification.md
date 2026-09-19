# 验证记录

环境：Windows 10 x64，Node.js 22.22.1，Electron 44.4.1，nginx 1.31.6。

- `npm test`：5 项通过。覆盖参数和路径约束、官方列表解析（Windows zip 与 Unix tar.gz）、进程归属比较，以及真实 nginx 配置校验、错误回滚、备份、启动、HTTP 请求、反向代理、静态站点、热重载、日志与优雅停止。
- `npm run test:ui`：通过。真实 Electron 窗口、隔离用户目录，检查配置加载、受限 IPC、页面导航和站点配置生成。测试截图保存在本地 `desktop-smoke.png`。
- 跨平台引擎准备与打包脚本已落地（`prepare-nginx.cjs`、`dist:win` / `dist:mac` / `dist:linux`）。本次环境只验证了 Windows 路径。
- 安装程序 Authenticode 状态：NotSigned。

未在 macOS / Linux 实机执行 prepare 编译、安装包回归或 Gatekeeper / AppImage 启动验证。未执行安装向导的完整安装/卸载回归，也未验证 Windows 11、域策略环境或大规模并发负载。
