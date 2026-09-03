// @vitest-environment jsdom
/**
 * SettingsPage.test.tsx — todo16 设置页组件测试（约定同 App.test.tsx：
 * per-file jsdom + react act + createRoot + fake window.api；ThemeProvider
 * 包裹提供 useTheme 上下文）。
 * 覆盖计划验收：保存 hfToken 后落盘值为 enc:v1: 前缀（safeStorage mock 在
 * main 侧 handlers.test.ts + secrets.test.ts，本页只锁 IPC 契约）、掩码回显
 * ab****yz、isEncryptionAvailable=false → enc:fallback:v1: + 告警条、
 * 主题/语言经 config:set 持久化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SettingsPage } from './SettingsPage'
import { ThemeProvider } from '../../../theme/theme'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function setFakeApi(api: unknown): void {
  ;(window as unknown as { api: unknown }).api = api
}

type FakeApiOpts = {
  /** secrets:encrypt 应答（默认模拟 safeStorage 可用）。 */
  encryptReply?: { ok: boolean; value?: string; warning?: string }
}

function makeFakeApi(opts: FakeApiOpts = {}) {
  const persisted: Record<string, unknown> = {
    theme: 'system',
    locale: 'zh-CN',
    modelsDir: 'models',
    openaiPort: 11434,
    secrets: { hfToken: 'enc:v1:QUJD' },
  }
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    if (channel === 'config:get') return { ok: true, config: persisted }
    if (channel === 'config:set') {
      const patch = payload as { secrets?: Record<string, string> } & Record<string, unknown>
      if (patch.secrets) {
        persisted.secrets = { ...(persisted.secrets as Record<string, string>), ...patch.secrets }
      }
      for (const k of ['theme', 'locale'] as const) {
        if (patch[k] !== undefined) persisted[k] = patch[k]
      }
      return { ok: true, config: { ...persisted } }
    }
    if (channel === 'secrets:encrypt') {
      return (
        opts.encryptReply ?? {
          ok: true,
          value: `enc:v1:${btoa(String(payload))}`,
        }
      )
    }
    if (channel === 'secrets:decrypt') {
      // fixture 载荷 enc:v1:QUJD → "ab12yz"（掩码后 ab****yz）；
      // 其余 enc:v1: 载荷按 base64 往返，模拟 safeStorage 解密。
      if (payload === 'enc:v1:QUJD') return { ok: true, value: 'ab12yz' }
      if (typeof payload === 'string' && payload.startsWith('enc:v1:')) {
        try {
          return { ok: true, value: atob(payload.slice('enc:v1:'.length)) }
        } catch {
          /* fallthrough */
        }
      }
      return { ok: false, error: 'bad-payload' }
    }
    throw new Error(`unexpected channel: ${channel}`)
  })
  // todo30b: EngineStatus 子区订阅事件通道 — no-op 桩（engines:* 的 invoke
  // 在 EngineStatus 内部 catch，渲染降级条，不影响本页断言）。
  const api = { invoke, on: vi.fn(() => () => undefined) }
  return { api, invoke, persisted }
}

let container: HTMLDivElement
let root: Root

function flush(): Promise<unknown> {
  return new Promise((r) => setTimeout(r, 0))
}

async function mount(api?: ReturnType<typeof makeFakeApi>): Promise<void> {
  if (api) setFakeApi(api.api)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const tree: ReactNode = (
    <ThemeProvider>
      <SettingsPage />
    </ThemeProvider>
  )
  await act(async () => {
    root.render(tree)
    await flush() // config:get 初值
  })
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

/** 第 n 个密钥行（顺序 = SECRET_FIELDS：hfToken/tavily/exa/brave）。 */
function secretRow(i: number): HTMLElement {
  const row = container.querySelectorAll<HTMLElement>('.las-setting-secret')[i]
  if (!row) throw new Error(`secret row ${i} not found`)
  return row
}

async function editSecret(row: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    row.querySelector<HTMLButtonElement>('button.las-setting-secret-edit-btn')!.click()
  })
  await act(async () => {
    const input = row.querySelector<HTMLInputElement>('input.las-setting-secret-input')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    row.querySelector<HTMLButtonElement>('button.las-setting-secret-save')!.click()
    await flush()
  })
}

beforeEach(() => {
  setFakeApi(undefined)
})

afterEach(() => {
  unmount()
  setFakeApi(undefined)
  vi.restoreAllMocks()
})

describe('SettingsPage 密钥（todo16 验收）', () => {
  it('已配置密钥 → decrypt 后掩码回显 ab****yz（明文不出 DOM）', async () => {
    await mount(makeFakeApi())
    const hf = secretRow(0)
    expect(hf.querySelector<HTMLElement>('.las-setting-secret-mask')?.textContent).toBe('ab****yz')
    expect(hf.textContent).not.toContain('ab12yz')
  })

  it('保存 hfToken → secrets:encrypt 先行，config:set 落盘值为 enc:v1: 前缀（明文不上盘）', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    await editSecret(secretRow(0), 'hf_newsecret')

    expect(fake.invoke).toHaveBeenCalledWith('secrets:encrypt', 'hf_newsecret')
    const setCall = fake.invoke.mock.calls.find((c) => c[0] === 'config:set')
    expect(setCall).toBeDefined()
    const secrets = (setCall![1] as { secrets: Record<string, string> }).secrets
    expect(secrets.hfToken.startsWith('enc:v1:')).toBe(true)
    expect(secrets.hfToken).not.toContain('hf_newsecret')
    // 落盘后回显刷新为掩码
    expect(secretRow(0).textContent).toContain('****')
  })

  it('safeStorage 不可用 → enc:fallback:v1: 载荷 + 降级告警条（failure QA）', async () => {
    const fake = makeFakeApi({
      encryptReply: { ok: true, value: 'enc:fallback:v1:aGZfeA==', warning: 'os-storage-unavailable' },
    })
    await mount(fake)
    await editSecret(secretRow(0), 'hf_x')
    const setCall = fake.invoke.mock.calls.find((c) => c[0] === 'config:set')
    const secrets = (setCall![1] as { secrets: Record<string, string> }).secrets
    expect(secrets.hfToken).toBe('enc:fallback:v1:aGZfeA==')
    const warn = secretRow(0).querySelector<HTMLElement>('.las-setting-secret-warning')
    expect(warn?.textContent).toContain('可逆')
  })

  it('留空保存 = 清除：config:set 该字段为明文空串（无 enc: 前缀违规）', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    await editSecret(secretRow(0), '')
    const setCall = fake.invoke.mock.calls.find((c) => c[0] === 'config:set')
    expect((setCall![1] as { secrets: Record<string, string> }).secrets.hfToken).toBe('')
  })
})

describe('SettingsPage 主题/语言持久化', () => {
  it('点主题「深色」→ config:set {theme:dark} 且 radio aria-checked 迁移', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    const darkPill = Array.from(container.querySelectorAll<HTMLElement>('button[role="radio"]')).find(
      (b) => b.textContent === '深色',
    )!
    await act(async () => {
      darkPill.click()
      await flush()
    })
    expect(fake.invoke).toHaveBeenCalledWith('config:set', { theme: 'dark' })
    expect(darkPill.getAttribute('aria-checked')).toBe('true')
  })

  it('点语言「English」→ config:set {locale:en}', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    const enPill = Array.from(container.querySelectorAll<HTMLElement>('button[role="radio"]')).find(
      (b) => b.textContent === 'English',
    )!
    await act(async () => {
      enPill.click()
      await flush()
    })
    expect(fake.invoke).toHaveBeenCalledWith('config:set', { locale: 'en' })
  })

  it('window.api 缺席 → 告警条 + 默认值展示，不崩', async () => {
    await mount()
    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toContain('window.api')
  })
})
