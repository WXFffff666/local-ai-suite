/**
 * ModelRegistry — T11 models/ 热加载注册表
 * Spec:
 * - 监听 models/ 目录（chokidar），拖入 GGUF / safetensors / ONNX 等自动识别 quant/arch/name/size 写入 models.json
 * - 失败隔离：单文件 stat/解析失败不崩主进程，损坏文件标记 corrupted 并跳过，损坏的 models.json 可重建
 * - 热加载：add / change / unlink 触发增量 scan + models.json 重写 + update 事件
 * - 原子写入：先写 .tmp 再 rename，避免半写
 */

import * as fs from 'fs'
import * as path from 'path'

// chokidar is optional at runtime (injected / dynamic) to keep tests free of native FSWatcher; dynamic require keeps Electron externalizeDeps happy
type FSWatcherLike = {
  close: () => Promise<void>
}

export type ModelFormat = 'gguf' | 'safetensors' | 'onnx' | 'bin' | 'unknown'

export type ModelEntry = {
  /** 去扩展名的 name（或相对路径去扩展名） */
  name: string
  /** 相对 modelsDir 的路径（POSIX） */
  file: string
  /** 绝对路径 */
  path: string
  /** 字节大小 */
  size: number
  /** 量化标签，如 Q4_K_M / Q8_0 / F16 / BF16 / unknown */
  quant: string
  /** 架构标签，如 llama / qwen2 / mistral / unknown */
  arch: string
  /** 文件格式 */
  format: ModelFormat
  /** mtime ms */
  mtimeMs: number
  /** 是否损坏（探针失败）*/
  corrupted?: boolean
  /** 失败原因（仅 corrupted 时） */
  error?: string
  /**
   * todo21: VLM 视觉投影文件（llama.cpp mtmd）。按命名约定在同一目录发现
   * mmproj-*.gguf 伴生文件时配对（绝对路径）。缺省 = 该模型无视觉投影，
   * 聊天贴图 UI 应禁用（plan QA-fail 场景）。
   */
  projectorPath?: string
}

export type RegistryOptions = {
  /** models.json 文件名，默认 models.json 落于 modelsDir 根 */
  modelsJsonName?: string
  /** chokidar 注入，测试用 fake */
  watcherFactory?: (dir: string, opts: unknown) => FSWatcherLike & { on: (ev: string, cb: (...args: unknown[]) => void) => unknown }
  /** fs 注入 */
  fsDeps?: {
    existsSync: typeof fs.existsSync
    statSync: typeof fs.statSync
    readdirSync: typeof fs.readdirSync
    readFileSync: typeof fs.readFileSync
    writeFileSync: typeof fs.writeFileSync
    renameSync: typeof fs.renameSync
    mkdirSync: typeof fs.mkdirSync
  }
  /** 扫描时忽略的目录/文件名（默认跳过 models.json 本身）*/
  ignoreFileNames?: Set<string>
  /** 日志回调 */
  logger?: Pick<Console, 'warn' | 'error' | 'log'>
  /** chokidar 选项覆盖 */
  chokidarOptions?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Quant / Arch 识别
// ---------------------------------------------------------------------------

/** 已知的 GGUF 量化 token，按长到短排，优先长匹配 */
const QUANT_TOKENS = [
  'Q4_K_M',
  'Q4_K_S',
  'Q5_K_M',
  'Q5_K_S',
  'Q3_K_L',
  'Q3_K_M',
  'Q3_K_S',
  'Q2_K',
  'Q6_K',
  'Q8_0',
  'Q5_1',
  'Q5_0',
  'Q4_1',
  'Q4_0',
  'IQ4_XS',
  'IQ4_NL',
  'IQ3_XXS',
  'IQ3_XS',
  'IQ2_XXS',
  'IQ2_XS',
  'IQ1_M',
  'IQ1_S',
  'BF16',
  'F32',
  'F16',
  'INT8',
  'INT4',
] as const

const QUANT_RE = new RegExp(`(?:^|[-_\\.])((${QUANT_TOKENS.join('|')}))(?:[-_\\.]|$)`, 'i')

/** 常见架构 token */
const ARCH_TOKENS = [
  'qwen3',
  'qwen2',
  'qwen',
  'llama',
  'mistral',
  'mixtral',
  'gemma',
  'phi3',
  'phi',
  'deepseek',
  'yi',
  'baichuan',
  'chatglm',
  'glm',
  'internlm',
  'falcon',
  'mpt',
  'starcoder',
  'codellama',
  'bge',
  'e5',
] as const

export function detectQuant(fileName: string): string {
  const base = path.basename(fileName)
  const m = base.match(QUANT_RE)
  if (m?.[1]) return m[1].toUpperCase()
  // 回退：宽松匹配任意 Q\d / F\d
  const loose = base.match(/(Q\d[_\w]*|F16|F32|BF16)/i)
  if (loose?.[1]) return loose[1].toUpperCase()
  return 'UNKNOWN'
}

export function detectArch(fileName: string): string {
  const lower = fileName.toLowerCase()
  for (const tok of ARCH_TOKENS) {
    if (lower.includes(tok)) return tok
  }
  return 'unknown'
}

// 别名：任务要求 parseQuant / parseArch，与 detect* 等价
export const parseQuant = detectQuant
export const parseArch = detectArch

export function detectFormat(fileName: string): ModelFormat {
  const ext = path.extname(fileName).toLowerCase()
  if (ext === '.gguf') return 'gguf'
  if (ext === '.safetensors') return 'safetensors'
  if (ext === '.onnx') return 'onnx'
  if (ext === '.bin') return 'bin'
  return 'unknown'
}

export function isModelFile(fileName: string): boolean {
  const fmt = detectFormat(fileName)
  return fmt !== 'unknown'
}

// ---------------------------------------------------------------------------
// todo21: VLM 视觉投影（mmproj）识别与配对
// ---------------------------------------------------------------------------

/**
 * llama.cpp 社区约定：视觉投影文件命名含独立的 `mmproj` token
 * （`mmproj-*.gguf` 前缀或 `*-mmproj[-QUANT].gguf` 后缀形态）。
 * 这类文件绝不作为独立模型进入注册表，只作为同目录主模型的 projector。
 */
const MMPROJ_RE = /(^|[-_.])mmproj([-_.]|$)/i

export function isMmprojFile(fileName: string): boolean {
  return MMPROJ_RE.test(path.basename(fileName))
}

/** 小写去扩展名的 stem，用于前缀亲缘打分 */
function stemOf(absPath: string): string {
  return path.basename(absPath).replace(/\.[^.]+$/, '').toLowerCase()
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  return i
}

/** 候选名去掉 mmproj token 后的亲缘键（mmproj-qwen-vl → qwen-vl；qwen-vl-mmproj-bf16 → qwen-vl-bf16） */
function projectorKey(candidate: string): string {
  return stemOf(candidate)
    .replace(/[-_.]?mmproj[-_.]?/i, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
}

/**
 * 从同目录的投影候选里选一个：
 * 亲缘键与模型名 stem 公共前缀最长者优先（≥4 字符才算亲缘）。
 * 无亲缘候选时：目录内只有这一个主模型 ⇒ 约定即配对（取字典序首个）；
 * requireAffinity=true（多模型目录）⇒ 宁缺勿滥返回 undefined。
 * 全程确定性，与扫描顺序无关。
 */
export function pickProjector(
  modelPath: string,
  candidates: readonly string[],
  requireAffinity = false,
): string | undefined {
  if (candidates.length === 0) return undefined
  const stem = stemOf(modelPath)
  const related = candidates
    .map((c) => ({ c, aff: commonPrefixLen(stem, projectorKey(c)) }))
    .filter((s) => s.aff >= 4)
    .sort((a, b) => b.aff - a.aff || stemOf(a.c).localeCompare(stemOf(b.c)))
  if (related.length > 0) return related[0].c
  if (requireAffinity) return undefined
  return [...candidates].sort((a, b) => stemOf(a).localeCompare(stemOf(b)))[0]
}

// ---------------------------------------------------------------------------
// 路径 helpers
// ---------------------------------------------------------------------------

export function getModelsJsonPath(modelsDir: string, name = 'models.json'): string {
  return path.join(modelsDir, name)
}

/** 便捷重载：新建临时 Registry 扫一遍并写 models.json（损坏隔离不抛） */
export function reloadModels(modelsDir: string, opts: RegistryOptions = {}): ModelEntry[] {
  try {
    const reg = new ModelRegistry(modelsDir, opts)
    return reg.scan()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ModelRegistry {
  readonly modelsDir: string
  readonly modelsJsonPath: string
  private readonly opts: Required<Pick<RegistryOptions, 'modelsJsonName'>> & RegistryOptions
  private watcher: FSWatcherLike | null = null
  private models: ModelEntry[] = []
  private listeners = new Set<(models: ModelEntry[]) => void>()
  private scanTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(modelsDir: string, opts: RegistryOptions = {}) {
    this.modelsDir = path.resolve(modelsDir)
    this.opts = {
      modelsJsonName: opts.modelsJsonName ?? 'models.json',
      ...opts,
    } as Required<Pick<RegistryOptions, 'modelsJsonName'>> & RegistryOptions
    this.modelsJsonPath = getModelsJsonPath(this.modelsDir, this.opts.modelsJsonName!)
  }

  // ---- public API ----

  getModels(): ModelEntry[] {
    return [...this.models]
  }

  /** 任务要求：reloadModels() — 同步重扫 + 重写 models.json + 通知，损坏隔离不抛 */
  reloadModels(): ModelEntry[] {
    try {
      return this.scan()
    } catch (err) {
      this.log('warn', `reloadModels failed: ${(err as Error).message}`)
      return this.getModels()
    }
  }

  onUpdate(cb: (models: ModelEntry[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 同步增量/全量扫描：遍历 modelsDir 下所有模型文件 */
  scan(): ModelEntry[] {
    const fsDeps = this.fs()
    const ignore = this.opts.ignoreFileNames ?? new Set([this.opts.modelsJsonName!, 'models.json.tmp'])
    const out: ModelEntry[] = []
    /** todo21: dir → mmproj-*.gguf 绝对路径候选（配对用，不入注册表） */
    const projectors = new Map<string, string[]>()

    const walk = (dir: string): void => {
      let entries: fs.Dirent[] | string[]
      try {
        // 优先用 withFileTypes；注入的 readdirSync 可能不支持 options，重试无参
        try {
          entries = (fsDeps.readdirSync as unknown as (d: string, o: { withFileTypes: true }) => fs.Dirent[])(dir, {
            withFileTypes: true,
          })
          // 兼容：若返回 string[]（fake），再按 string[] 处理
          if (entries.length > 0 && typeof entries[0] === 'string') {
            throw new Error('string entries fallback')
          }
        } catch {
          const names = (fsDeps.readdirSync as unknown as (d: string) => string[])(dir)
          entries = names
        }
      } catch (err) {
        // 损坏目录或权限隔离：跳过，不抛
        this.log('warn', `scan readdir failed ${dir}: ${(err as Error).message}`)
        return
      }

      for (const ent of entries) {
        const nameStr = typeof ent === 'string' ? ent : (ent as fs.Dirent).name
        const isDir = typeof ent === 'string' ? null : (ent as fs.Dirent).isDirectory()
        // 对于 string entries，需要 stat 判断是否目录
        const full = path.join(dir, nameStr)
        if (ignore.has(nameStr)) continue
        // 隐藏文件跳过
        if (nameStr.startsWith('.')) continue

        let statIsDir = isDir
        if (statIsDir === null) {
          try {
            const st = fsDeps.statSync(full)
            statIsDir = st.isDirectory()
          } catch {
            // 损坏文件隔离：标记 corrupted，仍可记录？这里无法判定目录则跳过
            this.log('warn', `stat failed ${full}`)
            continue
          }
        }

        if (statIsDir) {
          walk(full)
          continue
        }

        // todo21: mmproj 投影文件绝不作为独立模型；收作同目录主模型的配对候选
        if (isMmprojFile(nameStr)) {
          if (detectFormat(nameStr) === 'gguf') {
            const bucket = projectors.get(dir) ?? []
            bucket.push(full)
            projectors.set(dir, bucket)
          }
          continue
        }

        // 仅模型文件进入注册表
        if (!isModelFile(nameStr)) continue

        const entry = this.buildEntry(full)
        if (entry) out.push(entry)
        // buildEntry 内部已对单文件失败隔离，null 表示跳过但不崩
      }
    }

    // 确保根目录存在
    try {
      if (!fsDeps.existsSync(this.modelsDir)) {
        fsDeps.mkdirSync(this.modelsDir, { recursive: true })
      }
    } catch (err) {
      this.log('warn', `ensure modelsDir failed: ${(err as Error).message}`)
    }

    walk(this.modelsDir)

    // todo21: 同目录配对 — gguf 主模型获得 projectorPath（无候选则字段缺省）。
    // 目录内有多个 gguf 主模型时要求命名亲缘（≥4 前缀），避免一份投影乱配。
    const ggufCountByDir = new Map<string, number>()
    for (const entry of out) {
      if (entry.format !== 'gguf') continue
      const key = path.dirname(entry.path)
      ggufCountByDir.set(key, (ggufCountByDir.get(key) ?? 0) + 1)
    }
    for (const entry of out) {
      if (entry.format !== 'gguf') continue
      const dirKey = path.dirname(entry.path)
      const candidates = projectors.get(dirKey)
      if (!candidates || candidates.length === 0) continue
      const picked = pickProjector(entry.path, candidates, (ggufCountByDir.get(dirKey) ?? 1) > 1)
      if (picked) entry.projectorPath = picked
    }

    // 按 file 排序稳定输出
    out.sort((a, b) => a.file.localeCompare(b.file))
    this.models = out
    // 持久化与通知均隔离
    try {
      this.writeModelsJson()
    } catch (err) {
      this.log('warn', `writeModelsJson failed: ${(err as Error).message}`)
    }
    this.emit()
    return this.getModels()
  }

  /** 启动 chokidar 监听；若已启动则幂等 */
  async startWatch(): Promise<void> {
    if (this.watcher || this.closed) return
    const fsDeps = this.fs()
    try {
      if (!fsDeps.existsSync(this.modelsDir)) {
        fsDeps.mkdirSync(this.modelsDir, { recursive: true })
      }
    } catch (err) {
      this.log('warn', `ensure modelsDir failed: ${(err as Error).message}`)
    }

    // 首轮全量扫描
    try {
      this.scan()
    } catch (err) {
      this.log('warn', `initial scan failed: ${(err as Error).message}`)
    }

    // 懒加载 chokidar，支持注入
    let factory = this.opts.watcherFactory
    if (!factory) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const chokidar = require('chokidar') as {
          watch: (p: string, opts: unknown) => FSWatcherLike & { on: (ev: string, cb: (...a: unknown[]) => void) => unknown }
        }
        factory = (dir: string, o: unknown) => chokidar.watch(dir, o)
      } catch (err) {
        this.log('warn', `chokidar not available, watch disabled: ${(err as Error).message}`)
        return
      }
    }

    const chokidarOpts = {
      ignored: (p: string) => {
        const base = path.basename(p)
        return base === this.opts.modelsJsonName || base === 'models.json.tmp' || base.startsWith('.')
      },
      persistent: true,
      ignoreInitial: true,
      depth: 10,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ...(this.opts.chokidarOptions ?? {}),
    }

    try {
      const w = factory(this.modelsDir, chokidarOpts) as FSWatcherLike & {
        on: (ev: string, cb: (...a: unknown[]) => void) => unknown
      }
      // 绑定事件，均走 debounce scan
      w.on('add', () => this.scheduleScan())
      w.on('change', () => this.scheduleScan())
      w.on('unlink', () => this.scheduleScan())
      w.on('addDir', () => this.scheduleScan())
      w.on('unlinkDir', () => this.scheduleScan())
      // 错误隔离：watcher error 不崩主进程
      w.on('error', (err: unknown) => {
        this.log('warn', `watcher error: ${(err as Error)?.message ?? String(err)}`)
      })
      this.watcher = w
      this.log('log', `watching ${this.modelsDir}`)
    } catch (err) {
      this.log('warn', `startWatch failed: ${(err as Error).message}`)
    }
  }

  async stopWatch(): Promise<void> {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer)
      this.scanTimer = null
    }
    if (this.watcher) {
      try {
        await this.watcher.close()
      } catch (err) {
        this.log('warn', `watcher close failed: ${(err as Error).message}`)
      }
      this.watcher = null
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.stopWatch()
    this.listeners.clear()
  }

  /** 读取已持久化的 models.json（失败隔离：损坏/不存在返回空数组） */
  readPersisted(): ModelEntry[] {
    const fsDeps = this.fs()
    try {
      if (!fsDeps.existsSync(this.modelsJsonPath)) return []
      const raw = fsDeps.readFileSync(this.modelsJsonPath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed as ModelEntry[]
    } catch (err) {
      this.log('warn', `readPersisted corrupted, returning []: ${(err as Error).message}`)
      return []
    }
  }

  // ---- private ----

  private fs(): NonNullable<RegistryOptions['fsDeps']> {
    return (
      this.opts.fsDeps ?? {
        existsSync: fs.existsSync,
        statSync: fs.statSync,
        readdirSync: fs.readdirSync as unknown as typeof fs.readdirSync,
        readFileSync: fs.readFileSync,
        writeFileSync: fs.writeFileSync,
        renameSync: fs.renameSync,
        mkdirSync: fs.mkdirSync,
      }
    )
  }

  private log(level: 'warn' | 'error' | 'log', msg: string): void {
    try {
      const l = this.opts.logger ?? console
      if (level === 'warn') l.warn(`[ModelRegistry] ${msg}`)
      else if (level === 'error') l.error(`[ModelRegistry] ${msg}`)
      else l.log(`[ModelRegistry] ${msg}`)
    } catch {
      // ignore logger failure
    }
  }

  private emit(): void {
    const snapshot = this.getModels()
    for (const cb of [...this.listeners]) {
      try {
        cb(snapshot)
      } catch (err) {
        this.log('warn', `listener threw: ${(err as Error).message}`)
      }
    }
  }

  private scheduleScan(): void {
    if (this.closed) return
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null
      try {
        this.scan()
      } catch (err) {
        this.log('warn', `scheduled scan failed: ${(err as Error).message}`)
      }
    }, 120)
    // 允许进程退出
    if (this.scanTimer && typeof (this.scanTimer as unknown as { unref?: () => void }).unref === 'function') {
      ;(this.scanTimer as unknown as { unref: () => void }).unref!()
    }
  }

  private buildEntry(absPath: string): ModelEntry | null {
    const fsDeps = this.fs()
    let stat: fs.Stats
    try {
      stat = fsDeps.statSync(absPath)
    } catch (err) {
      this.log('warn', `stat failed ${absPath}: ${(err as Error).message}`)
      return null
    }
    if (!stat.isFile()) return null
    // 0 字节文件视为损坏但仍隔离记录（供 UI 提示），此处选择跳过以保持 models.json 干净
    // 若需保留可返回 corrupted；当前策略：0 字节 GGUF/safetensors 视为 corrupted 并跳过
    const size = stat.size
    const mtimeMs = stat.mtimeMs ?? stat.mtime.getTime()
    const rel = path.relative(this.modelsDir, absPath).split(path.sep).join(path.posix.sep)
    const base = path.basename(absPath)
    const nameNoExt = base.replace(/\.[^.]+$/, '')
    // 损坏判定：超小文件（< 1KB）且为 gguf/safetensors，极可能未下载完成或损坏，标记 corrupted 并隔离（不入正常列表）
    // 但为了“失败隔离不崩”且让调用方能看到问题，仍可选择不抛；这里跳过该文件，日志 warn
    if (size < 1024) {
      // 进一步探针：尝试读取前 4 字节 GGUF magic "GGUF"；safetensors 需 JSON 头；失败则隔离
      try {
        const probe = this.probeFileHeader(absPath)
        if (!probe.ok) {
          this.log('warn', `corrupted isolated ${rel} size=${size} reason=${probe.reason}`)
          return null
        }
      } catch (err) {
        this.log('warn', `probe failed ${rel}: ${(err as Error).message}`)
        return null
      }
    }

    const quant = detectQuant(base)
    const arch = detectArch(rel)
    const format = detectFormat(base)
    return {
      name: nameNoExt,
      file: rel,
      path: absPath,
      size,
      quant,
      arch,
      format,
      mtimeMs,
    }
  }

  /** 轻量文件头探针，失败隔离用；不抛错 */
  private probeFileHeader(absPath: string): { ok: boolean; reason?: string } {
    const fsDeps = this.fs()
    const ext = path.extname(absPath).toLowerCase()
    try {
      if (ext === '.gguf') {
        // GGUF magic: 前 4 字节 "GGUF"
        const buf = Buffer.alloc(4)
        void fs // keep import used
        // 若 fsDeps 未提供 openSync/readSync，回退到 readFileSync 切片
        if (typeof (fsDeps as unknown as { openSync?: unknown }).openSync === 'function') {
          const openSync = (fs as unknown as { openSync: typeof fs.openSync }).openSync
          const readSync = (fs as unknown as { readSync: typeof fs.readSync }).readSync
          const closeSync = (fs as unknown as { closeSync: typeof fs.closeSync }).closeSync
          const fdNum = openSync(absPath, 'r')
          try {
            const n = readSync(fdNum, buf, 0, 4, 0)
            if (n < 4) return { ok: false, reason: 'too short for GGUF magic' }
            if (buf.toString('utf-8', 0, 4) !== 'GGUF') return { ok: false, reason: 'bad GGUF magic' }
            return { ok: true }
          } finally {
            try {
              closeSync(fdNum)
            } catch {}
          }
        } else {
          const raw = fsDeps.readFileSync(absPath) as unknown as Buffer
          const b = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as unknown as string)
          if (b.length < 4) return { ok: false, reason: 'too short' }
          if (b.subarray(0, 4).toString('utf-8') !== 'GGUF') return { ok: false, reason: 'bad GGUF magic' }
          return { ok: true }
        }
      }
      if (ext === '.safetensors') {
        // safetensors 头 8 字节为 little-endian JSON 长度；探针仅校验能读取
        const raw = fsDeps.readFileSync(absPath) as unknown as Buffer
        const b = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as unknown as string)
        if (b.length < 8) return { ok: false, reason: 'safetensors too short' }
        // 不严格校验 JSON，避免大文件全量读取；已能读即 ok
        return { ok: true }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }

  private writeModelsJson(): void {
    const fsDeps = this.fs()
    const payload = JSON.stringify(this.models, null, 2)
    const tmp = `${this.modelsJsonPath}.tmp`
    try {
      // 确保目录存在
      const dir = path.dirname(this.modelsJsonPath)
      if (!fsDeps.existsSync(dir)) fsDeps.mkdirSync(dir, { recursive: true })
      fsDeps.writeFileSync(tmp, payload, 'utf-8')
      fsDeps.renameSync(tmp, this.modelsJsonPath)
    } catch (err) {
      this.log('warn', `writeModelsJson atomic failed: ${(err as Error).message}`)
      // 尝试清理 tmp
      try {
        if (fsDeps.existsSync(tmp)) {
          // best-effort unlink via write empty? ignore
        }
      } catch {}
      throw err
    }
  }
}

export default ModelRegistry
