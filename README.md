# dsh-perspective

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的 Web 侧边栏加一个「透视对位」面板：把一张透明人物立绘按**真实相机参数**摆进一张实拍照片里，画布上实时预览、直接用鼠标拖着人走，调好之后把数字写回 `scenes/<name>.yaml`。

它是纯 Node + 浏览器 canvas，**不依赖任何外部程序**就能跑：装到一台机器上，只要有一个 `scenes/` 目录、一张底图、一张立绘，面板就能用。

![面板](icon.svg)

## 它解决什么问题

把立绘合成进实拍照片，最难的不是抠图，是「量」。人站在哪里、多大、脚底压在哪条线上，全由相机决定：

- 镜头焦距决定画面多广、人物像素高多少；
- 俯角决定地平线落在画面的哪个高度；
- 相机高度、人物到相机的距离、横向偏移决定脚底落点。

凭眼睛拧到「差不多」是最慢的：改一个数，其它全跟着歪。这个面板把五个参数做成滑块，配合地面透视网格、地平线和脚底线，边拖边看；最后三个数（`PITCH_DEG` / `CHAR_X` / `CHAR_D`）连同它们和焦距的搭配一起写回 yaml，给下游的渲染脚本用。

两个细节值得说：

- **拖人而不是拖滑块**：画布上按住人物往左右前后拖，落点反解成世界坐标（`solveGround`），比同时转「横向」和「距离」两个滑块直观得多。
- **写回是逐行改**：yaml 里的注释一行不动。那些注释本身在讲 `FEQ` 和 `PITCH_DEG` 必须成对改，比数字值钱。

## 安装

### 1) 从 npm 装（推荐）

在 DSH 的插件管理里安装 `dsh-perspective`（bundle），或者手动改你的 profile：

`~/.dsh/profiles/<profile>/package.json`

```json
{
  "dependencies": {
    "dsh-perspective": "0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-perspective"]
    }
  }
}
```

然后 `pnpm install`（在 profile 目录里跑）并重启 DSH。侧边栏会出现一个「透视对位」图标。

### 2) 本地开发 / 改代码

```json
"dsh-perspective": "link:C:/path/to/your-project/plugins/perspective"
```

`link:` 安装时，插件会自动把「包所在目录的上两级」当作工作区候选——如果插件正好放在 `<工作区>/plugins/perspective`，就不用配 `workspace`。

### 工作区怎么定

按这个顺序找，第一个「里面有 `scenes/` 目录」的胜出：

1. `config.workspace`
2. 环境变量 `DSH_PERSPECTIVE_WORKSPACE`（或 `PERSPECTIVE_WORKSPACE`）
3. 包所在目录的上一级（`<工作区>/plugins/perspective` 这种布局）
4. 进程 cwd

都没命中时面板不会报错，只会显示一行提示让你去配置。

## 快速开始

1. 工作区里放底图：`素材/实拍/xxx.jpg`（目录名可配）。
2. 写一个场景文件 `scenes/xxx.yaml`（最少只要 `PHOTO` 一行，其它键用默认值）：

   ```yaml
   PHOTO: 素材/实拍/xxx.jpg
   CHAR: 素材/角色/xxx.png      # 透明立绘
   CAM_H: 1.8                   # 相机离地高度（米）
   FEQ: 24.0                    # 35mm 等效焦距（毫米）
   PITCH_DEG: -1.75             # 俯角，向下为正
   CHAR_X: 0.0                  # 横向偏移，右正（米）
   CHAR_D: 3.2                  # 人物到相机的水平距离（米）
   CHAR_H: 1.62                 # 人物身高（米）
   ```

3. 打开侧边栏「透视对位」：选场景 → 打开网格 → 拖滑块/拖人 → 勾「参数已确认」→ 「保存并写回 yaml」。

## scene yaml 的字段

面板只碰下面这几个键，**其余键和注释原样保留**（`DEPTH_NPY`、`USE_DOF`、`_SH_*` 这些是下游渲染脚本的，面板不管）。

| 键 | 单位 | 面板里的名字 | 含义 |
| --- | --- | --- | --- |
| `PHOTO` | 相对路径 | 底图 | 实拍照片，相对于工作区根目录（也接受绝对路径，但必须在工作区内） |
| `CHAR` | 相对路径 | 立绘 | 透明 PNG，脚底大致在图片底边 |
| `CAM_H` | 米 | 相机高 | 相机离地高度；手机举在胸前约 1.3–1.4，站着端平约 1.6–1.8 |
| `FEQ` | 毫米 | 焦距 | 35mm 等效焦距。与 `PITCH_DEG` **成对**，别单独改一个 |
| `PITCH_DEG` | 度 | 俯角 | 镜头向下为**正**；平视 0，俯拍 10–30 |
| `CHAR_X` | 米 | 横向 | 相对画面中轴的横向偏移，右正 |
| `CHAR_D` | 米 | 距离 | 相机到人物（脚底那一点）的水平距离 |
| `CHAR_H` | 米 | （读） | 人物身高，决定像素高；默认 1.62 |
| `CHAR_CROP` | 比例 | （下拉） | 立绘覆盖到人物哪一段：`1` 全身 / `0.72` 膝上 / `0.55` 半身 / `0.35` 胸上 |
| `SCALE_TWEAK` | 倍 | 大小微调 | 只改大小、不动位置的主观微调，一般 1.0 |
| `CONFIRMED` | 布尔 | 勾选框 | 人工确认闸门；下游 `render --final` 通常只认 `true` |

关系式（也是面板里画地平线和网格用的）：

```
F  = 像素焦距，由 FEQ 和画幅决定
v_h = H/2 - F * tan(PITCH_DEG)          # 地平线在画面上的 v
脚底 (u,v) ── solveGround ──> (CHAR_X, CHAR_D)
```

## 配置项

全部可选。写在 `cordis.patch.yml` 的 `config` 下（或 profile 层覆盖，同 id），也可以用环境变量。

| 键 | 默认 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `workspace` | 自动探测 | `DSH_PERSPECTIVE_WORKSPACE` | 工作区绝对路径 |
| `sceneDir` | `scenes` | — | 场景 yaml 目录（相对工作区） |
| `photosDir` | `素材/实拍` | — | 底图目录：拖图入库的落点 + 素材下拉 |
| `charsDir` | `素材/角色` | — | 立绘目录 |
| `python` | 自动探测 | `DSH_PERSPECTIVE_PYTHON` | 跑本地工具脚本的解释器 |
| `ffmpeg` | 自动探测 | `DSH_PERSPECTIVE_FFMPEG` / `FFMPEG_PATH` | 只用于 HEIC 转码和识图前缩图 |
| `tools.intake` | `tools/intake_scene.py` | — | 拖图入库脚本 |
| `tools.makeChar` | `tools/make_char.py` | — | 生成立绘后的验同人 + 抠图脚本 |
| `tools.fixEdges` | `tools/fix_edges.py` | — | 一键去白边脚本 |
| `moss.url` | 同源 | `DSH_PERSPECTIVE_MOSS_URL` | MOSS 出图服务；空 = 用当前站点同源的 `/api/moss-studio` |
| `vlm.url` | `http://127.0.0.1:11435/v1/chat/completions` | `VLM_URL` | OpenAI 兼容的视觉服务 |
| `vlm.health` | 由 `vlm.url` 推 | `VLM_HEALTH` | 健康检查地址；服务没起时用来判断，也用于自启动轮询 |
| `vlm.model` | `Qwen2.5-VL-3B-Instruct` | `VLM_MODEL` | 模型名 |
| `vlm.bootScript` | `tools/vision/serve_vlm.py`（存在才用） | — | 视觉服务的启动脚本；配了才会自启动 |
| `vlm.python` | 同 `python` | `VLM_PY` | 启动视觉服务用的解释器 |
| `protectedChars` | `[]` | — | 文件名列表，`/delete` 拒删这些（例如你的基准图） |
| `maxBodyBytes` | 32 MiB | — | 请求体上限 |

自动探测只做几件不猜机器的事：PATH 里找可执行文件（跳过 Windows 商店那个占位 `python.exe`）、看工作区里的 `envs/matting/Scripts/python.exe`、`.venv/Scripts/python.exe` 这类相对位置、以及 ffmpeg 在 Windows 上的两个常见安装位置（`C:\ffmpeg\bin`、`C:\Program Files\ffmpeg\bin`）。VLM 默认指向本机 llama.cpp 那套服务的 11435 端口。探测到的二进制会先跑一次 `--version` / `-version` 才算数；任何一项都可以用上面的键覆盖，指错了会在 `/capabilities` 里说清是哪一个、为什么不成。

## 能力探测：缺什么会怎样

主机端每次都按「真的在不在」判断，给 `/capabilities` 一个明确的表。面板拿到表之后，缺的那几项按钮直接置灰，鼠标悬停能看到原因；直接打那几条路由则回 **404 + 原因**，不会 500。

| 路由 | 依赖 | 缺了之后 |
| --- | --- | --- |
| `GET /scenes` `/assets` `/scene` `/image` | 无（纯 Node） | 永远可用 |
| `POST /save` `/delete` `/upload` | 无（`/upload` 收 HEIC 时要 ffmpeg） | HEIC 才需要 ffmpeg |
| `GET /capabilities` | 无 | 告诉你缺什么 |
| `POST /intake` | python + `tools.intake` | `404 { code: "no-python" \| "no-tool", error, hint }` |
| `POST /decontam` | python + `tools.fixEdges` | 同上 |
| `POST /vision` | VLM（可选自启动） | `404 { code: "no-vlm", error: "本地视觉服务没起来（…）" }` |
| `POST /prompts` | 与 `/vision` 同一套（候选提示词没有识图结果没意义） | 同上 |
| `POST /generate` | MOSS + python + `tools.makeChar` | `404 { code: "no-moss" \| "no-python" \| "no-tool", error, hint }` |

404 的响应体统一长这样：

```json
{
  "error": "没有 python 环境（自动探测没找到解释器）",
  "code": "no-python",
  "capability": "intake",
  "what": "把一张实拍图丢进工作区并建场景，需要 python 和入库脚本",
  "hint": "在 cordis.patch.yml 里设 config.python 指向 python.exe"
}
```

## 本地增强（可选）

这三块**不是必需的**，缺了只是按钮灰掉，透视对位照常工作。想接自己的脚本，按这些命令行约定实现即可（相对路径都按工作区根目录解析，`cwd` 也是工作区根）：

```bash
# 拖图入库：读一张 素材/实拍/ 下的图，写一个 scenes/<name>.yaml
python tools/intake_scene.py <素材/实拍/xxx.jpg> --name <scene>

# 生成立绘：把 MOSS 出的图验同人（face_sim）再抠成透明 PNG
python tools/make_char.py <_gen-*.png> --out 素材/角色/<name>.png --min-sim 0.6

# 一键去白边：反预乘去污染，必要时先抠图
python tools/fix_edges.py <素材/角色/x.png> --out 素材/角色/x-去白边.png [--bg N] [--band N] [--force-matte]
```

`prompts.json` 是提示词模板库，「候选提示词」从里面挑：`base` 是角色固定设定，`outfits` 按识图结果分组，`shots` / `poses` 是景别和姿势。**默认那份描述的是插件作者自己的角色**（黑短发、灰蓝挑染、不笑、蓝眼睛），换角色就改 `base` 和 `outfits`——改完不用重启 DSH。

## HTTP API

插件挂在 `/api/perspective` 前缀下。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/scenes` | 场景列表（含 `photoOk` / `charOk`） |
| GET | `/capabilities` | 本机能力表 |
| GET | `/assets` | 底图 / 立绘清单 |
| GET | `/scene?name=` | 单个场景的键值 |
| GET | `/image?name=&kind=photo\|char` 或 `?path=` | 图片字节（只允许工作区内的图片） |
| POST | `/save` | `{ scene, values }`，逐行写回 yaml |
| POST | `/delete` | `{ path }`，删立绘（受 `protectedChars` 保护） |
| POST | `/upload` | `{ name, data }`（base64 dataURL） |
| POST | `/intake` `/decontam` `/vision` `/prompts` `/generate` | 见上一节 |

## 投影数学

在 `client.js` 里，是一份可以直接抄的 JS：

```
focalPx(W,H,feq)   35mm 等效焦距 → 像素焦距（4:3 及更方的画幅按短边量）
project(x,y,d)     世界坐标 → 像素；y 向上为正，脚底 y = -camH
solveGround(u,v)   像素落点反解世界坐标（拖人用这个）
horizonV()         地平线 v = H/2 - F·tan(pitch)
```

全景：`Zc = -y·sin p + d·cos p`，`Yc = -y·cos p - d·sin p`，`u = W/2 + F·x/Zc`，`v = H/2 + F·Yc/Zc`。

## 已知限制

- 场景 yaml 只认一层 `key: value`（不支持嵌套、多行值）；写回是逐行替换，注释保留但你手写的缩进层会被拍平。
- 立绘要和底图人物同一套投影；半身/膝上的图必须把 `CHAR_CROP` 设成对应值，否则脚底对不上。
- 面板只在 Web UI 里（`dsh.client.platform = "web"`）。
- 深度图景深、前景遮挡、投影落地阴影是下游渲染脚本的事，本插件只负责把参数调对。
- 拖拽需要底图先加载成功；底图缺失时面板会提示「底图文件不存在」。

## License

MIT © Vesperviod
