# 1. 项目概览

## 1.1 一句话说明

**Nginx Desk** 是一个只跑在 Windows 上的桌面程序：它自带一份官方 Windows nginx，帮当前用户在本机启动、停止、改配置、看日志、切换版本。用户不必自己安装 nginx，也不必配置环境变量。

它**不是**：

- Windows 系统服务（关机后不会自动起来，也没有开机自启）
- 多实例集群管理器（只管理自己工作目录里的那一份 nginx）
- 已有 nginx 安装的接管工具（不会去杀别人的 `nginx.exe`）
- 证书申请 / 负载均衡专用面板（这些可以手写进配置，但没有独立表单）

## 1.2 为什么做成桌面应用

命令行用 nginx 对很多人足够，但本项目的目标用户是「想在本机快速起一个反向代理或静态站，又不想记一堆路径和信号」的人。桌面应用把这些操作收成按钮：

| 用户动作 | 背后实际发生的事 |
|----------|------------------|
| 启动服务 | `nginx -t` 通过后，以工作目录为 prefix 拉起 `nginx.exe` |
| 优雅停止 | `nginx -s quit`，等工作进程处理完连接 |
| 重载配置 | 先 `-t`，再 `-s reload` |
| 校验并保存 | 写盘 → `-t`；失败则回滚，并留下上一份备份 |
| 新建站点 | 按表单生成 `server { ... }`，预览后再保存 |
| 引擎版本 | 从 nginx.org 下官方 zip，只抽出 `nginx.exe` 替换当前引擎；可删除非当前缓存 |

## 1.3 给完全新手的 nginx 概念

nginx 是一个 Web 服务器 / 反向代理。你只需要先记住四个概念：

1. **可执行文件** `nginx.exe`：真正干活的程序。
2. **prefix（工作目录）**：nginx 启动时用 `-p` 指定。相对路径（如 `logs/error.log`、`html`、`conf/nginx.conf`）都相对这个目录。
3. **主配置** `conf/nginx.conf`：全局设置，本项目用 `include sites/*.conf;` 引入各个站点。
4. **信号**：Windows 版 nginx 用 `nginx -s quit|reload|reopen` 控制已在运行的实例。它靠 **PID 文件** 找到进程。本项目强制 PID 文件必须是 `logs/nginx.pid`。

默认第一次启动后，本机可以访问：

```
http://127.0.0.1:8080
```

页面内容来自工作目录里的 `html/index.html`。

官方 Windows 版 nginx 被标为 beta，高并发生产环境请先读：

https://nginx.org/en/docs/windows.html

## 1.4 软件自己管什么、不管什么

```
本软件管理的范围
┌──────────────────────────────────────────────┐
│  %APPDATA%/nginx-desk/runtime/               │
│    nginx.exe          ← 当前启用的引擎副本   │
│    conf/              ← 主配置 + 站点        │
│    logs/              ← PID、错误、访问日志  │
│    html/ backups/ temp/                      │
│  %APPDATA%/nginx-desk/engines/               │
│    1.31.6/nginx.exe   ← 已下载版本缓存       │
│    active             ← 用户钉住的版本号     │
└──────────────────────────────────────────────┘

不会去碰
  C:\nginx\...、系统服务、其他用户目录里的 nginx
```

状态检测时，不只看 PID 数字是否存在，还会用 PowerShell 核对「这个 PID 的可执行文件路径」是不是本软件工作目录里的 `nginx.exe`。路径对不上就当成「未运行」，避免误操作别人的进程。

## 1.5 产品功能对照界面

界面左侧导航对应六个页面，全部是单页切换（没有路由库）：

| 页面 id | 菜单名 | 能力 |
|---------|--------|------|
| `overview` | 服务概览 | 状态、PID、版本、启动/停止/重载/校验/重开日志、打开工作目录 |
| `engines` | 引擎版本 | 拉 nginx.org 列表，安装、启用或删除指定 Windows 版本 |
| `config` | 配置文件 | 下拉选择 `nginx.conf` 或 `sites/*.conf`，编辑后校验保存 |
| `sites` | 新建站点 | 生成反向代理或静态站配置，跳到编辑器预览 |
| `logs` | 运行日志 | 读 `error.log` / `access.log` 末尾 64 KB，可 5 秒自动刷新 |
| `backups` | 配置备份 | 列出保存时产生的 `.bak`，载入编辑器后需再次保存才恢复 |

主题（极光青 / 矩阵绿 / 量子紫 / 战术金 / 脉冲红 / 寒冰蓝）只存在渲染进程的 `localStorage`，不经过主进程。

## 1.6 运行形态

- **开发**：`npm start` → Electron 加载仓库里的 `src/`，nginx 来自 `vendor/nginx`。
- **安装包**：`npm run dist` 打出 NSIS 安装向导。用户装好后，nginx 在安装目录的 `resources/nginx`，用户配置在 `%APPDATA%/nginx-desk`。
- **单实例**：同一时间只允许一个 Nginx Desk 窗口。再开一次会激活已有窗口。
- **关闭窗口**：若 nginx 在跑，会询问「取消 / 停止并退出 / 保持运行并退出」。保持运行后，再打开软件仍可管理同一实例。

## 1.7 许可证

- 本仓库源码：MIT（见根目录 `LICENSE`）。
- 打包进去的 nginx：保留官方许可证，安装后在 `resources/nginx/docs/LICENSE`。
