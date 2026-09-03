/**
 * McpSection.tsx — todo40 设置页「MCP 服务器」区（OcrSection 数据流同款）：
 *   mount → mcp:listServers（不 spawn）→ 行渲染（状态徽章 / 工具数 / failed
 *   重启按钮 + last-error tooltip / enable 开关 / 删除）；
 *   新增/编辑 → mcp:upsertServer（args 一行一个、env 一行 KEY=VALUE）；
 *   工具行 → mcp:listTools（惰性启动该 server）→ 每工具「测试」→ mcp:callTool
 *   （走与 agent 相同的权限闸门 —— 弹窗审批会在这里出现，属预期行为）。
 * 'mcp:status' 事件驱动行内状态刷新（SidecarManager terminal-failed 同款语义：
 * 连续 3 次崩溃后 failed，只有重启按钮能清除）。
 */
import { useCallback, useEffect, useState } from 'react'
import type {
  McpCallToolReply,
  McpListServersReply,
  McpListToolsReply,
  McpServerView,
  McpStatusEvent,
  McpToolEntry,
  McpUpsertServerReply,
} from '../../../../main/ipc/whitelist'

const STATE_LABELS: Record<McpServerView['state'], string> = {
  stopped: '停止',
  starting: '启动中',
  running: '运行中',
  backoff: '重连中',
  failed: '失败',
}

type FormState = { name: string; command: string; args: string; env: string; enabled: boolean }
const EMPTY_FORM: FormState = { name: '', command: '', args: '', env: '', enabled: true }

/** 一行一个参数；去空行去首尾空白。 */
export function parseArgsLines(raw: string): string[] {
  return raw.split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

/** KEY=VALUE 行 → Record；坏行直接丢弃（保存前 UI 不做二次校验，主进程 zod 兜底）。 */
export function parseEnvLines(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return env
}

export function McpSection(): React.JSX.Element | null {
  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [note, setNote] = useState<string | null>(null)
  const [toolsByName, setToolsByName] = useState<Record<string, McpToolEntry[] | 'loading'>>({})
  const [callResults, setCallResults] = useState<Record<string, string>>({})

  const fetchServers = useCallback(async (): Promise<void> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return
    try {
      const reply = (await api.invoke('mcp:listServers', {})) as McpListServersReply
      if (reply?.ok === true) {
        setServers(reply.servers)
        setNote(null)
      } else {
        setNote(`MCP 状态读取失败 — ${reply.ok === false ? reply.error : '应答格式异常'}`)
      }
    } catch {
      setNote('mcp:listServers 失败 — MCP 暂不可用')
    }
  }, [])

  useEffect(() => {
    void fetchServers()
  }, [fetchServers])

  // 生命周期事件 → 行内状态即时刷新（终止态 failed 也刷一次列表拿 lastError）
  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return
    return api.on('mcp:status', (ev: McpStatusEvent) => {
      setServers((prev) =>
        prev === null ? prev : prev.map((s) => (s.name === ev.name ? { ...s, state: ev.state, lastError: ev.error ?? s.lastError } : s)),
      )
    })
  }, [])

  const invoke = useCallback(async <T,>(channel: Parameters<NonNullable<typeof window.api>['invoke']>[0], payload: unknown): Promise<T | null> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return null
    try {
      return (await api.invoke(channel, payload)) as T
    } catch {
      return null
    }
  }, [])

  const save = useCallback(async (): Promise<void> => {
    const reply = await invoke<McpUpsertServerReply>('mcp:upsertServer', {
      name: form.name.trim(),
      command: form.command.trim(),
      args: parseArgsLines(form.args),
      env: parseEnvLines(form.env),
      enabled: form.enabled,
    })
    if (reply?.ok === true) {
      setForm(EMPTY_FORM)
      setNote(null)
      void fetchServers()
    } else {
      setNote(`保存失败 — ${reply?.ok === false ? reply.error : '无应答'}`)
    }
  }, [form, invoke, fetchServers])

  const toggleEnabled = useCallback(
    async (s: McpServerView, enabled: boolean): Promise<void> => {
      const reply = await invoke<{ ok: boolean; error?: string }>('mcp:setEnabled', { name: s.name, enabled })
      if (!reply?.ok) setNote(`切换失败 — ${reply?.error ?? '无应答'}`)
      void fetchServers()
    },
    [invoke, fetchServers],
  )

  const remove = useCallback(
    async (s: McpServerView): Promise<void> => {
      const reply = await invoke<{ ok: boolean; error?: string }>('mcp:removeServer', { name: s.name })
      if (!reply?.ok) setNote(`删除失败 — ${reply?.error ?? '无应答'}`)
      else void fetchServers()
    },
    [invoke, fetchServers],
  )

  const restart = useCallback(
    async (s: McpServerView): Promise<void> => {
      const reply = await invoke<{ ok: boolean; error?: string }>('mcp:setEnabled', { name: s.name, enabled: true })
      if (!reply?.ok) setNote(`重启失败 — ${reply?.error ?? '无应答'}`)
      void fetchServers()
    },
    [invoke, fetchServers],
  )

  const showTools = useCallback(
    async (s: McpServerView): Promise<void> => {
      setToolsByName((m) => ({ ...m, [s.name]: 'loading' }))
      const reply = await invoke<McpListToolsReply>('mcp:listTools', { name: s.name })
      if (reply?.ok === true) setToolsByName((m) => ({ ...m, [s.name]: reply.tools }))
      else {
        setToolsByName((m) => {
          const { [s.name]: _drop, ...rest } = m
          void _drop
          return rest
        })
        setNote(`工具列表失败（${s.name}）— ${reply?.ok === false ? reply.error : '无应答'}`)
      }
    },
    [invoke],
  )

  const callTool = useCallback(
    async (s: McpServerView, tool: string): Promise<void> => {
      const key = `${s.name}:${tool}`
      setCallResults((m) => ({ ...m, [key]: '调用中…（可能需要权限确认）' }))
      const reply = await invoke<McpCallToolReply>('mcp:callTool', { name: s.name, tool, args: {} })
      const text =
        reply?.ok === true ? JSON.stringify(reply.result) : reply?.ok === false ? `${reply.error}${reply.detail ? ` — ${reply.detail}` : ''}` : '无应答'
      setCallResults((m) => ({ ...m, [key]: text }))
    },
    [invoke],
  )

  if (servers === null) {
    if (note === null || typeof window === 'undefined' || !window.api) return null
  }
  const list = servers ?? []

  return (
    <section className="las-settings-group" aria-label="MCP 服务器">
      <h2 className="las-settings-group-title">MCP 服务器（stdio · 工具接入 · 权限闸门）</h2>
      {note !== null ? <p className="las-settings-note">{note}</p> : null}
      {list.map((s) => (
        <div key={s.name} className="las-settings-row" data-testid={`mcp-row-${s.name}`}>
          <span className="las-settings-label">{s.name}</span>
          <code className="las-settings-value" title={`${s.command} ${s.args.join(' ')}`.trim()}>
            {s.command}
          </code>
          <span className="las-settings-note" data-testid={`mcp-state-${s.name}`} title={s.lastError ?? undefined}>
            {STATE_LABELS[s.state]}
            {s.envKeys.length > 0 ? ` · env:${s.envKeys.join(',')}` : ''}
          </span>
          <span className="las-settings-pill" data-testid={`mcp-tools-count-${s.name}`}>
            {s.toolCount === null ? '—' : `${s.toolCount} 工具`}
          </span>
          <label>
            启用
            <input
              type="checkbox"
              checked={s.enabled}
              data-testid={`mcp-enabled-${s.name}`}
              onChange={(e) => void toggleEnabled(s, e.target.checked)}
            />
          </label>
          {s.state === 'failed' ? (
            <button type="button" data-testid={`mcp-restart-${s.name}`} title={s.lastError ?? undefined} onClick={() => void restart(s)}>
              重启
            </button>
          ) : null}
          <button type="button" data-testid={`mcp-tools-${s.name}`} onClick={() => void showTools(s)}>
            列工具
          </button>
          <button type="button" data-testid={`mcp-remove-${s.name}`} onClick={() => void remove(s)}>
            删除
          </button>
        </div>
      ))}
      {list.map((s) => {
        const entry = toolsByName[s.name]
        if (!Array.isArray(entry)) return null
        return (
          <div key={`tools-${s.name}`} data-testid={`mcp-toollist-${s.name}`}>
            {entry.map((t) => (
              <div key={t.name} className="las-settings-row">
                <code className="las-settings-value">{t.name}</code>
                <button type="button" data-testid={`mcp-call-${s.name}-${t.name}`} onClick={() => void callTool(s, t.name)}>
                  测试
                </button>
                {callResults[`${s.name}:${t.name}`] !== undefined ? (
                  <span className="las-settings-note" data-testid={`mcp-call-result-${s.name}-${t.name}`}>
                    {callResults[`${s.name}:${t.name}`]}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )
      })}
      <div className="las-settings-row">
        <span className="las-settings-label">添加 / 更新</span>
        <input aria-label="名称" placeholder="name" value={form.name} data-testid="mcp-form-name" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <input aria-label="命令" placeholder="command（如 npx / node）" value={form.command} data-testid="mcp-form-command" onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))} />
      </div>
      <div className="las-settings-row">
        <textarea aria-label="参数" placeholder="args（一行一个）" value={form.args} data-testid="mcp-form-args" onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))} rows={2} />
        <textarea aria-label="环境变量" placeholder="env（一行 KEY=VALUE）" value={form.env} data-testid="mcp-form-env" onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))} rows={2} />
      </div>
      <div className="las-settings-row">
        <label>
          启用
          <input type="checkbox" checked={form.enabled} data-testid="mcp-form-enabled" onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
        </label>
        <button type="button" data-testid="mcp-save" disabled={form.name.trim() === '' || form.command.trim() === ''} onClick={() => void save()}>
          保存服务器
        </button>
      </div>
      <p className="las-settings-note">
        保存即用（enable 时惰性拉起 stdio 子进程）；工具经与文件/命令同一套权限闸门（规则 MCP(server:tool)，弹窗可
        once/session/always 授权）。连续 3 次崩溃后进入「失败」终态，仅重启按钮可恢复。资源（resources）接入在 backlog。
      </p>
    </section>
  )
}

export default McpSection
