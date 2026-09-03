/**
 * SettingsPage.tsx — todo16 设置页实装（替换占位）
 *
 * 不复用 src/settings/settings.tsx 的 SettingsPage：该组件直连 fs/path 读写
 * settings.json，而渲染层 sandbox:true 无文件系统 —— 契约要求「经 IPC 通道」。
 * 本页走 config:get / config:set + secrets:encrypt / secrets:decrypt（safeStorage
 * enc:v1: 流程在主进程完成，见 src/main/ipc/secrets.ts 与 docs/SECURITY.md）。
 *
 * 覆盖：HF Token + 3 云搜索密钥（掩码回显 ab****yz，编辑保存即加密落盘）、
 * 主题 / 语言（config.json 持久化 + 会话内 ThemeProvider 即时生效）、
 * apiPort 与模型目录只读展示（目录切换归 Models 页 models:setDir）。
 */
import { useCallback, useEffect, useState } from 'react'
import '../components/settingspage/settingspage.css'
import { EngineStatus } from '../components/settingspage/EngineStatus'
import { SpeechSection } from '../components/settingspage/SpeechSection'
import { SecretRow } from '../components/settingspage/SecretRow'
import type {
  ConfigGetReply,
  ConfigSetReply,
  DecryptReply,
  EncryptReply,
  LocaleChoice,
  SecretFieldName,
  ThemeChoice,
  WireConfig,
} from '../components/settingspage/types'
import { SUPPORTED_MODES, type ThemeMode, useTheme } from '../../../theme/theme'
import { SUPPORTED_LOCALES, type Locale } from '../../../theme/i18n'

const SECRET_FIELDS: ReadonlyArray<{ name: SecretFieldName; label: string; hint?: string; placeholder?: string }> = [
  { name: 'hfToken', label: 'Hugging Face Token', hint: '私有/限速模型下载用，仅本机安全存储，不落明文', placeholder: 'hf_...' },
  { name: 'tavilyApiKey', label: 'Tavily API Key', hint: '留空则该搜索提供方在搜索页隐藏', placeholder: 'tvly-...' },
  { name: 'exaApiKey', label: 'Exa API Key', placeholder: 'exa_...' },
  { name: 'braveApiKey', label: 'Brave API Key', placeholder: 'BSA...' },
]

/** 最小 config 快照（window.api 缺失时全走默认展示，不崩页面）。 */
const EMPTY_CONFIG: WireConfig = {
  theme: 'system',
  locale: 'zh-CN',
  modelsDir: '',
  openaiPort: 11434,
  secrets: {},
}

export function SettingsPage(): React.JSX.Element {
  const [config, setConfig] = useState<WireConfig>(EMPTY_CONFIG)
  const [apiAvailable, setApiAvailable] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const { setMode, setLocale } = useTheme()

  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) {
      setApiAvailable(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const reply = (await api.invoke('config:get')) as ConfigGetReply
        if (!cancelled && reply?.ok !== false && reply.config) setConfig({ ...EMPTY_CONFIG, ...reply.config })
      } catch {
        if (!cancelled) setMsg('config:get 失败 — 显示默认值')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const persist = useCallback(
    async (patch: Record<string, unknown>): Promise<ConfigSetReply | null> => {
      const api = typeof window === 'undefined' ? undefined : window.api
      if (!api) return null
      const reply = (await api.invoke('config:set', patch)) as ConfigSetReply
      if (reply?.ok !== false && reply.config) {
        setConfig(reply.config)
        setMsg(null)
      } else {
        setMsg('config:set 被拒绝 — 检查输入')
      }
      return reply
    },
    [],
  )

  const chooseTheme = (mode: ThemeChoice): void => {
    setMode(mode as ThemeMode) // 会话内即时生效（theme.tsx 持久化 localStorage）
    void persist({ theme: mode }).catch(() => setMsg('主题持久化失败（config:set）'))
  }

  const chooseLocale = (locale: LocaleChoice): void => {
    setLocale(locale as Locale)
    void persist({ locale }).catch(() => setMsg('语言持久化失败（config:set）'))
  }

  const decrypt = useCallback(async (payload: string): Promise<string | null> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return null
    try {
      const reply = (await api.invoke('secrets:decrypt', payload)) as DecryptReply
      return reply?.ok && typeof reply.value === 'string' ? reply.value : null
    } catch {
      return null
    }
  }, [])

  const makeCommit = useCallback(
    (field: SecretFieldName) => async (plain: string): Promise<{ ok: boolean; warning?: string }> => {
      const api = typeof window === 'undefined' ? undefined : window.api
      if (!api) return { ok: false }
      try {
        // 空串 = 清除；否则先 secrets:encrypt（主进程 safeStorage）再 config:set 载荷
        if (plain === '') {
          const saved = await persist({ secrets: { [field]: '' } })
          return { ok: saved !== null && saved?.ok !== false }
        }
        const enc = (await api.invoke('secrets:encrypt', plain)) as EncryptReply
        if (!enc?.ok || typeof enc.value !== 'string') return { ok: false }
        const nextSecrets = { ...config.secrets, [field]: enc.value }
        const saved = await persist({ secrets: nextSecrets })
        return { ok: saved !== null && saved?.ok !== false, ...(enc.warning ? { warning: enc.warning } : {}) }
      } catch {
        return { ok: false }
      }
    },
    [config.secrets, persist],
  )

  return (
    <section className="las-page" aria-labelledby="page-title-settings">
      <h1 id="page-title-settings" className="las-page-title">
        Settings
      </h1>
      <p className="las-page-subtitle">密钥 / 主题 / 语言 / 端口 — 密钥经 safeStorage 加密落盘，明文永不写盘（docs/SECURITY.md）</p>
      {!apiAvailable ? (
        <p className="las-settings-warn" role="alert">
          未检测到 window.api — 设置仅在 Electron 主窗口内可保存，当前展示默认值。
        </p>
      ) : null}
      {msg ? (
        <p className="las-settings-warn" role="alert">
          {msg}
        </p>
      ) : null}

      <section className="las-settings-group" aria-label="外观">
        <h2 className="las-settings-group-title">外观与语言</h2>
        <div className="las-settings-row">
          <span className="las-settings-label">主题</span>
          <div className="las-settings-pills" role="radiogroup" aria-label="主题">
            {SUPPORTED_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={config.theme === m}
                className={`las-settings-pill${config.theme === m ? ' las-settings-pill-on' : ''}`}
                onClick={() => chooseTheme(m)}
              >
                {m === 'system' ? '跟随系统' : m === 'dark' ? '深色' : '浅色'}
              </button>
            ))}
          </div>
        </div>
        <div className="las-settings-row">
          <span className="las-settings-label">语言</span>
          <div className="las-settings-pills" role="radiogroup" aria-label="语言">
            {SUPPORTED_LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={config.locale === l}
                className={`las-settings-pill${config.locale === l ? ' las-settings-pill-on' : ''}`}
                onClick={() => chooseLocale(l)}
              >
                {l === 'zh-CN' ? '简体中文' : 'English'}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="las-settings-group" aria-label="密钥">
        <h2 className="las-settings-group-title">密钥（safeStorage 加密）</h2>
        {SECRET_FIELDS.map((f) => (
          <SecretRow
            key={f.name}
            label={f.label}
            hint={f.hint}
            placeholder={f.placeholder}
            payload={config.secrets?.[f.name] ?? ''}
            decrypt={decrypt}
            commit={makeCommit(f.name)}
          />
        ))}
      </section>

      <section className="las-settings-group" aria-label="服务">
        <h2 className="las-settings-group-title">服务（只读）</h2>
        <div className="las-settings-row">
          <span className="las-settings-label">API 端口（127.0.0.1）</span>
          <code className="las-settings-value">{config.openaiPort}</code>
        </div>
        <div className="las-settings-row">
          <span className="las-settings-label">模型目录</span>
          <code className="las-settings-value">{config.modelsDir || 'models（默认）'}</code>
        </div>
        <p className="las-settings-note">端口固定 11434 保证（冲突时提示，不换口）；模型目录在 Models 页切换。</p>
      </section>

      {/* todo30b — 引擎可用性矩阵 / NVIDIA 检测 / GPU 包下载（engines:* 通道） */}
      <EngineStatus />

      {/* todo36 — 语音输入开关 / Whisper 模型选择 / 引擎来源行（speech:* 通道） */}
      <SpeechSection />
    </section>
  )
}

export default SettingsPage
