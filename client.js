// Perspective placement panel for the DeepSeek Harness Web UI.
//
// Client half of the dsh-perspective bundle. Registers a sidebar icon and a
// main-column panel: pick a scene, drag six sliders, watch the character land
// on the photo's ground plane, then save the numbers back into the scene yaml.
//
// All preview rendering happens here in a canvas — the projection math is a
// direct port of tools/arproject.py, so dragging is instant. The host half
// (/api/perspective) only serves scene yaml and image bytes, and takes the save.
window.__ModuleLoader__.load({
  id: 'dsh-perspective',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const VERSION = 'v0.1.0'
    const PANEL_ID = 'perspective'
    const NS = 'perspective'
    const API = '/api/perspective'

    const ZH = {
      panel: '透视对位',
      title: '透视对位',
      subtitle: '拖滑块定站位，保存写回场景 yaml',
      scene: '场景',
      char: '立绘',
      noScenes: 'scenes/ 里还没有场景',
      noChars: '素材/角色 里没有立绘',
      loading: '加载中…',
      photoMissing: '底图文件不存在',
      charMissing: '这个场景没有立绘（CHAR 被注释或指向不存在的文件）',
      dropHint: '点这里选照片，或拖进来 · 自动出深度、建场景',
      dropNow: '松手入库',
      intaking: '入库中：缩放 + Depth Pro 出深度…',
      visionTitle: '立绘工坊',
      visionHint: '先识图看这底图是什么场景，再从候选里挑一条提示词',
      visionLocal: '本地识图',
      visionCloud: '云识图',
      visionBusy: '识图中…',
      candidates: '候选提示词',
      shuffle: '换一批姿态',
      poseAuto: '姿势：自动',
      intakeOk: '入库完成',
      noVision: '还没识图',
      generate: '生成立绘',
      generating: '生成中…（约 90 秒：出图 50s + 抠图 40s）',
      genDone: '立绘生成好了',
      genFailed: '生成失败',
      promptEdit: '可以改，改完再生成',
      needVision: '先识图出候选，也可以直接在这里写提示词',
      deleteChar: '删立绘',
      deleteArm: '再点一次确认删除',
      edge: '去白边',
      edgeBusy: '处理中…',
      grid: '地面透视网格',
      confirmed: '参数已确认（解锁 render 定稿）',
      save: '保存并写回 yaml',
      saving: '保存中…',
      saved: '已写回',
      reset: '重置为 yaml 里的值',
      pitch: '俯角 °',
      dist: '距离 m',
      xpos: '横向 m',
      scale: '大小微调',
      camh: '相机高 m',
      feq: '焦距 mm',
      px: '像素高',
      foot: '脚底 v',
      head: '头顶 v',
      horizon: '地平线 v',
      notConfirmed: '未确认 · render --final 会被拒',
      isConfirmed: '已确认 · 可以出定稿',
      noChange: '参数没变',
      capsOff: '本机没配：',
      capsTitle: '本机能力',
      wsNone: '没找到工作区',
      wsHint: '在 cordis.patch.yml 里给这个插件设 config.workspace',
    }
    const EN = {
      panel: 'Perspective',
      title: 'Perspective Placement',
      subtitle: 'Drag the sliders, save back into the scene yaml',
      scene: 'Scene',
      char: 'Character',
      noScenes: 'No scenes yet',
      noChars: 'No character art in 素材/角色',
      loading: 'Loading…',
      photoMissing: 'Photo file missing',
      charMissing: 'No character art in this scene',
      dropHint: 'Click to pick a photo, or drop one here',
      dropNow: 'Release to import',
      intaking: 'Importing: resize + Depth Pro…',
      visionTitle: 'Character workshop',
      visionHint: 'Read the photo first, then pick a prompt that fits it',
      visionLocal: 'Local vision',
      visionCloud: 'Cloud vision',
      visionBusy: 'Reading photo…',
      candidates: 'Candidate prompts',
      shuffle: 'More poses',
      poseAuto: 'Pose: auto',
      intakeOk: 'Imported',
      noVision: 'Not read yet',
      generate: 'Generate character',
      generating: 'Generating… (~90s: 50s render + 40s matte)',
      genDone: 'Character ready',
      genFailed: 'Generation failed',
      promptEdit: 'Editable before generating',
      needVision: 'Read the photo first, or type a prompt here',
      deleteChar: 'Delete',
      deleteArm: 'Click again to confirm',
      edge: 'Decontam edges',
      edgeBusy: 'Working…',
      grid: 'Ground grid',
      confirmed: 'Parameters confirmed (unlocks render --final)',
      save: 'Save to yaml',
      saving: 'Saving…',
      saved: 'Written',
      reset: 'Reset from yaml',
      pitch: 'Pitch °',
      dist: 'Distance m',
      xpos: 'Lateral m',
      scale: 'Size tweak',
      camh: 'Camera height',
      feq: 'Focal mm',
      px: 'Height px',
      foot: 'Foot v',
      head: 'Head v',
      horizon: 'Horizon v',
      notConfirmed: 'Not confirmed · render --final refuses',
      isConfirmed: 'Confirmed · ready to finalize',
      noChange: 'No change',
      capsOff: 'Not available here: ',
      capsTitle: 'Local capabilities',
      wsNone: 'No workspace found',
      wsHint: 'Set config.workspace for this plugin in cordis.patch.yml',
    }

    // ── 投影数学（tools/arproject.py 的直译）───────────────
    const K_LONG = 0.8 * 43.266 / 2
    const K_SHORT = 0.6 * 43.266 / 2

    function focalPx(W, H, feq) {
      const L = Math.max(W, H)
      const S = Math.min(W, H)
      return L / S >= 4 / 3 ? (L / 2) * feq / K_LONG : (S / 2) * feq / K_SHORT
    }

    function project(x, y, d, W, H, camH, pitchDeg, feq) {
      const p = (pitchDeg * Math.PI) / 180
      const Zc = -y * Math.sin(p) + d * Math.cos(p)
      const Yc = -y * Math.cos(p) - d * Math.sin(p)
      if (Zc <= 0.05) return null
      const F = focalPx(W, H, feq)
      return [W / 2 + (F * x) / Zc, H / 2 + (F * Yc) / Zc]
    }

    function placeAt(W, H, camH, pitch, feq, x, d, height) {
      const foot = project(x, -camH, d, W, H, camH, pitch, feq)
      const head = project(x, height - camH, d, W, H, camH, pitch, feq)
      if (!foot || !head) return null
      return { foot, head, pxHeight: Math.hypot(head[0] - foot[0], head[1] - foot[1]) }
    }

    function horizonV(W, H, camH, pitch, feq) {
      return H / 2 - focalPx(W, H, feq) * Math.tan((pitch * Math.PI) / 180)
    }

    // 反向：给她一个像素落点 (u, v)，解出她站在世界里的 (x 横向, d 距离)。
    // 拖动时用这个，比让用户转两个滑块直观。
    function solveGround(u, v, W, H, camH, pitchDeg, feq) {
      const F = focalPx(W, H, feq)
      if (!F) return null
      const ku = (u - W / 2) / F
      const kv = (v - H / 2) / F
      const p = (pitchDeg * Math.PI) / 180
      const sp = Math.sin(p)
      const cp = Math.cos(p)
      const den = kv * cp + sp
      if (Math.abs(den) < 1e-6) return null
      const d = (camH * (cp - kv * sp)) / den
      if (!Number.isFinite(d) || d < 0.2 || d > 200) return null
      const zc = camH * sp + d * cp
      if (zc <= 0.05) return null
      return { x: ku * zc, d }
    }

    const GRID_COLOR = 'rgba(170,240,255,0.45)'
    const GRID_X_HALF = 5
    const GRID_D_MAX = 60

    function drawGrid(g, W, H, p) {
      g.save()
      g.strokeStyle = GRID_COLOR
      g.lineWidth = 2
      let prevV = null
      for (let d = 1; d <= GRID_D_MAX; d += 1) {
        const a = project(-200, -p.camH, d, W, H, p.camH, p.pitch, p.feq)
        const b = project(200, -p.camH, d, W, H, p.camH, p.pitch, p.feq)
        if (!a || !b) continue
        const v = a[1]
        if (v > H) continue
        if (v < 0) break
        if (prevV !== null && Math.abs(v - prevV) < 5) break
        prevV = v
        g.beginPath()
        g.moveTo(0, v)
        g.lineTo(W, v)
        g.stroke()
      }
      const ratio = Math.pow(4000 / 0.4, 1 / 59)
      for (let x = -GRID_X_HALF; x <= GRID_X_HALF; x += 1) {
        g.beginPath()
        let started = false
        for (let i = 0; i < 60; i += 1) {
          const d = 0.4 * Math.pow(ratio, i)
          const pt = project(x, -p.camH, d, W, H, p.camH, p.pitch, p.feq)
          if (!pt) continue
          if (!started) { g.moveTo(pt[0], pt[1]); started = true } else { g.lineTo(pt[0], pt[1]) }
        }
        g.stroke()
      }
      g.restore()
    }

    // ── 滑块定义 ───────────────────────────────────────────
    const SLIDERS = [
      { key: 'pitch', labelKey: 'pitch', min: -20, max: 45, step: 0.1, digits: 2 },
      { key: 'dist', labelKey: 'dist', min: 0.3, max: 12, step: 0.05, digits: 2 },
      { key: 'xpos', labelKey: 'xpos', min: -5, max: 5, step: 0.02, digits: 2 },
      { key: 'scale', labelKey: 'scale', min: 0.7, max: 1.4, step: 0.01, digits: 3 },
      { key: 'camH', labelKey: 'camh', min: 0.8, max: 2.6, step: 0.01, digits: 2 },
      { key: 'feq', labelKey: 'feq', min: 15, max: 60, step: 0.1, digits: 1 },
    ]

    const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

    function paramsFromCfg(cfg) {
      return {
        pitch: num(cfg.PITCH_DEG, 0),
        dist: num(cfg.CHAR_D, 3),
        xpos: num(cfg.CHAR_X, 0),
        scale: num(cfg.SCALE_TWEAK, 1),
        camH: num(cfg.CAM_H, 1.8),
        feq: num(cfg.FEQ, 24),
        crop: num(cfg.CHAR_CROP, 1),
      }
    }

    // 立绘覆盖到人物哪个位置（和 prompts.json 的 shots 对应）
    const CROPS = [
      { label: '全身', value: 1.0 },
      { label: '膝上', value: 0.72 },
      { label: '半身', value: 0.55 },
      { label: '胸上', value: 0.35 },
    ]

    // ── 侧边栏图标 ─────────────────────────────────────────
    function Glyph() {
      return h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' },
      h('path', { d: 'M2 8h20' }),
      h('path', { d: 'M12 8v12' }),
      h('path', { d: 'M5 20l3-12' }),
      h('path', { d: 'M19 20l-3-12' }),
      h('circle', { cx: 12, cy: 15, r: 1.4 }))
    }

    // ── 面板 ───────────────────────────────────────────────
    function Page(props) {
      const t = props.t || ((k) => k)
      const [scenes, setScenes] = useState([])
      const [scene, setScene] = useState('')
      const [cfg, setCfg] = useState({})
      const [params, setParams] = useState(paramsFromCfg({}))
      const [grid, setGrid] = useState(true)
      const [confirmed, setConfirmed] = useState(false)
      const [imgVer, setImgVer] = useState(0)
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)
      const [assets, setAssets] = useState({ photos: [], chars: [] })
      const [caps, setCaps] = useState(null)      // 本机能力探测结果，null = 还没问到
      const [wsHint, setWsHint] = useState('')    // 工作区没找到时的提示
      const [charPath, setCharPath] = useState('')
      const [dragOver, setDragOver] = useState(false)
      const [intaking, setIntaking] = useState(false)
      const [vision, setVision] = useState(null)
      const [visionBusy, setVisionBusy] = useState(false)
      const [candidates, setCandidates] = useState([])
      const [picked, setPicked] = useState('')
      const [genBusy, setGenBusy] = useState(false)
      const [genLog, setGenLog] = useState('')
      const [delArmed, setDelArmed] = useState(false)
      const [edgeBusy, setEdgeBusy] = useState(false)
      const [poseOffset, setPoseOffset] = useState(0)
      const [shotIdx, setShotIdx] = useState(0)
      const [poseIdx, setPoseIdx] = useState(-1)
      const [shotLabels, setShotLabels] = useState(['全身', '膝上', '半身', '胸上'])
      const [poseLabels, setPoseLabels] = useState([])
      const [toast, setToast] = useState(null)
      const toastTimer = useRef(null)
      const [progress, setProgress] = useState(null)   // { pct, label }
      const progTimer = useRef(null)
      const panelRef = useRef(null)
      const canvasRef = useRef(null)
      const photoRef = useRef(null)
      const charRef = useRef(null)

      // 全局提示条：成功/警告/失败都在这里弹一下，3~6 秒自动消失
      const flash = useCallback((text, kind = 'ok', ms = 6000) => {
        setToast({ text: String(text), kind })
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), ms)
      }, [])

      // 进度条：真实能报的只有「阶段」，阶段内部按 2%/250ms 慢慢爬，别让它假装知道
      const progStart = useCallback((pct, label, cap) => {
        setProgress({ pct, label, cap })
        if (progTimer.current) clearInterval(progTimer.current)
        progTimer.current = setInterval(() => {
          setProgress((p) => {
            if (!p) return p
            const cap2 = p.cap || 92
            if (p.pct >= cap2) return p
            return { ...p, pct: Math.min(cap2, p.pct + 2) }
          })
        }, 250)
      }, [])
      const progDone = useCallback((label = '完成', holdMs = 1200) => {
        if (progTimer.current) { clearInterval(progTimer.current); progTimer.current = null }
        setProgress({ pct: 100, label, cap: 100 })
        setTimeout(() => setProgress(null), holdMs)
      }, [])
      const progStop = useCallback(() => {
        if (progTimer.current) { clearInterval(progTimer.current); progTimer.current = null }
        setProgress(null)
      }, [])

      // 本机能力：caps 为 null（还没问到 / 问失败）时按可用处理，
      // 探测到「没有」才置灰，并把 host 给的原因原样挂在按钮 title 上。
      const capOk = (k) => !caps || Boolean(caps[k] && caps[k].ok)
      const capWhy = (k) => (caps && caps[k] ? String(caps[k].reason || caps[k].hint || '') : '')

      // 1) 场景列表 + 素材清单 + 本机能力
      useEffect(() => {
        let alive = true
        fetch(API + '/scenes')
          .then((r) => r.json())
          .then((data) => {
            if (!alive) return
            const list = Array.isArray(data.scenes) ? data.scenes : []
            setScenes(list)
            setWsHint(data.hint ? String(data.hint) : '')
            if (list.length) setScene((cur) => cur || list[0].name)
          })
          .catch((e) => alive && setStatus(String(e.message || e)))
        fetch(API + '/assets')
          .then((r) => r.json())
          .then((data) => { if (alive) setAssets({ photos: data.photos || [], chars: data.chars || [] }) })
          .catch(() => { /* 素材清单拿不到不影响主流程 */ })
        // 能力探测：host 端只有在依赖真的在的时候才报 true。
        // 拿不到（旧版 host / 请求失败）就当「未知」，按可用处理，别把按钮无辜灰掉。
        fetch(API + '/capabilities')
          .then((r) => r.json())
          .then((data) => {
            if (!alive) return
            setCaps(data && data.capabilities && typeof data.capabilities === 'object'
              ? data.capabilities : null)
            if (data && data.hint) setWsHint(String(data.hint))
          })
          .catch(() => { /* 探测失败 = 未知 */ })
        return () => { alive = false }
      }, [])

      // 2) 切场景：读参数 + 加载底图
      useEffect(() => {
        if (!scene) return undefined
        let alive = true
        setStatus(t('loading'))
        fetch(`${API}/scene?name=${encodeURIComponent(scene)}`)
          .then((r) => r.json())
          .then((data) => {
            if (!alive) return
            if (data.error) { setStatus(data.error); return }
            setCfg(data.cfg || {})
            setParams(paramsFromCfg(data.cfg || {}))
            setConfirmed(data.cfg && data.cfg.CONFIRMED === true)
            setCharPath((data.cfg && data.cfg.CHAR) || '')
            setStatus('')
          })
          .catch((e) => alive && setStatus(String(e.message || e)))

        const img = new Image()
        img.onload = () => {
          if (!alive) return
          photoRef.current = img
          setImgVer((v) => v + 1)
        }
        img.onerror = () => {
          if (!alive) return
          photoRef.current = null
          setImgVer((v) => v + 1)
        }
        img.src = `${API}/image?name=${encodeURIComponent(scene)}&kind=photo&v=${Date.now()}`
        return () => { alive = false }
      }, [scene])

      // 2b) 立绘单独加载：换场景换立绘互不干扰
      useEffect(() => {
        let alive = true
        if (!charPath) {
          charRef.current = null
          setImgVer((v) => v + 1)
          return () => { alive = false }
        }
        const img = new Image()
        img.onload = () => {
          if (!alive) return
          charRef.current = img
          setImgVer((v) => v + 1)
        }
        img.onerror = () => {
          if (!alive) return
          charRef.current = null
          setImgVer((v) => v + 1)
        }
        img.src = `${API}/image?path=${encodeURIComponent(charPath)}&v=${Date.now()}`
        return () => { alive = false }
      }, [charPath])

      // 3) 渲染
      useEffect(() => {
        const canvas = canvasRef.current
        const photo = photoRef.current
        if (!canvas || !photo) return
        const W = photo.naturalWidth
        const H = photo.naturalHeight
        if (canvas.width !== W) { canvas.width = W; canvas.height = H }
        const g = canvas.getContext('2d')
        g.clearRect(0, 0, W, H)
        g.drawImage(photo, 0, 0)

        if (grid) drawGrid(g, W, H, params)

        const charH = num(cfg.CHAR_H, 1.62)
        const pl = placeAt(W, H, params.camH, params.pitch, params.feq,
          params.xpos, params.dist, charH)
        const charImg = charRef.current
        if (pl && charImg) {
          const targetH = pl.pxHeight * params.scale * (params.crop || 1)
          const targetW = (charImg.naturalWidth * targetH) / charImg.naturalHeight
          g.drawImage(charImg, pl.foot[0] - targetW / 2, pl.foot[1] - targetH, targetW, targetH)
        }

        const vh = horizonV(W, H, params.camH, params.pitch, params.feq)
        g.strokeStyle = '#00dcdc'
        g.lineWidth = 3
        g.beginPath()
        g.moveTo(0, vh)
        g.lineTo(W, vh)
        g.stroke()

        if (pl) {
          g.strokeStyle = '#ffd200'
          g.beginPath()
          g.moveTo(0, pl.foot[1])
          g.lineTo(W, pl.foot[1])
          g.stroke()
        }
      }, [params, grid, cfg, imgVer])

      const info = useMemo(() => {
        const photo = photoRef.current
        if (!photo) return null
        const W = photo.naturalWidth
        const H = photo.naturalHeight
        const pl = placeAt(W, H, params.camH, params.pitch, params.feq,
          params.xpos, params.dist, num(cfg.CHAR_H, 1.62))
        if (!pl) return null
        return {
          px: pl.pxHeight,
          foot: pl.foot[1],
          head: pl.head[1],
          horizon: horizonV(W, H, params.camH, params.pitch, params.feq),
          outOfFrame: pl.foot[1] > H || pl.foot[1] < 0,
        }
      }, [params, cfg, imgVer])

      const set = (key) => (ev) => {
        const v = Number(ev.target.value)
        setParams((p) => ({ ...p, [key]: v }))
      }

      const reset = useCallback(() => {
        setParams(paramsFromCfg(cfg))
        setConfirmed(cfg.CONFIRMED === true)
        setStatus('')
      }, [cfg])

      const save = useCallback(async () => {
        if (!scene || busy) return
        setBusy(true)
        setStatus(t('saving'))
        try {
          const r = await fetch(API + '/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              scene,
              values: {
                PITCH_DEG: round(params.pitch, 2),
                CHAR_D: round(params.dist, 3),
                CHAR_X: round(params.xpos, 3),
                SCALE_TWEAK: round(params.scale, 3),
                CAM_H: round(params.camH, 2),
                FEQ: round(params.feq, 1),
                CONFIRMED: Boolean(confirmed),
                CHAR_CROP: round(params.crop || 1, 2),
                ...(charPath ? { CHAR: charPath } : {}),
              },
            }),
          })
          const data = await r.json()
          if (data.error) throw new Error(data.error)
          const bits = []
          if (data.changed && data.changed.length) {
            bits.push(data.changed.map((c) => `${c[0]}: ${c[1]} → ${c[2]}`).join('; '))
          }
          if (data.added && data.added.length) bits.push('+' + data.added.join(', '))
          setStatus(`${t('saved')} ${data.path}${bits.length ? ' · ' + bits.join(' · ') : ' · ' + t('noChange')}`)
          flash(`✓ 已写回 ${data.path}`
            + (bits.length ? '\n' + bits.join(' · ') : ' · ' + t('noChange')), 'ok', 5000)
          // 重新拉一遍，让 cfg 和 yaml 同步
          const fresh = await fetch(`${API}/scene?name=${encodeURIComponent(scene)}`).then((x) => x.json())
          if (fresh && fresh.cfg) setCfg(fresh.cfg)
        } catch (e) {
          setStatus(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }, [scene, params, confirmed, busy, t])

      // 入库入口：拖进来和点选都走 handleFile，只认 File 对象
      const handleFile = useCallback(async (file) => {
        if (!file || intaking) return
        if (!capOk('intake')) {
          const why = capWhy('intake') || ''
          setStatus(why)
          flash('✗ 这台机器上不能拖图入库：' + why, 'err', 12000)
          return
        }
        // iPhone 直出的 HEIC 在浏览器里 file.type 常常是空串，
        // 类型检查必须同时认扩展名，不能只看 MIME
        const nameOk = /\.(jpe?g|png|webp|heic|heif|bmp)$/i.test(file.name || '')
        if (!/^image\//.test(file.type || '') && !nameOk) {
          const msg = `不认识这个文件：${file.name || '(无名)'}（type=${file.type || '空'}）`
          setStatus(msg)
          flash('✗ ' + msg, 'err', 10000)
          return
        }
        setIntaking(true)
        setStatus(`上传 ${file.name}…`)
        progStart(6, `读文件 ${file.name}`, 22)
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const fr = new FileReader()
            fr.onload = () => resolve(fr.result)
            fr.onerror = () => reject(new Error('读文件失败'))
            fr.readAsDataURL(file)
          })
          progStart(24, '上传到工作区', 42)
          const up = await fetch(API + '/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: file.name, data: dataUrl }),
          }).then((r) => r.json())
          if (up.error) throw new Error(up.error)

          setStatus(t('intaking'))
          progStart(44, 'Depth Pro 出深度（首次约 50 秒，之后 2 秒）', 92)
          const stem = up.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]/g, '-')
          const it = await fetch(API + '/intake', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ photo: up.path, name: stem, force: true }),
          }).then((r) => r.json())
          if (it.error) throw new Error(it.error + (it.log ? '\n' + it.log.slice(-600) : ''))

          progStart(94, '写场景配置', 98)
          const list = await fetch(API + '/scenes').then((r) => r.json())
          const sceneList = Array.isArray(list.scenes) ? list.scenes : []
          setScenes(sceneList)
          const asc = await fetch(API + '/assets').then((r) => r.json())
          setAssets({ photos: asc.photos || [], chars: asc.chars || [] })
          setScene(it.name)

          // 入库成功提示：把这次实际生成了什么说清楚，别只留一行小灰字
          const sc = sceneList.find((x) => x.name === it.name)
          const okBits = [`场景「${it.name}」入库成功`]
          const warnBits = []
          if (it.seconds) okBits.push(`用时 ${it.seconds}s`)
          okBits.push('深度图已生成')
          if (sc && sc.photoOk) okBits.push(`底图 ${sc.photo.split('/').pop()}`)
          else warnBits.push('底图路径要检查')
          if (sc && sc.charOk) okBits.push(`立绘 ${sc.char.split('/').pop()}`)
          else warnBits.push('还没配立绘，去立绘下拉选一个')
          const text = (warnBits.length ? '△ ' : '✓ ') + okBits.join(' · ')
            + (warnBits.length ? '\n⚠ ' + warnBits.join('；') : '')
          flash(text, warnBits.length ? 'warn' : 'ok')
          setStatus(`${t('intakeOk')}: ${it.name}（${it.seconds}s）`)
          progDone(warnBits.length ? '入库完成（有提醒）' : '入库完成', 1400)
        } catch (e) {
          setStatus(String(e.message || e))
          progStop()
          flash('✗ 入库失败：' + String(e.message || e), 'err', 12000)
        } finally {
          setIntaking(false)
        }
      }, [intaking, t, flash, progStart, progDone, progStop])

      // 拖拽入口：只负责从那层事件对象里把 File 抠出来
      const handleDrop = useCallback((ev) => {
        if (ev && ev.preventDefault) ev.preventDefault()
        setDragOver(false)
        const files = (ev && ev.dataTransfer && ev.dataTransfer.files) || []
        if (files.length) handleFile(files[0])
      }, [handleFile])

      // 拖拽兜底：window 上捕获阶段接管，绕开 React 合成事件和 slot 渲染。
      // 只认落在本面板矩形内的拖动，别处不影响。
      useEffect(() => {
        const inside = (e) => {
          const el = panelRef.current
          if (!el) return false
          const r = el.getBoundingClientRect()
          return e.clientX >= r.left && e.clientX <= r.right
            && e.clientY >= r.top && e.clientY <= r.bottom
        }
        const onOver = (e) => {
          if (!inside(e)) return
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
          setDragOver(true)
        }
        const onLeave = (e) => {
          if (e.clientX <= 0 || e.clientY <= 0) setDragOver(false)
        }
        const onDropAny = (e) => {
          if (!inside(e)) return
          e.preventDefault()
          e.stopPropagation()
          setDragOver(false)
          handleDrop(e)
        }
        window.addEventListener('dragover', onOver, true)
        window.addEventListener('dragleave', onLeave, true)
        window.addEventListener('drop', onDropAny, true)
        return () => {
          window.removeEventListener('dragover', onOver, true)
          window.removeEventListener('dragleave', onLeave, true)
          window.removeEventListener('drop', onDropAny, true)
        }
      }, [handleDrop])

      // 识图：看当前底图，判断场景 → 出候选 prompt
      const runVision = useCallback(async () => {
        if (!scene || visionBusy || genBusy) return
        setVisionBusy(true)
        setGenLog('')
        setStatus(t('visionBusy'))
        try {
          const v = await fetch(API + '/vision', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scene }),
          }).then((r) => r.json())
          if (v.error) throw new Error(v.error)
          setVision(v.vision)
          const c = await fetch(API + '/prompts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              scene, vision: v.vision, offset: 0, shot: shotIdx, pose: poseIdx,
            }),
          }).then((r) => r.json())
          if (c.error) throw new Error(c.error)
          const list = c.candidates || []
          if (Array.isArray(c.shots) && c.shots.length) setShotLabels(c.shots)
          if (Array.isArray(c.poses) && c.poses.length) setPoseLabels(c.poses)
          setPoseOffset(0)
          setCandidates(list)
          setPicked(list.length ? list[0].prompt : '')
          setStatus(`${t('visionLocal')} · ${v.seconds}s`)
        } catch (e) {
          setStatus(String(e.message || e))
        } finally {
          setVisionBusy(false)
        }
      }, [scene, visionBusy, genBusy, t, shotIdx, poseIdx])

      // 改景别/姿势后重新组候选（不重新识图）
      const rebuild = useCallback(async (shot, pose) => {
        if (!vision || visionBusy || genBusy) return
        setVisionBusy(true)
        try {
          const c = await fetch(API + '/prompts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scene, vision, offset: poseOffset, shot, pose }),
          }).then((r) => r.json())
          if (c.error) throw new Error(c.error)
          const list = c.candidates || []
          setCandidates(list)
          if (list.length) setPicked(list[0].prompt)
        } catch (e) {
          setStatus(String(e.message || e))
        } finally {
          setVisionBusy(false)
        }
      }, [scene, vision, visionBusy, genBusy, poseOffset])

      // 换一批姿态：同样的场景识别结果，换个姿态偏移重新组候选
      const shufflePoses = useCallback(async () => {
        if (!vision || visionBusy || genBusy) return
        const next = poseOffset + 1
        setVisionBusy(true)
        try {
          const c = await fetch(API + '/prompts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              scene, vision, offset: next, shot: shotIdx, pose: poseIdx,
            }),
          }).then((r) => r.json())
          if (c.error) throw new Error(c.error)
          const list = c.candidates || []
          setPoseOffset(next)
          setCandidates(list)
          if (list.length) setPicked(list[0].prompt)
          setStatus(`${t('shuffle')} ${next}`)
        } catch (e) {
          setStatus(String(e.message || e))
        } finally {
          setVisionBusy(false)
        }
      }, [scene, vision, visionBusy, genBusy, poseOffset, t, shotIdx, poseIdx])

      // 生成：MOSS 出图 → 验同人 → 抠图 → 去白边
      const runGenerate = useCallback(async () => {
        if (!scene || !picked.trim() || genBusy) return
        setGenBusy(true)
        setStatus(t('generating'))
        // 生成是 ~90 秒一条龙，前端只能按实测耗时切阶段：
        // MOSS 出图 ~50s、验同人 ~8s、抠图 ~35s、去白边 ~2s。
        // 阶段内由 progStart 的定时器慢慢爬，不装真进度。
        const stageTimers = []
        progStart(4, 'MOSS 出图（约 50 秒）', 52)
        stageTimers.push(setTimeout(() => progStart(56, '验同人 face_sim', 64), 50000))
        stageTimers.push(setTimeout(() => progStart(65, '抠图 BiRefNet', 93), 60000))
        stageTimers.push(setTimeout(() => progStart(94, '去白边 + 存盘', 99), 98000))
        try {
          const d = await fetch(API + '/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              scene,
              prompt: picked,
              name: `becky-${scene}-${Date.now()}`,
            }),
          }).then((r) => r.json())
          stageTimers.forEach(clearTimeout)
          if (!d.ok) {
            throw new Error((d.error || d.why || '失败')
              + (d.log ? '\n' + String(d.log).slice(-500) : ''))
          }
          progDone('立绘生成完成', 1400)
          setGenLog(String(d.log || ''))
          setStatus(`${t('genDone')} · ${d.path} · ${d.seconds}s`)
          flash(`✓ 立绘生成成功 · ${String(d.path).split('/').pop()} · ${d.seconds}s`, 'ok', 8000)
          const asc = await fetch(API + '/assets').then((r) => r.json())
          setAssets({ photos: asc.photos || [], chars: asc.chars || [] })
          setCharPath(d.path)
        } catch (e) {
          stageTimers.forEach(clearTimeout)
          progStop()
          setStatus(String(e.message || e))
          flash('✗ 生成失败\n' + String(e.message || e), 'err', 15000)
        } finally {
          setGenBusy(false)
        }
      }, [scene, picked, genBusy, t, progStart, progDone, progStop])

      // 删立绘：点一次上膛，再点一次才真删
      const deleteChar = useCallback(async () => {
        if (!charPath) return
        if (!delArmed) {
          setDelArmed(true)
          setStatus(`再点一次删掉 ${charPath}`)
          setTimeout(() => setDelArmed(false), 4000)
          return
        }
        setDelArmed(false)
        try {
          const d = await fetch(API + '/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: charPath }),
          }).then((r) => r.json())
          if (d.error) throw new Error(d.error)
          setStatus(`已删 ${d.deleted}`
            + (d.usedBy && d.usedBy.length ? ` · 这些场景还指着它：${d.usedBy.join(', ')}` : ''))
          setCharPath('')
          const asc = await fetch(API + '/assets').then((r) => r.json())
          setAssets({ photos: asc.photos || [], chars: asc.chars || [] })
        } catch (e) {
          setStatus(String(e.message || e))
        }
      }, [charPath, delArmed])

      // 一键去白边：没透明通道就先抠图，然后反预乘去污染
      const fixEdges = useCallback(async () => {
        if (!charPath || edgeBusy) return
        setEdgeBusy(true)
        setStatus(t('edgeBusy'))
        try {
          const d = await fetch(API + '/decontam', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: charPath }),
          }).then((r) => r.json())
          if (!d.ok) {
            throw new Error(d.error || ('处理失败\n' + String(d.log || '').slice(-400)))
          }
          setStatus(`${t('edge')} 完成 · ${d.path} · ${d.seconds}s`)
          flash(`✓ 去白边完成 · ${String(d.path).split('/').pop()} · ${d.seconds}s`, 'ok', 6000)
          const asc = await fetch(API + '/assets').then((r) => r.json())
          setAssets({ photos: asc.photos || [], chars: asc.chars || [] })
          setCharPath(d.path)
        } catch (e) {
          setStatus(String(e.message || e))
        } finally {
          setEdgeBusy(false)
        }
      }, [charPath, edgeBusy, t])

      // ── 在画布上直接拖她 ─────────────────────────────────
      // 按在人物身上，鼠标落点反解成地面坐标 → 改 CHAR_X / CHAR_D。
      // 拖动时保留按下瞬间的偏移，人不会"吸"到鼠标上。
      const [dragging, setDragging] = useState(false)
      const dragRef = useRef(null)

      const canvasPoint = (e) => {
        const c = canvasRef.current
        if (!c) return null
        const r = c.getBoundingClientRect()
        if (!r.width || !r.height) return null
        return {
          x: ((e.clientX - r.left) / r.width) * c.width,
          y: ((e.clientY - r.top) / r.height) * c.height,
          W: c.width,
          H: c.height,
        }
      }

      const onCanvasDown = (e) => {
        const pt = canvasPoint(e)
        if (!pt) return
        const pl = placeAt(pt.W, pt.H, params.camH, params.pitch, params.feq,
          params.xpos, params.dist, num(cfg.CHAR_H, 1.62))
        if (!pl) return
        const halfW = Math.max(30, pl.pxHeight * 0.32)
        const onChar = Math.abs(pt.x - pl.foot[0]) < halfW
          && pt.y > pl.head[1] - 10 && pt.y < pl.foot[1] + 36
        if (!onChar) return
        e.preventDefault()
        dragRef.current = { dx: pt.x - pl.foot[0], dy: pt.y - pl.foot[1] }
        setDragging(true)
      }

      const onCanvasMove = (e) => {
        if (!dragRef.current) return
        const pt = canvasPoint(e)
        if (!pt) return
        e.preventDefault()
        const g = solveGround(pt.x - dragRef.current.dx, pt.y - dragRef.current.dy,
          pt.W, pt.H, params.camH, params.pitch, params.feq)
        if (!g) return
        setParams((prev) => ({
          ...prev,
          xpos: Math.min(5, Math.max(-5, g.x)),
          dist: Math.min(12, Math.max(0.3, g.d)),
        }))
      }

      const onCanvasUp = () => {
        if (!dragRef.current) return
        dragRef.current = null
        setDragging(false)
      }

      const stylePanel = { display: 'flex', gap: 16, padding: 16, height: '100%',
        boxSizing: 'border-box', minHeight: 0, color: '#ddd', background: '#17171a' }
      const styleSide = { flex: '0 0 300px', display: 'flex', flexDirection: 'column',
        gap: 10, minWidth: 280, overflowY: 'auto' }
      const styleCard = { background: '#222227', borderRadius: 10, padding: 12,
        border: '1px solid #2e2e34', fontSize: 12 }
      const styleRow = { display: 'flex', alignItems: 'center', gap: 8 }
      const styleLabel = { width: 74, color: '#aaa', flex: '0 0 auto' }
      const styleVal = { width: 54, textAlign: 'right', color: '#7fd4ff',
        fontVariantNumeric: 'tabular-nums' }
      const styleCanvasBox = { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: '#111', borderRadius: 10, overflow: 'hidden' }
      const styleBtn = { background: '#2f6fd0', color: '#fff', border: 'none',
        borderRadius: 7, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }
      const styleBtn2 = { ...styleBtn, background: '#33333a', color: '#ddd' }
      const styleSel = { flex: 1, minWidth: 0, background: '#17171a', color: '#ddd',
        border: '1px solid #3a3a42', borderRadius: 6, padding: '5px 6px', fontSize: 12 }
      const styleDrop = {
        marginTop: 8, border: `1px dashed ${dragOver ? '#7fd4ff' : '#3a3a42'}`,
        borderRadius: 8, padding: '10px 8px', textAlign: 'center', fontSize: 11,
        color: dragOver ? '#7fd4ff' : '#777', cursor: 'copy',
        background: dragOver ? '#1d2a33' : 'transparent',
      }

      const current = scenes.find((s) => s.name === scene)

      return h('div', {
        ref: panelRef,
        style: { ...stylePanel, position: 'relative' },
        onDragOver: (e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!dragOver) setDragOver(true)
        },
        onDragLeave: (e) => {
          if (e.currentTarget === e.target) setDragOver(false)
        },
        onDrop: (e) => {
          e.preventDefault()
          e.stopPropagation()
          handleDrop(e)
        },
      },
        dragOver
          ? h('div', {
            style: {
              position: 'absolute', inset: 0, background: 'rgba(16,36,52,0.88)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 15, color: '#7fd4ff', pointerEvents: 'none', zIndex: 20,
              border: '2px dashed #7fd4ff', borderRadius: 10, margin: 6,
            },
          }, t('dropNow'))
          : null,
        progress
          ? h('div', {
            style: {
              position: 'absolute', left: 16, right: 16, bottom: 16, zIndex: 31,
              background: '#151a20', border: '1px solid #2f4a63', borderRadius: 8,
              padding: '9px 12px', boxShadow: '0 6px 24px rgba(0,0,0,0.55)',
            },
          },
          h('div', {
            style: { display: 'flex', justifyContent: 'space-between',
              fontSize: 11, color: '#8fb8d8', marginBottom: 6, gap: 8 },
          },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            progress.label || '处理中'),
          h('span', { style: { flex: '0 0 auto', color: progress.pct >= 100 ? '#8ce0a8' : '#7fd4ff' } },
            Math.round(progress.pct) + '%')),
          h('div', {
            style: { height: 6, background: '#0e1216', borderRadius: 3, overflow: 'hidden' },
          },
          h('div', {
            style: {
              width: progress.pct + '%', height: '100%',
              background: progress.pct >= 100 ? '#2e7d4f' : '#2f6fd0',
              transition: 'width 0.22s linear',
            },
          })))
          : null,
        toast
          ? h('div', {
            style: {
              position: 'absolute', left: 16, right: 16,
              bottom: progress ? 82 : 16,
              padding: '10px 14px', borderRadius: 8, fontSize: 12.5,
              lineHeight: '19px', whiteSpace: 'pre-wrap', zIndex: 30,
              background: toast.kind === 'ok' ? '#12351f'
                : (toast.kind === 'warn' ? '#3a2f10' : '#3a1414'),
              border: `1px solid ${toast.kind === 'ok' ? '#2e7d4f'
                : (toast.kind === 'warn' ? '#8a6d1f' : '#8a2f2f')}`,
              color: toast.kind === 'ok' ? '#8ce0a8'
                : (toast.kind === 'warn' ? '#e0c060' : '#ff9a9a'),
              boxShadow: '0 6px 24px rgba(0,0,0,0.55)',
              cursor: 'pointer',
            },
            onClick: () => setToast(null),
          }, toast.text)
          : null,
        h('div', { style: styleSide },
          h('div', null,
            h('div', { style: { fontSize: 15, fontWeight: 700, color: '#fff' } }, t('title')),
            h('div', { style: { fontSize: 11, color: '#777', marginTop: 2 } },
              t('subtitle'), ' · ', VERSION)),

          h('div', { style: styleCard },
            h('div', { style: { ...styleRow, marginBottom: 4 } },
              h('span', { style: styleLabel }, t('scene')),
              h('select', {
                value: scene,
                onChange: (e) => setScene(e.target.value),
                style: styleSel,
              }, scenes.length
                ? scenes.map((s) => h('option', { key: s.name, value: s.name },
                  s.name + (s.confirmed ? ' ✓' : '')))
                : h('option', { value: '' }, t('noScenes')))),
            h('div', { style: { fontSize: 10, color: '#666', margin: '0 0 8px 82px',
              wordBreak: 'break-all' } }, cfg.PHOTO || ''),
            wsHint
              ? h('div', { style: { fontSize: 10.5, color: '#e0c060', margin: '0 0 8px 0',
                lineHeight: '15px' } }, '⚠ ' + wsHint)
              : null,
            h('div', { style: { ...styleRow, marginBottom: 4 } },
              h('span', { style: styleLabel }, t('char')),
              h('select', {
                value: charPath,
                onChange: (e) => { setCharPath(e.target.value); setDelArmed(false) },
                style: styleSel,
              },
              h('option', { key: '__none', value: '' }, '（无立绘）'),
              assets.chars.map((x) => h('option', { key: x.path, value: x.path }, x.name))),
              h('button', {
                onClick: deleteChar,
                disabled: !charPath,
                title: t('deleteChar'),
                style: {
                  ...styleBtn2, padding: '4px 9px', fontSize: 12, flex: '0 0 auto',
                  color: delArmed ? '#fff' : (charPath ? '#e07a7a' : '#555'),
                  background: delArmed ? '#a33' : '#33333a',
                },
              }, delArmed ? '!' : '×')),
            h('div', { style: { ...styleRow, gap: 6, marginBottom: 6, paddingLeft: 82 } },
              h('button', {
                onClick: fixEdges,
                disabled: !charPath || edgeBusy || !capOk('decontam'),
                title: capOk('decontam') ? t('edge') : (t('capsOff') + (capWhy('decontam') || '')),
                style: {
                  ...styleBtn2, flex: 1, fontSize: 11, padding: '5px 8px',
                  color: charPath && !edgeBusy && capOk('decontam') ? '#cfe3ff' : '#666',
                },
              }, edgeBusy ? t('edgeBusy') : t('edge')),
              h('select', {
                value: params.crop || 1,
                onChange: (e) => setParams((p) => ({ ...p, crop: Number(e.target.value) })),
                title: '立绘裁切：半身/膝上的图要用对应的值，图片底边才会对到腰/膝盖',
                style: { ...styleSel, flex: '0 0 78px' },
              }, CROPS.map((c) => h('option', { key: c.value, value: c.value }, c.label)))),
            current && !current.photoOk
              ? h('div', { style: { color: '#ff8a8a', fontSize: 11 } }, t('photoMissing'))
              : null,
            h('div', {
              style: capOk('intake')
                ? styleDrop
                : { ...styleDrop, cursor: 'not-allowed', opacity: 0.55 },
              title: capOk('intake') ? '' : capWhy('intake'),
              onClick: () => {
                if (!capOk('intake')) return
                const inp = document.createElement('input')
                inp.type = 'file'
                inp.accept = 'image/*,.heic,.heif,.HEIC,.HEIF'
                inp.style.position = 'fixed'
                inp.style.left = '-10000px'
                document.body.appendChild(inp)
                inp.onchange = (e) => {
                  const f = e.target.files && e.target.files[0]
                  try { document.body.removeChild(inp) } catch (err) { /* ignore */ }
                  if (f) handleFile(f)
                }
                inp.click()
              },
            }, intaking ? t('intaking')
              : (dragOver ? t('dropNow')
                : (capOk('intake') ? t('dropHint') : t('capsOff') + (capWhy('intake') || ''))))),

          h('div', { style: styleCard },
            h('div', { style: { fontWeight: 600, color: '#fff', marginBottom: 3 } }, t('visionTitle')),
            h('div', { style: { fontSize: 10, color: '#777', marginBottom: 8, lineHeight: '15px' } },
              t('visionHint')),
            caps && (!capOk('vision') || !capOk('generate'))
              ? h('div', { style: { fontSize: 10, color: '#a08a5a', marginBottom: 8,
                lineHeight: '15px', borderLeft: '2px solid #6a5a2a', paddingLeft: 6,
                whiteSpace: 'pre-wrap' } },
              [
                !capOk('vision') ? `识图：${capWhy('vision')}` : '',
                !capOk('generate') ? `生成：${capWhy('generate')}` : '',
              ].filter(Boolean).join('\n'))
              : null,
            h('div', { style: { ...styleRow, gap: 6, marginBottom: 6 } },
              h('button', {
                onClick: () => runVision(),
                disabled: visionBusy || genBusy || !capOk('vision'),
                title: capOk('vision') ? t('visionLocal') : (t('capsOff') + (capWhy('vision') || '')),
                style: { ...styleBtn2, flex: 1, fontSize: 11, padding: '6px 8px',
                  color: capOk('vision') ? undefined : '#666' },
              }, t('visionLocal'))),
            vision
              ? h('div', { style: { fontSize: 11, color: '#9aa', marginBottom: 6, lineHeight: '16px' } },
                `${vision.scene_type || '?'} · ${vision.season || '?'} · ${vision.light || '?'}`,
                vision.summary
                  ? h('div', { style: { color: '#bbb', marginTop: 2 } }, String(vision.summary))
                  : null)
              : h('div', { style: { fontSize: 10, color: '#666', marginBottom: 6 } }, t('noVision')),
            vision
              ? h('div', { style: { ...styleRow, gap: 6, marginBottom: 6 } },
                h('select', {
                  value: shotIdx,
                  onChange: (e) => { const v = Number(e.target.value); setShotIdx(v); rebuild(v, poseIdx) },
                  title: '景别',
                  style: styleSel,
                }, shotLabels.map((s, i) => h('option', { key: i, value: i }, s))),
                h('select', {
                  value: poseIdx,
                  onChange: (e) => { const v = Number(e.target.value); setPoseIdx(v); rebuild(shotIdx, v) },
                  title: '姿势',
                  style: styleSel,
                },
                h('option', { key: -1, value: -1 }, t('poseAuto')),
                poseLabels.map((s, i) => h('option', { key: i, value: i }, s))))
              : null,
            candidates.length
              ? h('div', null,
                h('div', { style: { ...styleRow, justifyContent: 'space-between', marginBottom: 4 } },
                  h('span', { style: { fontSize: 10, color: '#777' } }, t('candidates')),
                  h('span', {
                    onClick: shufflePoses,
                    style: { fontSize: 10, color: visionBusy ? '#555' : '#7fd4ff',
                      cursor: visionBusy ? 'default' : 'pointer' },
                  }, t('shuffle'))),
                candidates.map((c) => h('div', {
                  key: c.id,
                  onClick: () => setPicked(c.prompt),
                  style: {
                    fontSize: 10, padding: '5px 7px', marginBottom: 4, borderRadius: 6,
                    cursor: 'pointer', lineHeight: '14px',
                    border: `1px solid ${picked === c.prompt ? '#2f6fd0' : '#33333a'}`,
                    background: picked === c.prompt ? '#1b2a3d' : '#1b1b1f',
                    color: picked === c.prompt ? '#dbe8f7' : '#aaa',
                  },
                }, c.label)))
              : null,
            h('div', null,
              h('div', { style: { fontSize: 9, color: '#666', marginTop: 6 } },
                picked ? t('promptEdit') : t('needVision')),
              h('textarea', {
                value: picked,
                onChange: (e) => setPicked(e.target.value),
                placeholder: t('needVision'),
                rows: 4,
                style: {
                  width: '100%', boxSizing: 'border-box', background: '#17171a',
                  color: '#ccc', border: '1px solid #3a3a42', borderRadius: 6,
                  padding: 6, fontSize: 10, marginTop: 4, resize: 'vertical',
                  fontFamily: 'ui-monospace, Menlo, monospace', lineHeight: '14px',
                },
              }),
              h('button', {
                onClick: runGenerate,
                disabled: !picked.trim() || genBusy || !capOk('generate'),
                title: capOk('generate') ? t('generate') : (t('capsOff') + (capWhy('generate') || '')),
                style: {
                  ...styleBtn, width: '100%', marginTop: 6, fontSize: 12,
                  background: (!picked.trim() || genBusy || !capOk('generate')) ? '#33333a' : '#2f6fd0',
                  color: (!picked.trim() || genBusy || !capOk('generate')) ? '#777' : '#fff',
                },
              }, genBusy ? t('generating') : t('generate'))),
            genLog
              ? h('div', { style: { fontSize: 9, color: '#777', marginTop: 6, maxHeight: 90,
                overflow: 'auto', whiteSpace: 'pre-wrap', lineHeight: '13px' } },
              String(genLog).slice(-500))
              : null),

          h('div', { style: styleCard },
            SLIDERS.map((s) => h('div', { key: s.key, style: { ...styleRow, marginBottom: 8 } },
              h('span', { style: styleLabel }, t(s.labelKey)),
              h('input', {
                type: 'range',
                min: s.min, max: s.max, step: s.step,
                value: params[s.key],
                onChange: set(s.key),
                style: { flex: 1, accentColor: '#7fd4ff' },
              }),
              h('span', { style: styleVal }, Number(params[s.key]).toFixed(s.digits))))),

          h('div', { style: styleCard },
            h('label', { style: { ...styleRow, gap: 6, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: grid,
                onChange: (e) => setGrid(e.target.checked) }),
              h('span', null, t('grid'))),
            h('label', { style: { ...styleRow, gap: 6, cursor: 'pointer', marginTop: 8 } },
              h('input', { type: 'checkbox', checked: confirmed,
                onChange: (e) => setConfirmed(e.target.checked) }),
              h('span', { style: { color: confirmed ? '#78d878' : '#c48a4a' } }, t('confirmed'))),
            h('div', { style: { marginTop: 6, fontSize: 11, color: confirmed ? '#78d878' : '#c48a4a' } },
              confirmed ? t('isConfirmed') : t('notConfirmed'))),

          h('div', { style: { ...styleRow, gap: 8 } },
            h('button', { onClick: save, disabled: busy, style: styleBtn },
              busy ? t('saving') : t('save')),
            h('button', { onClick: reset, disabled: busy, style: styleBtn2 }, t('reset'))),

          info ? h('div', { style: styleCard },
            h('div', { style: { ...styleRow, justifyContent: 'space-between' } },
              h('span', { style: { color: '#888' } }, t('px')),
              h('span', { style: styleVal }, info.px.toFixed(0))),
            h('div', { style: { ...styleRow, justifyContent: 'space-between' } },
              h('span', { style: { color: '#888' } }, t('foot')),
              h('span', { style: styleVal }, info.foot.toFixed(0))),
            h('div', { style: { ...styleRow, justifyContent: 'space-between' } },
              h('span', { style: { color: '#888' } }, t('head')),
              h('span', { style: styleVal }, info.head.toFixed(0))),
            h('div', { style: { ...styleRow, justifyContent: 'space-between' } },
              h('span', { style: { color: '#888' } }, t('horizon')),
              h('span', { style: styleVal }, info.horizon.toFixed(0))),
            info.outOfFrame
              ? h('div', { style: { color: '#ff8a8a', marginTop: 6, fontSize: 11 } }, '⚠ 脚底在画面外')
              : null)
            : null,

          status ? h('div', { style: { fontSize: 11, color: '#9a9aa4', lineHeight: '16px',
            wordBreak: 'break-all' } }, status) : null),

        h('div', { style: styleCanvasBox },
          h('canvas', {
            ref: canvasRef,
            onMouseDown: onCanvasDown,
            onMouseMove: onCanvasMove,
            onMouseUp: onCanvasUp,
            onMouseLeave: onCanvasUp,
            style: {
              maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
              display: 'block', borderRadius: 6,
              cursor: dragging ? 'grabbing' : 'grab',
            },
          })))
    }

    function round(v, nd) {
      const m = 10 ** nd
      return Math.round(v * m) / m
    }

    const plugin = {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'perspective:locale')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS },
            (props) => h(Page, { t: (props && props.t) || t })))

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 26, label: () => t('panel'), locale: NS },
            Glyph,
          ))
      },
    }

    return plugin
  },
})
