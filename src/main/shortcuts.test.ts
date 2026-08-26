import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  GLOBAL_TOGGLE_ACCELERATOR,
  IMAGE_TRIGGER_PREFIX,
  isImageTrigger,
  parseImageTrigger,
  parseChatInput,
  shouldSendOnShortcut,
  shouldTriggerImageOnSlash,
  handleChatKeyDown,
  toggleMainWindow,
  registerGlobalShortcuts,
  unregisterGlobalShortcuts,
  unregisterAllShortcuts,
} from "./shortcuts"

function fakeWin(visible: boolean, opts: { destroyed?: boolean; minimized?: boolean } = {}) {
  const w = {
    isVisible: vi.fn(() => visible),
    isDestroyed: vi.fn(() => !!opts.destroyed),
    isMinimized: vi.fn(() => !!opts.minimized),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
  } as unknown as InstanceType<typeof import("electron").BrowserWindow>
  return w
}

function mockDeps() {
  let registered = new Set<string>()
  let lastCb: (() => void) | null = null
  const gs = {
    register: vi.fn((acc: string, cb: () => void) => {
      registered.add(acc)
      lastCb = cb
      return true
    }),
    unregister: vi.fn((acc: string) => { registered.delete(acc) }),
    isRegistered: vi.fn((acc: string) => registered.has(acc)),
    unregisterAll: vi.fn(() => { registered.clear() }),
    _fire: () => lastCb?.(),
    _registered: () => new Set(registered),
  }
  return gs as unknown as typeof gs & { _fire: () => void; _registered: () => Set<string> }
}

describe("shortcuts — 快捷键 (Wave7 T31)", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("常量：全局 Ctrl+Shift+L + 前缀 /", () => {
    expect(GLOBAL_TOGGLE_ACCELERATOR).toBe("CommandOrControl+Shift+L")
    expect(IMAGE_TRIGGER_PREFIX).toBe("/")
  })

  it("isImageTrigger / parseImageTrigger", () => {
    expect(isImageTrigger("/a cat")).toBe(true)
    expect(isImageTrigger("  /a cat")).toBe(true)
    expect(isImageTrigger("/")).toBe(true)
    expect(isImageTrigger(" / ")).toBe(true)
    expect(isImageTrigger("hello")).toBe(false)
    expect(isImageTrigger("")).toBe(false)
    expect(isImageTrigger("a / cat")).toBe(false)
    expect(parseImageTrigger("/a cat")).toBe("a cat")
    expect(parseImageTrigger("  /  hello world  ")).toBe("hello world")
    expect(parseImageTrigger("/")).toBe("")
    expect(parseImageTrigger("hello")).toBeNull()
  })

  it("parseChatInput 分流 chat / image", () => {
    expect(parseChatInput("/a cat").kind).toBe("image")
    expect((parseChatInput("/a cat") as { prompt: string }).prompt).toBe("a cat")
    expect(parseChatInput("hello").kind).toBe("chat")
    expect(parseChatInput("  /draw me").kind).toBe("image")
  })

  it("shouldSendOnShortcut: Ctrl+Enter / Cmd+Enter 发送，其它不发送", () => {
    expect(shouldSendOnShortcut({ key: "Enter", ctrlKey: true, metaKey: false })).toBe(true)
    expect(shouldSendOnShortcut({ key: "Enter", ctrlKey: false, metaKey: true })).toBe(true)
    expect(shouldSendOnShortcut({ key: "Enter", ctrlKey: true, metaKey: true })).toBe(true)
    expect(shouldSendOnShortcut({ key: "Enter", ctrlKey: false, metaKey: false })).toBe(false)
    expect(shouldSendOnShortcut({ key: "a", ctrlKey: true, metaKey: false })).toBe(false)
    // Shift+Enter 不算
    expect(shouldSendOnShortcut({ key: "Enter", ctrlKey: false, metaKey: false })).toBe(false)
  })

  it("shouldTriggerImageOnSlash", () => {
    expect(shouldTriggerImageOnSlash({ key: "/" }, "")).toBe(true)
    expect(shouldTriggerImageOnSlash({ key: "/" }, "  ")).toBe(true)
    expect(shouldTriggerImageOnSlash({ key: "/" }, "/already")).toBe(true)
    expect(shouldTriggerImageOnSlash({ key: "a" }, "")).toBe(false)
    expect(shouldTriggerImageOnSlash({ key: "/" }, "hello")).toBe(false)
  })

  it("handleChatKeyDown: Ctrl+Enter 调用 onSend + preventDefault", () => {
    const onSend = vi.fn()
    const onImage = vi.fn()
    const preventDefault = vi.fn()
    const handled = handleChatKeyDown({ key: "Enter", ctrlKey: true, metaKey: false, preventDefault }, "", { onSend, onImageTrigger: onImage })
    expect(handled).toBe(true)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onImage).not.toHaveBeenCalled()
  })

  it("handleChatKeyDown: Cmd+Enter 同样发送", () => {
    const onSend = vi.fn()
    handleChatKeyDown({ key: "Enter", ctrlKey: false, metaKey: true }, "hi", { onSend })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it("handleChatKeyDown: '/' 空输入唤起生图", () => {
    const onSend = vi.fn()
    const onImage = vi.fn()
    const handled = handleChatKeyDown({ key: "/", ctrlKey: false, metaKey: false }, "", { onSend, onImageTrigger: onImage })
    expect(handled).toBe(false)
    expect(onImage).toHaveBeenCalledTimes(1)
    expect(onImage).toHaveBeenCalledWith("")
    expect(onSend).not.toHaveBeenCalled()
  })

  it("handleChatKeyDown: '/' 已有前缀也触发", () => {
    const onImage = vi.fn()
    handleChatKeyDown({ key: "/", ctrlKey: false, metaKey: false }, "/", { onSend: vi.fn(), onImageTrigger: onImage })
    // "/" + "/" => "//" 仍以 "/" 开头，会触发
    expect(onImage).toHaveBeenCalled()
  })

  it("toggleMainWindow: 可见->隐藏；隐藏->显示+focus；最小化先 restore", () => {
    const w1 = fakeWin(true)
    toggleMainWindow(() => w1)
    expect(w1.hide).toHaveBeenCalledTimes(1)

    const w2 = fakeWin(false)
    toggleMainWindow(() => w2)
    expect(w2.show).toHaveBeenCalledTimes(1)
    expect(w2.focus).toHaveBeenCalledTimes(1)

    const w3 = fakeWin(false, { minimized: true })
    toggleMainWindow(() => w3)
    expect(w3.restore).toHaveBeenCalledTimes(1)
    expect(w3.show).toHaveBeenCalledTimes(1)

    // destroyed / null 不抛
    const w4 = fakeWin(true, { destroyed: true })
    expect(() => toggleMainWindow(() => w4)).not.toThrow()
    expect(w4.hide).not.toHaveBeenCalled()
    expect(() => toggleMainWindow(() => null)).not.toThrow()
  })

  it("registerGlobalShortcuts 注册 CommandOrControl+Shift+L 并切换窗口", () => {
    const gs = mockDeps()
    const win = fakeWin(false)
    const getWindow = vi.fn(() => win)
    const onToggle = vi.fn()
    const ok = registerGlobalShortcuts({ getWindow, onToggle, deps: { globalShortcut: gs as never, BrowserWindow: {} as never } })
    expect(ok).toBe(true)
    expect(gs.register).toHaveBeenCalledWith(GLOBAL_TOGGLE_ACCELERATOR, expect.any(Function))
    // 触发回调
    gs._fire()
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(win.show).toHaveBeenCalledTimes(1)

    // 再次触发应隐藏
    // fakeWin 的 isVisible 固定 false，改用动态
    let visible = false
    const dynWin = {
      isVisible: vi.fn(() => visible),
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      hide: vi.fn(() => { visible = false }),
      show: vi.fn(() => { visible = true }),
      focus: vi.fn(),
      restore: vi.fn(),
    } as unknown as InstanceType<typeof import("electron").BrowserWindow>
    const gs2 = mockDeps()
    registerGlobalShortcuts({ getWindow: () => dynWin, deps: { globalShortcut: gs2 as never, BrowserWindow: {} as never } })
    gs2._fire() // show
    expect(dynWin.show).toHaveBeenCalledTimes(1)
    visible = true
    gs2._fire() // hide
    expect(dynWin.hide).toHaveBeenCalledTimes(1)
  })

  it("registerGlobalShortcuts 重复注册先 unregister", () => {
    const gs = mockDeps()
    // 预先注册一次
    ;(gs.register as unknown as ReturnType<typeof vi.fn>)("CommandOrControl+Shift+L", () => {})
    expect(gs.isRegistered(GLOBAL_TOGGLE_ACCELERATOR)).toBe(true)
    const win = fakeWin(false)
    registerGlobalShortcuts({ getWindow: () => win, deps: { globalShortcut: gs as never, BrowserWindow: {} as never } })
    expect(gs.unregister).toHaveBeenCalledWith(GLOBAL_TOGGLE_ACCELERATOR)
    expect(gs.register).toHaveBeenCalled()
  })

  it("unregisterGlobalShortcuts / unregisterAllShortcuts", () => {
    const gs = mockDeps()
    gs.register(GLOBAL_TOGGLE_ACCELERATOR, () => {})
    expect(gs.isRegistered(GLOBAL_TOGGLE_ACCELERATOR)).toBe(true)
    unregisterGlobalShortcuts(GLOBAL_TOGGLE_ACCELERATOR, { globalShortcut: gs as never })
    expect(gs.isRegistered(GLOBAL_TOGGLE_ACCELERATOR)).toBe(false)

    gs.register(GLOBAL_TOGGLE_ACCELERATOR, () => {})
    unregisterAllShortcuts({ globalShortcut: gs as never })
    expect(gs.unregisterAll).toHaveBeenCalledTimes(1)
  })

  it("register 失败返回 false 不抛", () => {
    const gs = {
      register: vi.fn(() => { throw new Error("fail") }),
      unregister: vi.fn(),
      isRegistered: vi.fn(() => false),
      unregisterAll: vi.fn(),
    } as unknown as never
    const ok = registerGlobalShortcuts({ getWindow: () => null, deps: { globalShortcut: gs as never, BrowserWindow: {} as never } })
    expect(ok).toBe(false)
  })
})
