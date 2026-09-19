# 7. 构建与发布

本章按真实流水线说明：**源码 → 内置 nginx → 安装包 → 用户机器上的目录**。

请在**目标操作系统**上构建。Windows 机器打出 Windows 安装包，macOS 打出 DMG，Linux 打出 AppImage/deb。`prepare:nginx` 只会准备当前平台的引擎，不能交叉生成另一系统的 nginx 二进制。

## 7.1 一条命令在干什么

```bash
npm run dist
```

等价于：

```text
npm run prepare:nginx          # 保证 vendor/nginx 存在且校验过
electron-builder --publish never
```

electron-builder 默认打**当前操作系统**的安装包。输出目录：`dist/`（gitignore）。

指定平台：

| 命令 | 典型产物 |
|------|----------|
| `npm run dist:win` | `dist/Nginx Desk Setup 1.0.0.exe` |
| `npm run dist:mac` | `dist/Nginx Desk-1.0.0.dmg`、zip |
| `npm run dist:linux` | `dist/Nginx Desk-1.0.0.AppImage`、deb |

版本号来自 `package.json` 的 `"version"`。改版本号再打包装，安装程序文件名会变。

首次构建会下载 Electron 官方二进制和 electron-builder 缓存，需要网络，时间可能数分钟。macOS / Linux 第一次 `prepare:nginx` 还会编译 nginx，可能再增加几分钟。

## 7.2 准备内置 nginx：`scripts/prepare-nginx.cjs`

脚本逻辑：

1. 若当前平台引擎已在 `vendor/nginx/`（Windows 的 `nginx.exe`，Unix 的 `nginx`）→ **直接成功退出**
2. 否则从 `https://nginx.org/download/` 下载固定版本：Windows 为 `.zip`，macOS / Linux 为 `.tar.gz`
3. SHA256 必须等于脚本里写死的 `checksums`
4. 用系统 `tar` 解压
5. Windows：把 `vendor/nginx-1.31.6` 重命名为 `vendor/nginx`
6. Unix：在源码目录 `./configure` + `make`，把 `objs/nginx` 和 `conf/` 辅助文件、许可证拷到 `vendor/nginx`
7. 再打印一次哈希方便人工核对

`scripts/prepare-nginx.ps1` 只是调用上述 Node 脚本，方便 Windows 用户手动执行。

`vendor/` 被 gitignore，所以克隆仓库后每个人都要跑一次。CI 同样要跑，并且要在对应操作系统的 runner 上跑。

**升级捆绑版本时必须同时改版本号和对应平台的哈希。** 只改版本不改哈希会构建失败；只改哈希不改 URL 会下错包。下载后计算哈希：

```bash
# Windows PowerShell
Get-FileHash -LiteralPath vendor\nginx-1.31.6.zip -Algorithm SHA256

# macOS / Linux
shasum -a 256 vendor/nginx-1.31.6.tar.gz
```

核对 nginx.org 页面或发行说明。应用内「引擎版本」让用户再下其它官方包，与捆绑版本是两条线：捆绑版保证**离线第一次能启动**；用户钉住的版本存在用户数据目录，升级软件后仍优先。

Unix 编译会按本机依赖自动降级模块：优先带 SSL / HTTP/2；缺少 OpenSSL 或 PCRE 时去掉对应模块，保证至少能跑默认静态站和 HTTP 反向代理。若要编出更完整的引擎，先装开发库再删除 `vendor/nginx` 后重新 prepare。

## 7.3 `package.json` 的 `build` 字段

```json
{
  "appId": "com.nginxdesk.desktop",
  "productName": "Nginx Desk",
  "files": ["src/**/*", "package.json"],
  "extraResources": [{ "from": "vendor/nginx", "to": "nginx" }],
  "win": { "target": "nsis", "signAndEditExecutable": false },
  "mac": { "target": ["dmg", "zip"], "category": "public.app-category.developer-tools", "identity": null },
  "linux": { "target": ["AppImage", "deb"], "category": "Development" },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "deleteAppDataOnUninstall": false
  },
  "directories": { "output": "dist" }
}
```

逐项含义：

| 字段 | 效果 |
|------|------|
| `appId` | 各平台卸载信息、部分互斥逻辑的标识 |
| `productName` | 开始菜单 / 应用名、安装程序标题 |
| `files` | 打进应用包的源码；**不含** `docs/`、`test/`、`scripts/`、`vendor/`。生产依赖（目前是 `ssh2`）由 electron-builder 按 `dependencies` 另外打入 |
| `extraResources` | 额外拷到 `resources/nginx`，运行时 `process.resourcesPath/nginx` |
| `signAndEditExecutable: false` | Windows 不尝试 Authenticode 签名 |
| `mac.identity: null` | macOS 不尝试 Apple 代码签名 |
| `oneClick: false` | Windows 向导式安装，不是一键无界面 |
| `perMachine: false` | Windows 默认当前用户安装 |
| `allowToChangeInstallationDirectory` | Windows 用户可选路径 |
| `createDesktopShortcut` | Windows 桌面快捷方式 |
| `deleteAppDataOnUninstall: false` | Windows 卸载**保留** `%APPDATA%/nginx-desk` |

用户数据保留是产品决策：升级/重装不丢站点配置。若你要做「彻底清除」，应做成安装程序选项或应用内按钮，而不是默默删。

## 7.4 安装后磁盘布局（示意）

Windows 用户选择的安装目录：

```
C:\Users\<用户>\AppData\Local\Programs\Nginx Desk\
├── Nginx Desk.exe
├── Uninstall Nginx Desk.exe
└── resources\
    ├── app.asar
    └── nginx\
        ├── nginx.exe
        ├── conf\
        └── docs/LICENSE
```

macOS：

```
/Applications/Nginx Desk.app/Contents/
├── MacOS/Nginx Desk
└── Resources/
    ├── app.asar
    └── nginx/nginx
```

Linux（deb / 解压后的 AppImage 资源）大致为 `resources/nginx/nginx`。

运行后的用户数据：

```
<userData>/
├── runtime/
│   ├── nginx.exe 或 nginx
│   └── conf/ logs/ html/ ...
└── engines/
    ├── active
    └── 1.31.6/nginx.exe 或 nginx
```

注意有**三份** nginx 相关二进制概念：

1. 安装目录里只读的 `resources/nginx`（bundled）
2. `engines/<ver>/` 下的引擎（可累积多个版本）
3. `runtime` 里真正 `-p` 启动的那一份

`init()` 负责在安全的前提下让 3 指向用户想要的 2 或 1。

## 7.5 开发运行 vs 打包运行

| | `npm start` | 安装包 |
|--|-------------|--------|
| 代码 | 直接读仓库 `src/` | asar 内快照 |
| bundled nginx | `vendor/nginx` | `resources/nginx` |
| userData | 当前用户的 nginx-desk 目录 | 同左 |
| `app.isPackaged` | `false` | `true` |

所以：**用安装包测「升级是否保留配置」时，先用 `npm start` 造好用户数据，再装包打开。** 两者共享同一用户目录。UI 冒烟不共享，因为它改了 `userData`。

若开发时把日常实例搞坏，可退出软件并停掉 nginx 后删除用户数据目录（会丢掉站点配置），下次启动会重新 `init()` 出默认站。

## 7.6 发布检查清单

打好包后建议按顺序：

1. `npm test`、`npm run test:ui` 仍通过
2. 安装程序体积合理（含 Electron + nginx，通常一百多 MB 量级，以实际为准）
3. 在一台**没装 Node** 的同系统机器上安装
4. Windows：向导可选目录、桌面快捷方式出现。macOS：能打开 DMG 并拖到应用程序。Linux：AppImage 可执行或 deb 能装上
5. 首次启动，点「启动服务」，浏览器打开 http://127.0.0.1:8080
6. 改配置保存、重载、看日志
7. 关闭窗口选「保持运行」，再开软件仍显示运行中
8. 卸载后确认用户数据仍在
9. 计算安装包 SHA256，与 GitHub Release 说明一起发布（README 已说明未签名）

未签名时：Windows SmartScreen 可能警告「未知发布者」；macOS Gatekeeper 可能阻止打开。这是预期，不是构建失败。若要消除警告，需要购买对应平台的代码签名证书（macOS 还通常要公证），本仓库尚未配置。

## 7.7 GitHub Release 与 README 的关系

产品 README 指向：

https://github.com/cuijiying/NginxDesk/releases/latest

发布流程属于仓库运维，不在 `npm run dist` 内。你需要：

1. 更新 `package.json` version 与 README 如有必要
2. 在 Windows、macOS、Linux 上分别 `npm run dist`
3. 上传各平台安装包和 SHA256 文本
4. 写清「未签名、官方 nginx 许可证在安装目录」

不要把 `dist/` 或 `vendor/` 提交进 git。

## 7.8 构建失败时先看哪

| 现象 | 方向 |
|------|------|
| `prepare:nginx` checksum mismatch | 官方包变了或网络中间人；重算哈希或固定镜像策略 |
| Unix `configure` / `make` 失败 | 未装编译器；按脚本提示安装 Xcode CLT 或 gcc/make/开发库 |
| electron-builder 找不到 nginx | 没跑 prepare，或 `vendor/nginx` 根下没有当前平台引擎文件 |
| 打包进了测试截图/docs | 不在 `files` 里就不会进 asar；不必担心 docs 变大安装包 |
| 用户机器缺 `vendor` | 正常，用户只有 extraResources |
| 在 Windows 上 `dist:mac` | 需要 macOS 机；不要指望交叉打出可用的 Mac 引擎 |
| NSIS 制作报错 | 看 electron-builder 日志；杀毒软件有时锁 `dist/` 里的 exe |

更细的排错见 [故障排查](09-troubleshooting.md)。
