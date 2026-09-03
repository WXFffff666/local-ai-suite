/**
 * todo25 — global permission approval dialog (renderer half of the human-
 * in-the-loop bridge). Mount once at App level (todo29 wires the provider
 * surface + main-side bridge); renders nothing outside Electron (no
 * window.api) and nothing while the queue is empty.
 *
 * Posture (plan Must: 默认 ask、无跳过确认总开关 / OWASP LLM06):
 *   - exactly four scoped outcomes — 本次允许 (once) / 本会话允许 (session) /
 *     始终允许 (always) / 拒绝 (deny). There is deliberately NO "auto-approve
 *     everything" control anywhere in this component.
 *   - Esc = deny; the deny button is autofocused so an accidental Enter
 *     cannot grant anything.
 *   - the countdown is VISUAL only — the authoritative 120 s auto-deny lives
 *     in permissionBridge.ts; a response to an already-expired request comes
 *     back unknown-request and just closes the dialog.
 *   - diff preview renders through the local pure diffLines util (no jsdiff
 *     import this round); >300-line sides fall back to a raw old/new view.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { toast } from 'sonner'
import { FileCode2, Globe, ShieldQuestion, SquareTerminal } from 'lucide-react'
import type {
  PermissionActionWire,
  PermissionGrantChoice,
  PermissionPreview,
  PermissionRequestEvent
} from '../../../../main/ipc/whitelist'
import { diffLines, MAX_DIFF_LINES } from './diffLines'
import { KIND_LABELS, grantRuleText, targetValue } from './permissionDisplay'
import './permission.css'

/** Structural slice of the preload surface this host needs (guarded at runtime). */
type PermissionApi = {
  on: (channel: 'permission:request', listener: (payload: PermissionRequestEvent) => void) => () => void
  invoke: (channel: 'permission:respond', args: { requestId: string; choice: PermissionGrantChoice }) => Promise<unknown>
}

function getApi(): PermissionApi | null {
  if (typeof window === 'undefined') return null
  const raw = (window as unknown as { api?: Partial<PermissionApi> }).api
  if (!raw?.on || !raw?.invoke) return null
  return raw as PermissionApi
}

function summaryText(event: PermissionRequestEvent): string {
  return `${KIND_LABELS[event.action.type]}：${targetValue(event.action)}`
}

function ruleLineText(event: PermissionRequestEvent): string {
  const grant = grantRuleText(event.action)
  return event.assessment.rule
    ? `命中规则：${event.assessment.rule}（决策 ${event.assessment.decision}）；「始终允许」将保存：${grant}`
    : `未命中任何规则 → 默认询问；「始终允许」将保存：${grant}`
}

function KindIcon({ type }: { type: PermissionActionWire['type'] }): ReactElement {
  const props = { size: 18, 'aria-hidden': true } as const
  if (type === 'fs.shell') return <SquareTerminal {...props} />
  if (type === 'net') return <Globe {...props} />
  if (type === 'fs.read' || type === 'fs.write') return <FileCode2 {...props} />
  return <ShieldQuestion {...props} />
}

function DiffPreview({
  preview,
  rule
}: {
  preview: Extract<PermissionPreview, { kind: 'diff' }>
  rule: ReactElement
}): ReactElement {
  const diff = diffLines(preview.oldText, preview.newText)
  if (diff.tooLarge) {
    return (
      <div className="perm-raw" data-testid="permission-raw">
        <div className="perm-raw-note">差异超过 {MAX_DIFF_LINES} 行安全阈值 — 以下为原文（旧 / 新）</div>
        <pre className="perm-raw-old">{preview.oldText}</pre>
        <pre className="perm-raw-new">{preview.newText}</pre>
        {rule}
      </div>
    )
  }
  return (
    <div className="perm-diff" data-testid="permission-diff">
      <div className="perm-file">{preview.path}</div>
      {diff.lines.map((line, idx) => (
        <div key={idx} className={`diff-line diff-${line.type}`}>
          {line.text}
        </div>
      ))}
      {rule}
    </div>
  )
}

function CommandPreview({
  preview,
  rule
}: {
  preview: Extract<PermissionPreview, { kind: 'command' }>
  rule: ReactElement
}): ReactElement {
  return (
    <div className="perm-code" data-testid="permission-command">
      <pre>{preview.cmd}</pre>
      {preview.cwd !== undefined && <div data-testid="permission-cwd">工作目录：{preview.cwd}</div>}
      {rule}
    </div>
  )
}

function NetPreview({
  preview,
  rule
}: {
  preview: Extract<PermissionPreview, { kind: 'net' }>
  rule: ReactElement
}): ReactElement {
  return (
    <div className="perm-code" data-testid="permission-net">
      <pre>{preview.path ? `${preview.host}${preview.path}` : preview.host}</pre>
      {rule}
    </div>
  )
}

const CHOICE_BUTTONS: ReadonlyArray<readonly [label: string, choice: PermissionGrantChoice]> = [
  ['本次允许', 'once'],
  ['本会话允许', 'session'],
  ['始终允许', 'always'],
  ['拒绝', 'deny']
]

export default function PermissionDialogHost(): ReactElement | null {
  const [queue, setQueue] = useState<PermissionRequestEvent[]>([])
  const [now, setNow] = useState((): number => Date.now())
  const [api] = useState(getApi)
  const denyRef = useRef<HTMLButtonElement>(null)
  /** requestIds with an in-flight respond (double-click guard). */
  const inFlight = useRef<Set<string>>(new Set())
  const current = queue[0] ?? null
  const currentId = current?.requestId

  useEffect(() => {
    if (!api) return undefined
    return api.on('permission:request', (payload) => {
      setQueue((q) => (q.some((r) => r.requestId === payload.requestId) ? q : [...q, payload]))
    })
  }, [api])

  // countdown tick only while a dialog is open (visual-only, never decides)
  useEffect(() => {
    if (currentId === undefined) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [currentId])

  const respond = useCallback(
    (request: PermissionRequestEvent | null, choice: PermissionGrantChoice): void => {
      if (!request || !api) return
      if (inFlight.current.has(request.requestId)) return
      inFlight.current.add(request.requestId)
      const drop = (stale: boolean): void => {
        inFlight.current.delete(request.requestId)
        setQueue((q) => q.filter((r) => r.requestId !== request.requestId))
        if (stale) toast.error('该审批已失效（超时或会话已中止），操作未执行。')
        else if (choice === 'deny') toast.info(`已拒绝：${summaryText(request)}`)
      }
      api
        .invoke('permission:respond', { requestId: request.requestId, choice })
        .then((reply) => {
          const ok = typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === true
          drop(!ok)
        })
        .catch(() => drop(true))
    },
    [api]
  )

  // focus + Esc while a request is displayed
  useEffect(() => {
    if (currentId === undefined || !current) return undefined
    denyRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        respond(current, 'deny')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentId, current, respond])

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const focusables = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  if (!api || !current) return null

  const remaining = Math.max(0, Math.ceil((current.requestedAt + current.timeoutMs - now) / 1000))

  return (
    <div
      className="perm-overlay"
      data-testid="permission-dialog"
      data-request-id={current.requestId}
      role="dialog"
      aria-modal="true"
      aria-label="权限审批"
      onKeyDown={onDialogKeyDown}
    >
      <div className="perm-panel">
        <header className="perm-header">
          <span className="perm-kind-icon">
            <KindIcon type={current.action.type} />
          </span>
          <span className="perm-summary" data-testid="permission-summary">
            {summaryText(current)}
          </span>
          <span className="perm-countdown" data-testid="permission-countdown">
            {remaining}s
          </span>
        </header>
        <div className="perm-preview">
          {(() => {
            const rule = <div className="diff-rule">{ruleLineText(current)}</div>
            if (current.preview.kind === 'diff') return <DiffPreview preview={current.preview} rule={rule} />
            if (current.preview.kind === 'command') return <CommandPreview preview={current.preview} rule={rule} />
            return <NetPreview preview={current.preview} rule={rule} />
          })()}
        </div>
        <footer className="perm-actions">
          {CHOICE_BUTTONS.map(([label, choice]) => (
            <button
              key={choice}
              type="button"
              className={choice === 'deny' ? 'perm-btn perm-btn-deny' : 'perm-btn'}
              ref={choice === 'deny' ? denyRef : undefined}
              onClick={() => respond(current, choice)}
            >
              {label}
            </button>
          ))}
        </footer>
      </div>
    </div>
  )
}
