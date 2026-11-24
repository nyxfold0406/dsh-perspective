# 发布清单（PUBLISHING）

这份文件**不进 npm 包**（不在 `package.json` 的 `files` 白名单里），只给仓库用。

当前状态：**已发 0.1.0**（2026-11-11）。`node --check` 过、mock webServer 全绿、`npm pack --dry-run` 干净，registry 上的 tarball 已核对。

## 0. 发布记录

| 版本 | 时间（+08） | 账号 | 结果 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-11-11 22:18 | `nyxfold` | 已发布 → https://www.npmjs.com/package/dsh-perspective |

发法：一次性 granular token 写进**临时** npmrc（`--userconfig` 指向它），发完立刻删，没碰 `~/.npmrc`。

两个当时踩到/确认的点：

- **新包名首发的 202**：`npm publish` 返回 202 是「已接收、正在处理」，npm 会先建一个 `0.0.0-stage` 占位版本。别看到 202 或 `dist-tags.latest = 0.0.0-stage` 就以为失败——大约 45~90 秒后真版本才挂上 `latest`。等 1~2 分钟再 `npm view`。
- **核对发布物**：发布的 tarball sha1 `a3c4f4c3a905683ce8cf0f938dfb9572b7f016a1`，从 registry 拉回来解包 10 个文件，与本地 `npm pack` 字节一致，拿它跑完整 mock 验收 52/52。

### 发下一个版本

```powershell
# 1) 改 package.json 的 version（顺手改 client.js 里的 VERSION 常量）
# 2) 自检
& $node --check index.js
& $node --check client.js
& $node $npmcli pack --dry-run --cache $cache
# 3) 发布（token 从你那边拿，别贴进聊天记录）
& $node $npmcli publish --access public --userconfig <临时npmrc> --cache $cache
# 4) 等 1 分钟再确认
& $node $npmcli view dsh-perspective version --cache $cache
```

## 1. 首次发布还差什么（已完成 / 仍缺）

| # | 事 | 现状 |
| --- | --- | --- |
| 1 | npm 账号 + 登录 | ✅ 账号 `nyxfold`；用的是 granular token，没在 `~/.npmrc` 里留登录态 |
| 2 | 包名 `dsh-perspective` | ✅ 已占用（我们自己的 0.1.0） |
| 3 | `repository` / `homepage` / `bugs` | ⚠️ 字段写的是 `github.com/Vesperviod/dsh-perspective`，**仓库还没建**，npm 页面上那几个链接现在会 404。建仓后要么保持、要么改地址（改名要发新版本才生效） |
| 4 | LICENSE 版权人 | ✅ MIT，署名 `Vesperviod` |
| 5 | 2FA / OTP | ✅ granular token 已带发布权限，没要 OTP |
| 6 | registry 指向 | ✅ `https://registry.npmjs.org/` |
| 7 | 版本号 | ✅ 0.1.0 起 |

## 2. 发之前跑一遍（本机怎么跑）

这台机器 PATH 里没有 `node`/`npm`，用的是 DSH 自带的运行时：

```powershell
$node   = 'C:\Users\QSL\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$npmcli = 'D:\AGENTS\Becky\.tmp-npm\node_modules\npm\bin\npm-cli.js'   # 临时装的 npm 12
$cache  = 'D:\AGENTS\Becky\.tmp-npm\cache'                             # 别写到 %LOCALAPPDATA%

cd D:\AGENTS\Becky\plugins\perspective
& $node --check index.js
& $node --check client.js
& $node $npmcli pack --dry-run --cache $cache
```

验收用的 mock 服务器在 `D:\AGENTS\Becky\.tmp-perspective-test\test.mjs`（不在包内）：它把打包出来的 tgz 解到临时 `node_modules` 里，用假 webServer 跑一遍 `/scenes` `/assets` `/scene` `/image` `/save` `/delete` `/upload` `/capabilities`，再验证依赖缺失时那五条路由是 404 + 原因。

## 3. 真发（有账号之后）

```powershell
cd D:\AGENTS\Becky\plugins\perspective
& $node $npmcli publish --dry-run --cache $cache     # 只看，不发
& $node $npmcli publish --access public --cache $cache
```

- `package.json` 里**不能有** `"private": true`（现在没有；有的话 npm 会直接拒发）。
- 发之前确认 `files` 白名单只有：`index.js`、`client.js`、`prompts.json`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`。`README.md` 和 `LICENSE` npm 会自动带上。
- 发包前顺手确认：`Select-String -Path *.js,*.yml -Pattern 'D:/AGENTS|AGENTS\\Becky'` 应该是空的（包里不许出现某台机器的绝对路径）。

## 4. 发出去之后

```powershell
& $node $npmcli view dsh-perspective --cache $cache        # 能看到 0.1.0
```

然后在**干净**的 profile 里装一次，确认不是靠本机残留跑起来的：

1. 新 profile 的 `package.json`：`"dependencies": { "dsh-perspective": "0.1.0" }`，`"dsh": { "profile": { "bundles": ["dsh-perspective"] } }`；
2. `pnpm install`；
3. 重启 DSH → 侧边栏出现图标；
4. 打开面板：没有 `scenes/` 时应该显示「没找到工作区」的提示而不是报错；
5. 点一下「立绘工坊」：没有 python / MOSS / VLM 的机器上按钮是灰的，鼠标悬停能看到原因。

## 5. 已知的发布后注意

- 这个插件的核心（透视对位）不依赖任何外部程序；三块本地增强（入库 / 去白边 / 生成立绘）只是可选能力，缺了就灰掉。别在 README 里把它们说成必需。
- `prompts.json` 里是作者自己角色的立绘提示词模板（base 描述的是固定角色设定）。别人装上去是「别人家的角色」，用之前得改 `base` 和 `outfits`——README 里已经说了这是模板。
- 客户端 `VERSION` 常量目前写死 `v0.1.0`，发版时记得一起改。
