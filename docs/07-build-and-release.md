# 7. 构建与发布

本章按真实流水线说明：**源码 → 内置 nginx → 安装包 → 用户机器上的目录**。

## 7.1 一条命令在干什么

```powershell
npm run dist
```

等价于：

```text
npm run prepare:nginx          # 保证 vendor/nginx 存在且校验过
electron-builder --win nsis --x64
```

输出目录：`dist/`（gitignore）。

典型产物：

```text
dist/Nginx Desk Setup 1.0.0.exe
```

版本号来自 `package.json` 的 `"version"`。改版本号再打包装，安装程序文件名会变。

首次构建会下载 Electron 官方二进制和 electron-builder 缓存，需要网络，时间可能数分钟。

## 7.2 准备内置 nginx：`scripts/prepare-nginx.ps1`

脚本逻辑：

1. 若 `vendor/nginx/nginx.exe` 已存在 → **直接成功退出**（不重复下载）
2. 否则下载 `https://nginx.org/download/nginx-1.31.6.zip` 到 `vendor/`
3. SHA256 必须等于脚本里写死的 `expected`
4. `Expand-Archive` 解压，把 `vendor/nginx-1.31.6` 重命名为 `vendor/nginx`
5. 再打印一次哈希方便人工核对

`vendor/` 被 gitignore，所以克隆仓库后每个人都要跑一次。CI 同样要跑。

**升级捆绑版本时必须同时改两处：** `$version` 和 `$expected`。只改版本不改哈希会构建失败；只改哈希不改 URL 会下错包。下载后用 PowerShell 算哈希：

```powershell
Get-FileHash -LiteralPath vendor\nginx-1.31.6.zip -Algorithm SHA256
```

核对 nginx.org 页面或发行说明。应用内「引擎版本」让用户再下其它官方 Windows 包，与捆绑版本是两条线：捆绑版保证**离线第一次能启动**；用户钉住的版本存在 AppData，升级软件后仍优先。

## 7.3 `package.json` 的 `build` 字段

```json
{
  "appId": "com.nginxdesk.desktop",
  "productName": "Nginx Desk",
  "files": ["src/**/*", "package.json"],
  "extraResources": [{ "from": "vendor/nginx", "to": "nginx" }],
  "win": { "target": "nsis", "signAndEditExecutable": false },
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
| `appId` | Windows 卸载信息、部分互斥逻辑的标识 |
| `productName` | 开始菜单名、安装程序标题、exe 产品名 |
| `files` | 打进应用包的源码；**不含** `docs/`、`test/`、`scripts/`、`vendor/` |
| `extraResources` | 额外拷到 `resources/nginx`，运行时 `process.resourcesPath/nginx` |
| `signAndEditExecutable: false` | 不尝试签名（当前发布未做 Authenticode） |
| `oneClick: false` | 向导式安装，不是一键无界面 |
| `perMachine: false` | 默认当前用户安装 |
| `allowToChangeInstallationDirectory` | 用户可选路径 |
| `createDesktopShortcut` | 桌面快捷方式 |
| `deleteAppDataOnUninstall: false` | 卸载**保留** `%APPDATA%/nginx-desk` |

用户数据保留是产品决策：升级/重装不丢站点配置。若你要做「彻底清除」，应做成安装程序选项或应用内按钮，而不是默默删。

## 7.4 安装后磁盘布局（示意）

用户选择的安装目录（示例）：

```
C:\Users\<用户>\AppData\Local\Programs\Nginx Desk\
├── Nginx Desk.exe              启动器
├── Uninstall Nginx Desk.exe
└── resources\
    ├── app.asar                源码（src + package.json）
    └── nginx\                  extraResources
        ├── nginx.exe
        ├── conf\
        ├── docs\LICENSE        官方许可证
        └── html\ ...
```

运行后：

```
C:\Users\<用户>\AppData\Roaming\nginx-desk\
├── runtime\                    Manager.root
│   ├── nginx.exe               从 resources/nginx 或 engines 拷来的工作副本
│   └── conf\ logs\ html\ ...
└── engines\
    ├── active                  文本，如 1.31.6
    └── 1.31.6\nginx.exe
```

注意有**三份** nginx 相关二进制概念：

1. 安装目录里只读的 `resources/nginx`（bundled）
2. `engines/<ver>/nginx.exe`（可累积多个版本）
3. `runtime/nginx.exe`（真正 `-p` 启动的那一份）

`init()` 负责在安全的前提下让 3 指向用户想要的 2 或 1。

## 7.5 开发运行 vs 打包运行

| | `npm start` | 安装包 |
|--|-------------|--------|
| 代码 | 直接读仓库 `src/` | asar 内快照 |
| bundled nginx | `vendor/nginx` | `resources/nginx` |
| userData | 仍是 `%APPDATA%/nginx-desk` | 同左 |
| `app.isPackaged` | `false` | `true` |

所以：**用安装包测「升级是否保留配置」时，先用 `npm start` 造好 AppData，再装包打开。** 两者共享同一用户目录。UI 冒烟不共享，因为它改了 `userData`。

若开发时把日常实例搞坏，可退出软件并停掉 nginx 后删除 `%APPDATA%\nginx-desk`（会丢掉站点配置），下次启动会重新 `init()` 出默认站。

## 7.6 发布检查清单

打好包后建议按顺序：

1. `npm test`、`npm run test:ui` 仍通过
2. 安装程序体积合理（含 Electron + nginx，通常一百多 MB 量级，以实际为准）
3. 在一台**没装 Node** 的 Windows 上安装
4. 向导可选目录、桌面快捷方式出现
5. 首次启动，点「启动服务」，浏览器打开 http://127.0.0.1:8080
6. 改配置保存、重载、看日志
7. 关闭窗口选「保持运行」，再开软件仍显示运行中
8. 卸载后确认 AppData 仍在；快捷方式移除
9. 计算安装包 SHA256，与 GitHub Release 说明一起发布（README 已说明未签名）

Windows 未签名时，SmartScreen 可能警告「未知发布者」。这是预期，不是构建失败。若要消除警告，需要购买代码签名证书并改 `signAndEditExecutable`，本仓库尚未配置。

## 7.7 GitHub Release 与 README 的关系

产品 README 指向：

https://github.com/cuijiying/NginxDesk/releases/latest

发布流程属于仓库运维，不在 `npm run dist` 内。你需要：

1. 更新 `package.json` version 与 README 如有必要
2. 本地 `npm run dist`
3. 上传 `Nginx Desk Setup x.y.z.exe` 和 SHA256 文本
4. 写清「未签名、官方 nginx 许可证在安装目录」

不要把 `dist/` 或 `vendor/` 提交进 git。

## 7.8 构建失败时先看哪

| 现象 | 方向 |
|------|------|
| `prepare-nginx` checksum mismatch | 官方 zip 变了或网络中间人；重算哈希或固定镜像策略 |
| electron-builder 找不到 nginx | 没跑 prepare，或 `vendor/nginx` 结构不是「根下直接 nginx.exe」 |
| 打包进了测试截图/docs | 不在 `files` 里就不会进 asar；不必担心 docs 变大安装包 |
| 用户机器缺 `vendor` | 正常，用户只有 extraResources |
| NSIS 制作报错 | 看 electron-builder 日志；杀毒软件有时锁 `dist/` 里的 exe |

更细的排错见 [故障排查](09-troubleshooting.md)。
