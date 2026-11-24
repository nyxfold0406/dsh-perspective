// Perspective placement panel for DeepSeek Harness — host half.
//
// Reads scenes/<name>.yaml plus the photo/character files it points at, hands
// them to the sidebar panel (client.js), and writes tuned numbers back into the
// same yaml. The write-back is line-level so every comment in the file survives
// (they document the FEQ/PITCH_DEG pairing and are worth more than the numbers).
//
// Two layers of routes:
//
//   core — Node builtins only, works on any machine that has a scenes folder:
//     GET  /scenes  /capabilities  /assets  /scene  /image
//     POST /save  /delete  /upload
//
//   optional local tooling — every route answers 404 with a readable reason
//   when its dependency is missing instead of exploding into a 500:
//     POST /intake  /decontam  /vision  /prompts  /generate
//
// Nothing here knows about a particular machine. workspace / ffmpeg / python /
// MOSS / VLM all come from `config` first, then from the environment, then from
// a best-effort auto-detection. See README.md for the config keys.
import { readdirSync, existsSync, readFileSync, openSync, statSync } from 'node:fs'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const name = 'perspective'
export const inject = ['webServer']

const HERE_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROUTE = '/api/perspective'
const MAX_BODY = 32 * 1024 * 1024

// 写回时保留的小数位：物理量精度不同，别把 30.3 写成 30.3000
const FMT = {
  FEQ: 1, CAM_H: 2, PITCH_DEG: 2,
  CHAR_X: 3, CHAR_D: 3, CHAR_H: 2, CHAR_CROP: 2, SCALE_TWEAK: 3,
  EDGE_BLEND: 2, CHAR_BG: 0,
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.bmp': 'image/bmp',
}
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp']

// Auto-detection candidates that are not machine-specific: paths relative to
// the workspace, plus a couple of well-known install locations. Anything else
// has to come from config.
const PY_CANDIDATES = [
  ['envs', 'matting', 'Scripts', 'python.exe'],
  ['.venv', 'Scripts', 'python.exe'],
  ['venv', 'Scripts', 'python.exe'],
  ['envs', 'matting', 'bin', 'python'],
  ['.venv', 'bin', 'python'],
]
const FFMPEG_COMMON = [
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
]

// ── yaml：只认 key: value 这一层 ──────────────────────────────
function stripComment(body) {
  let quote = null
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '#' && (i === 0 || body[i - 1] === ' ' || body[i - 1] === '\t')) {
      let j = i
      while (j > 0 && (body[j - 1] === ' ' || body[j - 1] === '\t')) j -= 1
      return [body.slice(0, j), body.slice(j)]
    }
  }
  return [body, '']
}

function parseValue(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(',').map((v) => parseValue(v))
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s.replace(/^['"]|['"]$/g, '')
}

function parseYaml(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '')
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][\w.-]*)\s*:\s*([\s\S]*)$/)
    if (!m) continue
    const [value] = stripComment(m[2])
    out[m[1]] = parseValue(value)
  }
  return out
}

function fmtValue(key, v) {
  if (v === true) return 'true'
  if (v === false) return 'false'
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return v.toFixed(FMT[key.toUpperCase()] ?? 3)
  return String(v)
}

function saveYaml(text, updates) {
  const norm = {}
  for (const [k, v] of Object.entries(updates)) norm[k.toUpperCase()] = v

  const seen = new Set()
  const changed = []
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\s*)([A-Za-z_][\w.-]*)(\s*:)(\s*)([\s\S]*)$/)
    if (m) {
      const key = m[2].toUpperCase()
      if (key in norm && !seen.has(key)) {
        seen.add(key)
        const [oldVal, comment] = stripComment(m[5])
        const newVal = fmtValue(key, norm[key])
        let next
        if (comment) {
          const col = m[1].length + m[2].length + m[3].length + m[4].length
            + oldVal.length + (comment.length - comment.trimStart().length)
          const head = m[1] + m[2] + m[3] + m[4] + newVal
          next = head + ' '.repeat(Math.max(2, col - head.length)) + comment.trimStart()
        } else {
          next = m[1] + m[2] + m[3] + m[4] + newVal
        }
        out.push(next)
        if (oldVal.trim() !== newVal) changed.push([m[2], oldVal.trim(), newVal])
        continue
      }
    }
    out.push(line)
  }
  const added = []
  for (const [k, v] of Object.entries(norm)) {
    if (!seen.has(k)) {
      added.push(k)
      out.push(`${k}: ${fmtValue(k, v)}`)
    }
  }
  return { text: out.join('\n'), changed, added }
}

// ── 小工具 ───────────────────────────────────────────────────
const pickStr = (...vals) => {
  for (const v of vals) {
    if (v === undefined || v === null) continue
    const s = String(v).trim()
    if (s) return s
  }
  return ''
}

const firstLine = (s, max = 200) => {
  const line = String(s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || ''
  return line.slice(0, max)
}

const toPosix = (p) => String(p).replace(/\\/g, '/')

function isFile(p) {
  try { return statSync(p).isFile() } catch { return false }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function looksLikeDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

// 二进制的探测结果缓存一小会儿：面板挂载时会连打几个请求，
// 别为了同一个问题反复 spawn 子进程。
const memo = new Map()
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value
  const value = await fn()
  memo.set(key, { at: Date.now(), value })
  return value
}

function pathDirs() {
  return String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)
}

// Windows 商店的 python.exe 是个占位转发器（跑起来只会弹商店），
// 从 PATH 里认出来当没有 python 处理。
const FAKE_BIN = ['\\microsoft\\windowsapps\\']

function whichOnPath(names) {
  for (const dir of pathDirs()) {
    for (const n of names) {
      const p = path.join(dir, n)
      const low = p.toLowerCase()
      if (FAKE_BIN.some((f) => low.includes(f))) continue
      if (isFile(p)) return p
    }
  }
  return ''
}

// ── 插件本体 ─────────────────────────────────────────────────
export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const sub = (key) => (cfg[key] && typeof cfg[key] === 'object' ? cfg[key] : {})

  const sceneDirCfg = pickStr(cfg.sceneDir, 'scenes')
  const photosDirCfg = pickStr(cfg.photosDir, '素材/实拍')
  const charsDirCfg = pickStr(cfg.charsDir, '素材/角色')
  const toolsCfg = sub('tools')
  const mossCfg = sub('moss')
  const vlmCfg = sub('vlm')

  // 工作区：config → 环境变量 → 包所在目录的上一级（link: 安装时正好是项目根）
  // → 进程 cwd。哪一层看着像工作区就用哪一层；都不像就留空，让面板提示去配置。
  function detectWorkspace() {
    const explicit = pickStr(cfg.workspace, process.env.DSH_PERSPECTIVE_WORKSPACE,
      process.env.PERSPECTIVE_WORKSPACE)
    const nearPackage = path.resolve(HERE_DIR, '..', '..')
    const cands = [
      ['config.workspace', explicit],
      ['package-neighbour', nearPackage],
      ['cwd', process.cwd()],
    ]
    const tried = []
    for (const [source, cand] of cands) {
      if (!cand) continue
      const abs = path.resolve(cand)
      if (tried.includes(abs)) continue
      tried.push(abs)
      if (looksLikeDir(path.join(abs, sceneDirCfg))) return { root: abs, source, tried }
    }
    // 显式配了但还没有 scenes/：仍然认这个根，面板可以靠它建目录
    if (explicit) return { root: path.resolve(explicit), source: 'config.workspace', tried }
    return { root: null, source: null, tried }
  }

  const detected = detectWorkspace()
  const root = detected.root
  const sceneDir = root ? path.join(root, sceneDirCfg) : null
  const photosDir = root ? path.join(root, photosDirCfg) : null
  const charsDir = root ? path.join(root, charsDirCfg) : null

  const protectedChars = Array.isArray(cfg.protectedChars)
    ? cfg.protectedChars.map(String)
    : []
  const maxBody = Number(cfg.maxBodyBytes) > 0 ? Number(cfg.maxBodyBytes) : MAX_BODY

  const resolveRel = (p) => (path.isAbsolute(String(p)) ? String(p) : path.join(root, String(p)))
  const scenePath = (scene) => path.join(sceneDir, `${scene}.yaml`)

  function listScenes() {
    if (!sceneDir || !existsSync(sceneDir)) return []
    return readdirSync(sceneDir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.slice(0, -5))
      .sort()
  }

  async function readScene(scene) {
    if (!root) throw new Error('这个插件还没找到工作区：请在 cordis.patch.yml 里设 config.workspace')
    const file = scenePath(scene)
    if (!existsSync(file)) throw new Error(`找不到场景 ${scene}: ${file}`)
    const text = await readFile(file, 'utf8')
    return { file, text, cfg: parseYaml(text) }
  }

  function json(res, code, value) {
    const body = Buffer.from(JSON.stringify(value))
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > maxBody) throw new Error('body too large')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  function imageOk(relPath) {
    if (!relPath) return false
    if (!IMAGE_EXTS.includes(path.extname(String(relPath)).toLowerCase())) return false
    return true
  }

  async function sendImage(res, relPath) {
    if (!relPath) return json(res, 404, { error: '没有配置这个文件' })
    if (!root) return json(res, 404, { error: '还没找到工作区（config.workspace）' })
    const file = resolveRel(relPath)
    if (!isInside(root, file)) return json(res, 403, { error: '只允许读工作区里的文件' })
    if (!imageOk(file)) return json(res, 400, { error: '不是图片文件' })
    if (!existsSync(file)) return json(res, 404, { error: `文件不存在: ${relPath}` })
    const bytes = await readFile(file)
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
    })
    res.end(bytes)
  }

  // 生成时的中间文件以 _gen- 开头，处理完本该删掉；万一没删干净，
  // 也不能让它混进素材下拉——用户会看到一个乱码文件名，以为生成坏了。
  function listDir(dirAbs, relPrefix, exts) {
    if (!dirAbs || !existsSync(dirAbs)) return []
    return readdirSync(dirAbs)
      .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
      .filter((f) => !f.startsWith('_gen-') && !f.startsWith('_up-') && !f.startsWith('.'))
      .sort()
      .map((f) => ({ name: f, path: `${relPrefix}/${f}` }))
  }

  function run(cmd, args, opts = {}) {
    const timeoutMs = Number(opts.timeoutMs) || 120000
    // 有些受限环境（沙箱、严格杀软）不允许子进程接管道。探测只关心退出码，
    // 那种场景可以 capture: false 绕开管道；真要读输出时再 capture。
    const capture = opts.capture !== false
    return new Promise((done) => {
      let out = ''
      let settled = false
      const finish = (code) => {
        if (settled) return
        settled = true
        done({ code, out })
      }
      let child
      try {
        child = spawn(cmd, args, {
          cwd: opts.cwd || root || process.cwd(),
          windowsHide: true,
          stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
        })
      } catch (e) {
        out += e.message
        return finish(-1)
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        out += `\n[timeout ${timeoutMs}ms]`
        finish(-2)
      }, timeoutMs)
      const add = (d) => { out += d.toString('utf8') }
      if (capture && child.stdout && child.stderr) {
        child.stdout.on('data', add)
        child.stderr.on('data', add)
      }
      child.on('error', (e) => { out += `\n${e.message}`; clearTimeout(timer); finish(-1) })
      child.on('close', (code) => { clearTimeout(timer); finish(code ?? -1) })
    })
  }

  async function probeBinary(exe, args) {
    if (!exe) return { ok: false, out: '未配置' }
    const looksLikePath = /[\\/]/.test(exe)
    if (looksLikePath && !isFile(exe)) return { ok: false, out: `文件不存在: ${exe}` }
    // 先不接管道地跑一次，只认退出码
    const quiet = await run(exe, args, { timeoutMs: 8000, capture: false })
    if (quiet.code === 0) return { ok: true, out: '' }
    if (quiet.code === -1 && /EPERM|EACCES|spawn/i.test(quiet.out)) {
      return { ok: false, out: `起不来子进程：${firstLine(quiet.out, 120)}` }
    }
    // 跑不起来：再带管道跑一次，把真正的报错捞回来给用户看
    const loud = await run(exe, args, { timeoutMs: 8000 })
    return { ok: loud.code === 0, out: loud.out || `退出码 ${quiet.code}` }
  }

  // 配置里给的可能是绝对路径、相对工作区的路径，或一个交给 PATH 的命令名。
  function resolveMaybeRel(p) {
    const s = pickStr(p)
    if (!s) return ''
    if (path.isAbsolute(s)) return s
    if (!/[\\/]/.test(s)) return s          // 命令名，交给 PATH
    return root ? path.resolve(root, s) : s
  }

  // ── 依赖探测：ffmpeg / python / MOSS / VLM ────────────────
  function pythonCandidates() {
    const explicit = pickStr(cfg.python, process.env.DSH_PERSPECTIVE_PYTHON,
      process.env.PERSPECTIVE_PYTHON)
    if (explicit) return [{ exe: resolveMaybeRel(explicit), explicit: true }]

    const out = []
    if (root) {
      for (const parts of PY_CANDIDATES) {
        const p = path.join(root, ...parts)
        if (isFile(p)) out.push({ exe: p })
      }
    }
    const onPath = whichOnPath(['python.exe', 'python3.exe', 'python', 'python3'])
    if (onPath) out.push({ exe: onPath })
    return out
  }

  async function findPython() {
    return cached('python', 30000, async () => {
      const cands = pythonCandidates()
      if (!cands.length) {
        return {
          ok: false, code: 'no-python',
          reason: '没有 python 环境（自动探测没找到解释器）',
          hint: '在 cordis.patch.yml 里设 config.python 指向 python.exe（要装好工具脚本的依赖）',
        }
      }
      let last = ''
      for (const c of cands) {
        const p = await probeBinary(c.exe, ['--version'])
        if (p.ok) return { ok: true, exe: c.exe, version: firstLine(p.out, 80) }
        last = firstLine(p.out, 160)
        if (c.explicit) {
          return {
            ok: false, code: 'bad-python', exe: c.exe,
            reason: `配置的 python 跑不起来：${last}`,
            hint: '检查 config.python 是否是有效解释器',
          }
        }
      }
      return {
        ok: false, code: 'no-python', reason: `有候选 python 但都跑不起来：${last}`,
        hint: '在 cordis.patch.yml 里设 config.python 指向 python.exe',
      }
    })
  }

  async function findFfmpeg() {
    return cached('ffmpeg', 60000, async () => {
      const explicit = pickStr(cfg.ffmpeg, process.env.DSH_PERSPECTIVE_FFMPEG, process.env.FFMPEG_PATH)
      const cands = []
      if (explicit) cands.push({ exe: resolveMaybeRel(explicit), explicit: true })
      else {
        const onPath = whichOnPath(['ffmpeg.exe', 'ffmpeg'])
        if (onPath) cands.push({ exe: onPath })
        for (const p of FFMPEG_COMMON) if (isFile(p)) cands.push({ exe: p })
      }
      for (const c of cands) {
        const p = await probeBinary(c.exe, ['-version'])
        if (p.ok) return { ok: true, exe: c.exe }
        if (c.explicit) {
          return {
            ok: false, code: 'bad-ffmpeg', exe: c.exe,
            reason: `配置的 ffmpeg 跑不起来：${firstLine(p.out, 120)}`,
            hint: '检查 config.ffmpeg',
          }
        }
      }
      return {
        ok: false, code: 'no-ffmpeg',
        reason: '没有 ffmpeg（自动探测没找到）',
        hint: '在 cordis.patch.yml 里设 config.ffmpeg 指向 ffmpeg.exe；不配也能用，只是 HEIC 转码和识图前的缩图不做',
      }
    })
  }

  const mossBase = (origin) => pickStr(mossCfg.url, cfg.mossUrl, process.env.DSH_PERSPECTIVE_MOSS_URL) || origin

  async function findMoss(origin) {
    const base = mossBase(origin)
    if (!base) {
      return {
        ok: false, code: 'no-moss',
        reason: '没有 MOSS 服务（没配置 config.moss.url，请求里也拿不到同源地址）',
        hint: '装 dsh-moss-studio（同源 /api/moss-studio）或在 cordis.patch.yml 里设 config.moss.url',
      }
    }
    return cached(`moss:${base}`, 8000, async () => {
      const stem = String(base).replace(/\/+$/, '')
      try {
        const r = await fetch(`${stem}/api/moss-studio/state`, {
          headers: { 'x-moss-studio': '1' },
          signal: AbortSignal.timeout(2000),
        })
        if (!r.ok) {
          return {
            ok: false, code: 'no-moss', base: stem,
            reason: `没有 MOSS：${stem}/api/moss-studio 返回 HTTP ${r.status}`,
            hint: '装 dsh-moss-studio（同源 /api/moss-studio）或在 cordis.patch.yml 里设 config.moss.url',
          }
        }
        return { ok: true, base: stem }
      } catch (e) {
        return {
          ok: false, code: 'no-moss', base: stem,
          reason: `连不上 MOSS：${stem}（${firstLine(e?.message || e, 120)}）`,
          hint: '装 dsh-moss-studio（同源 /api/moss-studio）或在 cordis.patch.yml 里设 config.moss.url',
        }
      }
    })
  }

  const vlmUrl = () => pickStr(vlmCfg.url, cfg.vlmUrl, process.env.VLM_URL,
    'http://127.0.0.1:11435/v1/chat/completions')
  const vlmModel = () => pickStr(vlmCfg.model, cfg.vlmModel, process.env.VLM_MODEL,
    'Qwen2.5-VL-3B-Instruct')

  function vlmHealth() {
    const explicit = pickStr(vlmCfg.health, cfg.vlmHealth, process.env.VLM_HEALTH)
    if (explicit) return explicit
    try {
      const u = new URL(vlmUrl())
      return `${u.origin}/health`
    } catch {
      return ''
    }
  }

  // 视觉服务的自启动：只有配了脚本才做，绝不猜本机路径
  function vlmBoot() {
    const scriptCfg = pickStr(vlmCfg.bootScript, cfg.vlmBootScript)
    const script = scriptCfg
      ? resolveMaybeRel(scriptCfg)
      : (root ? path.join(root, 'tools', 'vision', 'serve_vlm.py') : '')
    if (!script || !isFile(script)) {
      return {
        ok: false,
        why: `没有可用的自启动脚本（config.vlm.bootScript）`,
      }
    }
    const pyCfg = pickStr(vlmCfg.python, cfg.vlmPython, process.env.VLM_PY)
    const py = pyCfg
      ? resolveMaybeRel(pyCfg)
      : (root ? path.join(root, ...PY_CANDIDATES[0]) : '')
    if (!py || !isFile(py)) {
      return { ok: false, why: '起不了视觉服务：没有配置 config.vlm.python' }
    }
    return { ok: true, py, script }
  }

  async function findVlm() {
    const health = vlmHealth()
    if (!health) {
      return { ok: false, code: 'no-vlm', reason: '没有 VLM 地址（config.vlm.url）' }
    }
    return cached(`vlm:${health}`, 8000, async () => {
      try {
        const r = await fetch(health, { signal: AbortSignal.timeout(1500) })
        if (r.ok) return { ok: true, health, url: vlmUrl(), model: vlmModel() }
      } catch { /* 下面统一给原因 */ }
      const boot = vlmBoot()
      if (boot.ok) return { ok: true, health, url: vlmUrl(), model: vlmModel(), boot }
      return {
        ok: false, code: 'no-vlm', health, url: vlmUrl(),
        reason: `本地视觉服务没起来（${health}）`,
        hint: `${boot.why}；先在外部把 VLM 服务跑起来，或配置 config.vlm.bootScript + config.vlm.python`,
      }
    })
  }

  function toolScript(key, fallbackRel) {
    const configured = pickStr(toolsCfg[key], cfg[`${key}Script`])
    if (configured) return resolveMaybeRel(configured)
    return root ? path.join(root, ...fallbackRel.split('/')) : ''
  }

  const TOOL_FAILBACK = {
    intake: 'tools/intake_scene.py',
    makeChar: 'tools/make_char.py',
    fixEdges: 'tools/fix_edges.py',
  }

  function toolCapability(key, what) {
    const file = toolScript(key, TOOL_FAILBACK[key])
    if (!file || !isFile(file)) {
      return {
        ok: false, code: 'no-tool', file: file || '',
        reason: `找不到${what}脚本：${file || TOOL_FAILBACK[key]}`,
        hint: key === 'intake'
          ? '在 cordis.patch.yml 里设 config.tools.intake'
          : (key === 'makeChar' ? '在 cordis.patch.yml 里设 config.tools.makeChar' : '在 cordis.patch.yml 里设 config.tools.fixEdges'),
      }
    }
    return { ok: true, file }
  }

  async function capabilities(origin) {
    const [py, ff, moss, vlm] = await Promise.all([
      findPython(), findFfmpeg(), findMoss(origin), findVlm(),
    ])
    const intakeTool = toolCapability('intake', '入库')
    const makeTool = toolCapability('makeChar', '生成立绘')
    const edgeTool = toolCapability('fixEdges', '去白边')

    const needPy = (tool) => {
      if (!py.ok) return { ok: false, code: py.code || 'no-python', reason: py.reason, hint: py.hint }
      if (!tool.ok) return tool
      return { ok: true, python: py.exe, script: tool.file }
    }

    const vision = vlm.ok
      ? { ok: true, url: vlm.url, model: vlm.model }
      : { ok: false, code: vlm.code || 'no-vlm', reason: vlm.reason, hint: vlm.hint }

    const generate = (() => {
      if (!moss.ok) return { ok: false, code: 'no-moss', reason: moss.reason, hint: moss.hint }
      const pyCap = needPy(makeTool)
      if (!pyCap.ok) return pyCap
      return { ok: true, python: pyCap.python, script: pyCap.script, moss: moss.base }
    })()

    return {
      intake: needPy(intakeTool),
      decontam: needPy(edgeTool),
      vision,
      // 候选提示词本身是包内数据，但它只在「已经识图」之后才有意义；
      // 识图能力不在时一并报不可用，面板就不用去试了。
      prompts: vision.ok
        ? { ok: true }
        : { ok: false, code: vision.code, reason: `候选提示词需要识图：${vision.reason}`, hint: vision.hint },
      generate,
      found: {
        python: py.exe || '',
        ffmpeg: ff.exe || '',
        moss: moss.base || '',
        vlm: vlm.ok ? vlm.url : '',
        tools: {
          intake: intakeTool.file || '',
          makeChar: makeTool.file || '',
          fixEdges: edgeTool.file || '',
        },
      },
      ffmpeg: ff.ok ? { ok: true, exe: ff.exe } : { ok: false, code: ff.code, reason: ff.reason, hint: ff.hint },
    }
  }

  const CAP_HINT = {
    intake: '把一张实拍图丢进工作区并建场景，需要 python 和入库脚本',
    decontam: '一键去白边，需要 python 和处理脚本',
    vision: '识图判断场景，需要本地 VLM 服务',
    prompts: '候选提示词，需要识图结果',
    generate: '生成立绘，需要 MOSS + python 抠图脚本',
  }

  function missing(res, capability, cap) {
    return json(res, 404, {
      error: cap.reason || '这个能力不可用',
      code: cap.code || 'unavailable',
      capability,
      what: CAP_HINT[capability] || '',
      ...(cap.hint ? { hint: cap.hint } : {}),
    })
  }

  async function requireCap(res, caps, capability) {
    const cap = caps[capability]
    if (cap && cap.ok) return true
    missing(res, capability, cap || {})
    return false
  }

  // 运行期兜底：探测过了但 spawn 还是 ENOENT（配置被改、文件被删），
  // 这种情况也要回 404 + 原因，而不是 500。
  function spawnFailure(res, capability, result) {
    if (result.code === -1 && /ENOENT|not found|No such file/i.test(result.out)) {
      memo.delete('python')
      return json(res, 404, {
        error: `${capability} 依赖的解释器没了：${firstLine(result.out, 160)}`,
        code: 'no-python',
        capability,
        hint: '检查 config.python',
      })
    }
    if (result.code === -1 && /EPERM|EACCES|spawn/i.test(result.out)) {
      return json(res, 404, {
        error: `${capability} 起不了子进程：${firstLine(result.out, 160)}`,
        code: 'spawn-denied',
        capability,
        hint: '这个环境不允许插件起子进程（沙箱/杀软），或 config 里的可执行文件不可执行',
      })
    }
    return null
  }

  // ── 识图 ──────────────────────────────────────────────────
  const VISION_PROMPT = [
    '这是一张实拍照片，之后要把一个动漫人物立绘摆进这个场景。',
    '请你判断：人物站进去应该穿什么、什么季节、什么光线。',
    '只输出一个 JSON，不要解释、不要代码块：',
    '{"scene_type":"indoor 或 outdoor","season":"spring|summer|autumn|winter|unknown",',
    ' "light":"cold|warm|neutral","keywords":["最多5个英文短词，描述场景物件/环境"],',
    ' "summary":"一句中文说明这是什么场景"}',
  ].join('\n')

  function extractJson(text) {
    const s = String(text || '')
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    try {
      return JSON.parse(s.slice(a, b + 1))
    } catch {
      return null
    }
  }

  let vlmBooting = null

  async function vlmUp(timeoutMs = 2500) {
    const health = vlmHealth()
    if (!health) return false
    try {
      const r = await fetch(health, { signal: AbortSignal.timeout(timeoutMs) })
      return r.ok
    } catch {
      return false
    }
  }

  // 本地视觉服务空闲 300 秒会自己退出（省显存），所以每次识图前先探一下，
  // 没起就当场拉起来。没配自启动脚本时直接回 404 说清楚，让面板别报 500。
  async function ensureVlm(vlm, waitMs = 150000) {
    if (await vlmUp()) return { ok: true, booted: false }
    const boot = vlm.boot || vlmBoot()
    if (!boot.ok) return { ok: false, error: boot.why, capability: 'vision' }
    if (!vlmBooting) {
      const startedAt = Date.now()
      vlmBooting = (async () => {
        let fd = 'ignore'
        if (root) {
          const logPath = path.join(root, 'tools', 'vision', 'vlm.log')
          try { fd = openSync(logPath, 'a') } catch { /* 日志开不了也不影响起服务 */ }
        }
        try {
          const child = spawn(boot.py, [boot.script], {
            cwd: root || process.cwd(),
            detached: true,
            windowsHide: true,
            stdio: ['ignore', fd, fd],
          })
          child.unref()
        } catch (e) {
          return { ok: false, error: `起不来：${e.message}`, capability: 'vision' }
        }
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000))
          if (await vlmUp(1500)) {
            return { ok: true, booted: true, seconds: Math.round((Date.now() - startedAt) / 1000) }
          }
        }
        return { ok: false, error: `等了 ${Math.round(waitMs / 1000)} 秒还没就绪`, capability: 'vision' }
      })()
      vlmBooting.finally(() => { vlmBooting = null })
    }
    return vlmBooting
  }

  async function callVision(dataUrl) {
    const vlm = await findVlm()
    if (!vlm.ok) throw Object.assign(new Error(vlm.reason), { code: vlm.code })
    const started = await ensureVlm(vlm)
    if (!started.ok) {
      throw Object.assign(new Error(`本地视觉服务起不来：${started.error}`), { code: 'no-vlm' })
    }
    const url = vlm.url
    const body = {
      model: vlm.model || vlmModel(),
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: VISION_PROMPT },
        ],
      }],
      temperature: 0.2,
    }
    let r
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(240000),
      })
    } catch (e) {
      throw Object.assign(new Error(`连不上本地视觉服务（${url}）：${e.message || ''}`), { code: 'no-vlm' })
    }
    const text = await r.text()
    if (!r.ok) throw new Error(`识图失败 HTTP ${r.status}: ${text.slice(0, 300)}`)
    const parsed = JSON.parse(text)
    const content = parsed?.choices?.[0]?.message?.content
    const out = Array.isArray(content)
      ? content.map((c) => c.text || '').join('')
      : String(content || '')
    const vision = extractJson(out)
    if (!vision) throw new Error(`识图结果不是 JSON: ${out.slice(0, 300)}`)
    return {
      vision,
      raw: out.slice(0, 1200),
      engine: 'local',
      booted: started.booted,
      bootSeconds: started.booted ? started.seconds : 0,
    }
  }

  // ── 候选 prompt：按识图结果从模板库挑 ───────────────────
  function loadPrompts() {
    const file = path.join(HERE_DIR, 'prompts.json')
    return JSON.parse(readFileSync(file, 'utf8'))
  }

  function matchGroup(lib, vision) {
    const season = String(vision.season || '').toLowerCase()
    const type = String(vision.scene_type || '').toLowerCase()
    const kw = (vision.keywords || []).join(' ').toLowerCase()
    let best = null
    for (const [key, group] of Object.entries(lib.outfits || {})) {
      const m = group.match || {}
      let hits = 0
      if (m.season && m.season.includes(season)) hits += 2
      if (m.scene_type && m.scene_type.includes(type)) hits += 2
      if (m.keywords && m.keywords.some((k) => kw.includes(String(k).toLowerCase()))) hits += 3
      if (hits > 0 && (!best || hits > best.hits)) best = { key, group, hits }
    }
    return best ? best.group : lib.fallback
  }

  function buildCandidates(lib, vision, opts = {}) {
    const offset = Number(opts.offset) || 0
    const shotIdx = Number.isInteger(opts.shot) ? opts.shot : 0
    const poseIdx = Number.isInteger(opts.pose) ? opts.pose : -1   // -1 = 自动轮换

    const group = matchGroup(lib, vision)
    const variants = (group.variants || []).slice(0, 4)
    const poses = Array.isArray(lib.poses) && lib.poses.length
      ? lib.poses
      : [{ label: '正面', pose: 'standing, straight posture, facing camera' }]
    const shots = Array.isArray(lib.shots) && lib.shots.length
      ? lib.shots
      : [{ label: '全身', shot: 'full body character',
           framing: 'full body visible from head to toe' }]

    const shot = shots[Math.min(Math.max(shotIdx, 0), shots.length - 1)]
    // outfit 循环用；姿态：指定了就用指定的，没指定就按 offset 平移轮换
    const n = Math.max(variants.length, 3)
    const out = []
    for (let i = 0; i < n; i += 1) {
      const v = variants[i % Math.max(variants.length, 1)] || { outfit: '', extra: '' }
      const p = poseIdx >= 0 && poseIdx < poses.length
        ? poses[poseIdx]
        : poses[(((i + offset) % poses.length) + poses.length) % poses.length]
      out.push({
        id: `${group.label || 'c'}-${i + 1}`,
        label: `${group.label || ''} · ${shot.label} · ${p.label || ''} · ${i + 1}`,
        shot: shot.label,
        pose: p.label,
        prompt: String(lib.base)
          .replace('{shot}', shot.shot || '')
          .replace('{framing}', shot.framing || '')
          .replace('{pose}', p.pose || '')
          .replace('{outfit}', v.outfit || '')
          .replace('{extra}', v.extra || ''),
      })
    }
    return out
  }

  // ── MOSS 生成：走同源 /api/moss-studio ──────────────────
  async function mossGenerate(origin, prompt, width, height) {
    const base = mossBase(origin)
    if (!base) throw Object.assign(new Error('没有 MOSS 服务地址'), { code: 'no-moss' })
    const hdr = { 'content-type': 'application/json', 'x-moss-studio': '1' }
    const gen = await fetch(`${base}/api/moss-studio/generate`, {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ prompt, width, height }),
      signal: AbortSignal.timeout(30000),
    })
    const genData = await gen.json()
    if (genData.error) throw new Error(`MOSS 提交失败: ${genData.error}`)
    const ids = genData.ids || []
    if (!ids.length) throw new Error('MOSS 没返回任务 id')

    const deadline = Date.now() + 300000
    let job = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      const st = await fetch(`${base}/api/moss-studio/state`, {
        headers: { 'x-moss-studio': '1' },
        signal: AbortSignal.timeout(15000),
      }).then((r) => r.json()).catch(() => null)
      if (!st || !st.state) continue
      const jobs = (st.state.jobs || []).filter((j) => ids.includes(j.id))
      const pending = jobs.filter((j) => !['done', 'error', 'cancelled'].includes(j.state))
      if (!pending.length && jobs.length === ids.length) { job = jobs[0]; break }
    }
    if (!job) throw new Error('等 MOSS 超时（300s）')
    if (job.state !== 'done' || !job.output) {
      throw new Error(`MOSS 任务没成功：state=${job.state}`)
    }
    const img = await fetch(
      `${base}/api/moss-studio/image/${encodeURIComponent(job.output)}`,
      { headers: { 'x-moss-studio': '1' }, signal: AbortSignal.timeout(60000) })
    if (!img.ok) throw new Error(`取图失败 HTTP ${img.status}`)
    return {
      bytes: Buffer.from(await img.arrayBuffer()),
      name: job.output,
      seed: job.seed,
      width: job.width,
      height: job.height,
    }
  }

  const originOf = (req) => `http://${req.headers.host || '127.0.0.1'}`

  // ── 路由 ───────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    async handler(req, res) {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const route = url.pathname.slice(ROUTE.length) || '/'
      const origin = originOf(req)
      try {
        if (req.method === 'GET' && (route === '/' || route === '/scenes')) {
          const scenes = listScenes().map((name) => {
            let cfg = {}
            try { cfg = parseYaml(readFileSync(scenePath(name), 'utf8')) } catch { /* ignore */ }
            const photo = cfg.PHOTO || null
            const char = cfg.CHAR || null
            return {
              name,
              confirmed: cfg.CONFIRMED === true,
              photo,
              photoOk: Boolean(root && photo && isInside(root, resolveRel(photo))
                && existsSync(resolveRel(photo))),
              char,
              charOk: Boolean(root && char && isInside(root, resolveRel(char))
                && existsSync(resolveRel(char))),
            }
          })
          const out = {
            workspace: root,
            workspaceSource: detected.source,
            sceneDir: sceneDirCfg,
            scenes,
          }
          if (!root) {
            out.hint = '没找到工作区：在 cordis.patch.yml 里给这个插件设 config.workspace（放 scenes/ 和素材的目录）'
          } else if (!sceneDir || !existsSync(sceneDir)) {
            out.hint = `工作区里还没有 ${sceneDirCfg}/ 目录：放几个 <name>.yaml 进去就有场景了`
          }
          return json(res, 200, out)
        }

        if (req.method === 'GET' && route === '/capabilities') {
          const caps = await capabilities(origin)
          return json(res, 200, {
            workspace: root,
            workspaceSource: detected.source,
            sceneDir: sceneDirCfg,
            dirs: { photos: photosDirCfg, chars: charsDirCfg },
            capabilities: {
              intake: caps.intake,
              decontam: caps.decontam,
              vision: caps.vision,
              prompts: caps.prompts,
              generate: caps.generate,
              ffmpeg: caps.ffmpeg,
            },
            found: caps.found,
            ...(root ? {} : { hint: '没找到工作区：在 cordis.patch.yml 里设 config.workspace' }),
          })
        }

        if (req.method === 'GET' && route === '/assets') {
          return json(res, 200, {
            photos: listDir(photosDir, photosDirCfg, ['.jpg', '.jpeg', '.png']),
            chars: listDir(charsDir, charsDirCfg, ['.png', '.webp']),
            photosDir: photosDirCfg,
            charsDir: charsDirCfg,
            ...(root ? {} : { hint: '没找到工作区：在 cordis.patch.yml 里设 config.workspace' }),
          })
        }

        if (req.method === 'GET' && route === '/scene') {
          const scene = url.searchParams.get('name') || ''
          if (!/^[\w.-]+$/.test(scene)) return json(res, 400, { error: 'bad scene name' })
          const { cfg: sceneCfg } = await readScene(scene)
          return json(res, 200, { name: scene, cfg: sceneCfg })
        }

        if (req.method === 'GET' && route === '/image') {
          const own = url.searchParams.get('path')
          if (own) return await sendImage(res, toPosix(own))
          const scene = url.searchParams.get('name') || ''
          const kind = url.searchParams.get('kind') || 'photo'
          if (!/^[\w.-]+$/.test(scene)) return json(res, 400, { error: 'bad scene name' })
          const { cfg: sceneCfg } = await readScene(scene)
          return await sendImage(res, kind === 'char' ? sceneCfg.CHAR : sceneCfg.PHOTO)
        }

        if (req.method === 'POST' && route === '/upload') {
          if (!root || !photosDir) {
            return json(res, 404, {
              error: '还没找到工作区，没地方存上传的图',
              code: 'no-workspace',
              hint: '在 cordis.patch.yml 里设 config.workspace',
            })
          }
          const body = await readBody(req)
          const dataUrl = String(body.data || '')
          const m = dataUrl.match(/^data:image\/([a-z0-9+.-]+);base64,(.+)$/i)
          if (!m) return json(res, 400, { error: '不是图片 dataURL（拖进来的是文件还是图片？）' })
          const rawExt = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()
          const stem = String(body.name || 'photo')
            .replace(/\.[^.]+$/, '')
            .replace(/[^\w\u4e00-\u9fa5-]/g, '_')
            .slice(0, 40) || 'photo'
          const bytes = Buffer.from(m[2], 'base64')
          const dir = photosDir
          await mkdir(dir, { recursive: true })

          // iPhone 直出是 HEIC，浏览器读出来就是 image/heic；用 ffmpeg 转一份 jpg
          if (['heic', 'heif'].includes(rawExt)) {
            const ff = await findFfmpeg()
            if (!ff.ok) {
              return json(res, 404, {
                error: `HEIC 要 ffmpeg 才能转：${ff.reason}`,
                code: ff.code || 'no-ffmpeg',
                capability: 'ffmpeg',
                hint: ff.hint,
              })
            }
            const stamp = Date.now()
            const tmpIn = path.join(dir, `_up-${stamp}.${rawExt}`)
            const tmpOut = path.join(dir, `_up-${stamp}.jpg`)
            await writeFile(tmpIn, bytes)
            const r = await run(ff.exe, ['-y', '-hide_banner', '-loglevel', 'error', '-i', tmpIn,
              '-frames:v', '1', '-q:v', '2', tmpOut], { timeoutMs: 120000 })
            let jpg = null
            try { jpg = await readFile(tmpOut) } catch { /* 下面报错 */ }
            for (const f of [tmpIn, tmpOut]) { try { await unlink(f) } catch { /* ignore */ } }
            if (!jpg || r.code !== 0) {
              return json(res, 500, { error: `HEIC 转换失败：${r.out.slice(-300)}` })
            }
            const fileName = `${stem}.jpg`
            const rel = `${photosDirCfg}/${fileName}`
            await writeFile(path.join(dir, fileName), jpg)
            return json(res, 200, {
              path: rel, name: fileName, size: jpg.length, convertedFrom: rawExt,
            })
          }

          if (!['jpg', 'png', 'webp'].includes(rawExt)) {
            return json(res, 400, {
              error: `不支持 ${rawExt}，只能 jpg / png / webp / heic`,
            })
          }
          const fileName = `${stem}.${rawExt}`
          const rel = `${photosDirCfg}/${fileName}`
          await writeFile(path.join(dir, fileName), bytes)
          return json(res, 200, { path: rel, name: fileName, size: bytes.length })
        }

        if (req.method === 'POST' && route === '/intake') {
          const caps = await capabilities(origin)
          if (!(await requireCap(res, caps, 'intake'))) return
          const body = await readBody(req)
          const photo = toPosix(String(body.photo || ''))
          const photoAbs = path.resolve(root, photo)
          if (!photosDir || !isInside(photosDir, photoAbs) || photo.includes('..')) {
            return json(res, 400, { error: `photo 必须是 ${photosDirCfg}/ 下的文件` })
          }
          let sceneName = String(body.name || '').replace(/\.[^.]+$/, '').replace(/[^\w.-]/g, '-')
          if (!sceneName) {
            sceneName = path.basename(photo).replace(/\.[^.]+$/, '').replace(/[^\w.-]/g, '-')
          }
          if (existsSync(scenePath(sceneName)) && !body.force) {
            return json(res, 409, { error: `场景 ${sceneName} 已存在`, name: sceneName })
          }
          const started = Date.now()
          const result = await run(caps.intake.python,
            [caps.intake.script, photo, '--name', sceneName],
            { timeoutMs: 240000 })
          const seconds = ((Date.now() - started) / 1000).toFixed(1)
          if (result.code !== 0) {
            const noDep = spawnFailure(res, 'intake', result)
            if (noDep) return noDep
            return json(res, 500, {
              error: `入库失败（exit ${result.code}）`, log: result.out.slice(-3000), seconds,
            })
          }
          return json(res, 200, { name: sceneName, seconds, log: result.out.slice(-3000) })
        }

        if (req.method === 'POST' && route === '/vision') {
          const caps = await capabilities(origin)
          if (!(await requireCap(res, caps, 'vision'))) return
          const body = await readBody(req)
          const scene = String(body.scene || '')
          if (!/^[\w.-]+$/.test(scene)) return json(res, 400, { error: 'bad scene name' })
          const { cfg: sceneCfg } = await readScene(scene)
          const photo = sceneCfg.PHOTO
          if (!photo || !existsSync(resolveRel(photo))) {
            return json(res, 400, { error: `底图不存在: ${photo}` })
          }
          // 识图只需要看个大概场景，原图 1200x1600 直接送进去要 49 秒。
          // 先缩到 768 宽，模型处理量掉一个数量级；没有 ffmpeg 就送原图。
          const absPhoto = resolveRel(photo)
          let bytes = null
          let mime = 'image/jpeg'
          const ff = await findFfmpeg()
          if (ff.ok) {
            const tmpSmall = path.join(root, `_tmp_vision_${process.pid}.jpg`)
            const shrink = await run(ff.exe,
              ['-y', '-hide_banner', '-loglevel', 'error', '-i', absPhoto,
                '-vf', 'scale=768:-2', '-frames:v', '1', '-q:v', '3', tmpSmall], { timeoutMs: 60000 })
            if (shrink.code === 0 && existsSync(tmpSmall)) {
              bytes = await readFile(tmpSmall)
              try { await unlink(tmpSmall) } catch { /* ignore */ }
            }
          }
          if (!bytes) {
            bytes = await readFile(absPhoto)
            mime = MIME[path.extname(photo).toLowerCase()] || 'image/jpeg'
          }
          const t0 = Date.now()
          let result
          try {
            result = await callVision(`data:${mime};base64,${bytes.toString('base64')}`)
          } catch (e) {
            if (e?.code === 'no-vlm') return missing(res, 'vision', { reason: e.message, code: 'no-vlm' })
            throw e
          }
          return json(res, 200, {
            scene, ...result, seconds: ((Date.now() - t0) / 1000).toFixed(1),
          })
        }

        if (req.method === 'POST' && route === '/prompts') {
          const caps = await capabilities(origin)
          if (!(await requireCap(res, caps, 'prompts'))) return
          const body = await readBody(req)
          const lib = loadPrompts()
          const vision = body.vision && typeof body.vision === 'object' ? body.vision : {}
          const opts = {
            offset: Number(body.offset) || 0,
            shot: Number.isInteger(body.shot) ? body.shot : 0,
            pose: Number.isInteger(body.pose) ? body.pose : -1,
          }
          return json(res, 200, {
            vision, opts,
            shots: (lib.shots || []).map((s) => s.label),
            poses: (lib.poses || []).map((s) => s.label),
            candidates: buildCandidates(lib, vision, opts),
          })
        }

        if (req.method === 'POST' && route === '/generate') {
          const caps = await capabilities(origin)
          if (!(await requireCap(res, caps, 'generate'))) return
          const body = await readBody(req)
          const scene = String(body.scene || '')
          const prompt = String(body.prompt || '').trim()
          if (!prompt) return json(res, 400, { error: 'prompt 为空' })
          const width = Number(body.width) || 768
          const height = Number(body.height) || 1024
          const t0 = Date.now()
          const img = await mossGenerate(origin, prompt, width, height)

          const dir = charsDir
          await mkdir(dir, { recursive: true })
          const stamp = Date.now()
          const tmpSrc = path.join(dir, `_gen-${stamp}.png`)
          await writeFile(tmpSrc, img.bytes)

          const stem = String(body.name || `char-${scene}-${stamp}`)
            .replace(/[^\w\u4e00-\u9fa5-]/g, '-').slice(0, 48)
          const outRel = `${charsDirCfg}/${stem}.png`
          const minSim = Number(body.minSim) || 0.60
          const r = await run(caps.generate.python,
            [caps.generate.script, path.relative(root, tmpSrc), '--out', outRel,
              '--min-sim', String(minSim)],
            { timeoutMs: 300000 })
          try { await unlink(tmpSrc) } catch { /* ignore */ }
          const seconds = ((Date.now() - t0) / 1000).toFixed(1)
          if (r.code !== 0) {
            const noDep = spawnFailure(res, 'generate', r)
            if (noDep) return noDep
            return json(res, 422, {
              ok: false, scene, seconds, why: '不像 Becky 或抠图失败',
              log: r.out.slice(-2500), generated: img.name,
            })
          }
          return json(res, 200, {
            ok: true, scene, path: outRel, seconds,
            log: r.out.slice(-1500), generated: img.name,
          })
        }

        if (req.method === 'POST' && route === '/save') {
          const body = await readBody(req)
          const scene = String(body.scene || '')
          if (!/^[\w.-]+$/.test(scene)) return json(res, 400, { error: 'bad scene name' })
          const values = body.values && typeof body.values === 'object' ? body.values : {}
          const { file, text } = await readScene(scene)
          const saved = saveYaml(text, values)
          await writeFile(file, saved.text.endsWith('\n') ? saved.text : saved.text + '\n', 'utf8')
          return json(res, 200, {
            scene,
            changed: saved.changed,
            added: saved.added,
            path: toPosix(path.relative(root, file)),
          })
        }

        if (req.method === 'POST' && route === '/delete') {
          const body = await readBody(req)
          const rel = toPosix(String(body.path || ''))
          const abs = root ? path.resolve(root, rel) : ''
          if (!root || !charsDir || !isInside(charsDir, abs) || rel.includes('..')
            || !/\.(png|jpg|jpeg|webp)$/i.test(rel)) {
            return json(res, 400, { error: `只能删 ${charsDirCfg}/ 下的图片` })
          }
          const base = path.basename(rel)
          if (protectedChars.includes(base)) {
            return json(res, 403, { error: `${base} 是 config.protectedChars 里的基准图，不能删` })
          }
          if (!existsSync(abs)) return json(res, 404, { error: '文件不存在' })
          // 删之前先看哪些场景还指着它，删完要把结果告诉人
          const usedBy = listScenes().filter((n) => {
            try { return parseYaml(readFileSync(scenePath(n), 'utf8')).CHAR === rel } catch { return false }
          })
          await unlink(abs)
          return json(res, 200, { deleted: rel, usedBy })
        }

        if (req.method === 'POST' && route === '/decontam') {
          const caps = await capabilities(origin)
          if (!(await requireCap(res, caps, 'decontam'))) return
          const body = await readBody(req)
          const rel = toPosix(String(body.path || ''))
          const abs = path.resolve(root, rel)
          if (!charsDir || !isInside(charsDir, abs) || rel.includes('..')
            || !/\.(png|jpg|jpeg|webp)$/i.test(rel)) {
            return json(res, 400, { error: `只能处理 ${charsDirCfg}/ 下的图片` })
          }
          if (!existsSync(abs)) return json(res, 404, { error: '文件不存在' })
          const p = path.parse(rel)
          const outRel = `${p.dir}/${p.name}-去白边.png`
          const t0 = Date.now()
          const args = [caps.decontam.script, rel, '--out', outRel]
          if (body.bg !== undefined) args.push('--bg', String(body.bg))
          if (body.band !== undefined) args.push('--band', String(body.band))
          if (body.forceMatte === true) args.push('--force-matte')
          const r = await run(caps.decontam.python, args, { timeoutMs: 300000 })
          const seconds = ((Date.now() - t0) / 1000).toFixed(1)
          if (r.code !== 0) {
            const noDep = spawnFailure(res, 'decontam', r)
            if (noDep) return noDep
            return json(res, 500, { ok: false, seconds, log: r.out.slice(-2000) })
          }
          return json(res, 200, {
            ok: true, source: rel, path: outRel, seconds, log: r.out.slice(-1200),
          })
        }

        return json(res, 404, { error: `unknown route ${route}` })
      } catch (error) {
        // 工作区没配 → 404 说清楚，别让面板以为服务坏了
        const msg = error?.message || String(error)
        if (/还没找到工作区/.test(msg)) {
          return json(res, 404, { error: msg, code: 'no-workspace' })
        }
        return json(res, 500, { error: msg })
      }
    },
  }), 'perspective.route')
}
