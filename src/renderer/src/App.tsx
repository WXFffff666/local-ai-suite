/**
 * App.tsx — todo9 渲染层应用壳
 * 左导航 rail（lucide 图标）+ hash 路由六页（chat/image/gallery/search/market/settings）
 * 面板骨架：react-resizable-panels（nav | content | 右侧详情，默认收起）
 * 主题：next-themes(class 策略, dark 默认) 与既有 src/theme ThemeProvider 单向同步
 * 通知：sonner Toaster 单点挂载，经 preload 白名单事件 'app:notification' 订阅（非 Electron 环境自动跳过）
 * 字体：@fontsource-variable/inter 自托管 —— 运行时零外域请求（离线红线）
 */
import { useEffect } from 'react'
import { ThemeProvider as NextThemeProvider, useTheme as useNextTheme } from 'next-themes'
import { Toaster, toast } from 'sonner'
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels'
import {
  Boxes,
  Image as ImageIcon,
  LayoutGrid,
  MessageSquare,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Store,
  type LucideIcon,
} from 'lucide-react'
import '@fontsource-variable/inter/index.css'
import './App.css'
import { THEME_STORAGE_KEY, useTheme as useSuiteTheme } from '../../theme/theme'
import type { AppNotificationEvent } from '../../main/ipc/whitelist'
// todo38 (ADDITIVE): 'ask:seed' — the screenshot overlay's confirmed crop lands
// as a VLM turn in the main window chat (store send path untouched).
import { useChatStore } from '../../chat/store'
import type { AskSeedEvent, AppDeepLinkEvent } from '../../main/ipc/whitelist'
import { useHashRoute, type RouteId } from './hashRouter'
import ChatPage from './pages/ChatPage'
import ImagePage from './pages/ImagePage'
import GalleryPage from './pages/GalleryPage'
import SearchPage from './pages/SearchPage'
import MarketPage from './pages/MarketPage'
import ModelsPage from './pages/ModelsPage'
import SettingsPage from './pages/SettingsPage'
// todo32: app-level auto-update banner (top-right over the shell; market.css
// download-bar classes reused for its progress line).
import UpdateBanner from './components/updater/UpdateBanner'

const NAV_ITEMS: ReadonlyArray<{ id: RouteId; label: string; icon: LucideIcon }> = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'image', label: 'Image', icon: ImageIcon },
  { id: 'gallery', label: 'Gallery', icon: LayoutGrid },
  { id: 'search', label: 'Search', icon: SearchIcon },
  { id: 'market', label: 'Market', icon: Store },
  { id: 'models', label: 'Models', icon: Boxes },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
]

const PAGES: Record<RouteId, () => React.JSX.Element> = {
  chat: ChatPage,
  image: ImagePage,
  gallery: GalleryPage,
  search: SearchPage,
  market: MarketPage,
  models: ModelsPage,
  settings: SettingsPage,
}

/** 'app:notification' → sonner toast（todo10 端口冲突等持久告警走 persistent）。 */
function showNotification(n: AppNotificationEvent): void {
  const options = {
    description: n.message,
    ...(n.persistent ? { duration: Infinity } : {}),
  }
  if (n.level === 'error') toast.error(n.title, options)
  else if (n.level === 'warning') toast.warning(n.title, options)
  else toast.message(n.title, options)
}

function Shell(): React.JSX.Element {
  const { resolved: suiteResolved, setMode: setSuiteMode } = useSuiteTheme()
  const { theme: ntTheme, resolvedTheme: ntResolved, setTheme: setNtTheme } = useNextTheme()
  const { route, navigate } = useHashRoute()

  // 首启 dark 默认：既有 provider 无持久化记录时写入 dark（其 setMode 负责持久化与 data-theme 应用），
  // 之后主题单一事实源仍是 src/theme ThemeProvider（todo16 设置页将切换语言/主题）。
  useEffect(() => {
    try {
      if (!window.localStorage.getItem(THEME_STORAGE_KEY)) setSuiteMode('dark')
    } catch {
      // 隐私模式 / 非浏览器环境：忽略
    }
  }, [setSuiteMode])

  // 单向同步 suite resolved → next-themes，使 next-themes 的 class 与 sonner 主题保持一致
  useEffect(() => {
    if (ntTheme !== suiteResolved) setNtTheme(suiteResolved)
  }, [suiteResolved, ntTheme, setNtTheme])

  // preload 事件订阅守卫：非 Electron 环境（纯浏览器 / 预览）window.api 不存在时静默跳过
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api) return
    return api.on('app:notification', showNotification)
  }, [])

  // todo38 (ADDITIVE): 截图问屏落点。遮罩窗确认后主进程聚焦本窗并发 'ask:seed'；
  // 切到 chat 路由后直接走 store.send 的 todo21 图文通路（无 window.api 时静默跳过，
  // 与 app:notification 同一守卫姿态）。send 在无会话时自建 session（store 契约）。
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api) return
    return api.on('ask:seed', (e: AskSeedEvent) => {
      navigate('chat')
      void useChatStore.getState().send(e.prompt, undefined, [e.image])
    })
  }, [navigate])

  // todo42 (ADDITIVE): 'app:deeplink' — las:// 深链由主进程解析成封闭 action
  // 后派发（second-instance argv / 首实例启动 argv 双入口）。渲染层只导航：
  // new-chat → 自建会话进 chat 页（store.createSession 契约）；models → 模型页。
  // 类型上 action 已是联合成员，运行时 wire 值不可信 — else 守卫按字符串比对，
  // 未知值忽略 + 诚实 toast（主进程永不发明列表外 action，这是第二道闸）。
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api) return
    return api.on('app:deeplink', (e: AppDeepLinkEvent) => {
      const action = e?.action
      if (action === 'new-chat') {
        useChatStore.getState().createSession()
        navigate('chat')
      } else if (action === 'models') {
        navigate('models')
      } else {
        toast.warning('未知深链', { description: String(action) })
      }
    })
  }, [navigate])

  const Page = PAGES[route]

  return (
    <div className="las-shell">
      <PanelGroup orientation="horizontal" id="las-shell">
        <Panel id="las-nav-panel" minSize={72} maxSize={72} defaultSize={72}>
          <nav className="las-nav" aria-label="Primary navigation">
            <span className="las-nav-brand">LAS</span>
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className="las-nav-item"
                aria-current={route === id ? 'page' : undefined}
                onClick={() => navigate(id)}
              >
                <Icon size={18} aria-hidden="true" />
                <span className="las-nav-label">{label}</span>
              </button>
            ))}
          </nav>
        </Panel>
        <Panel id="las-content">
          <Page />
        </Panel>
        <PanelResizeHandle className="las-resize-handle" />
        <Panel id="las-detail" minSize={240} collapsedSize={0} collapsible defaultSize={0}>
          <aside className="las-detail-panel" aria-label="Detail panel">
            详情面板 — 默认收起，由后续 todo（生图参数 / 会话详情）填充。
          </aside>
        </Panel>
      </PanelGroup>
      <Toaster
        position="bottom-right"
        theme={ntResolved === 'light' ? 'light' : 'dark'}
        closeButton
      />
      {/* todo32: passive auto-update banner (renders nothing until an
          'update:state' event arrives; never dials out from the renderer). */}
      <UpdateBanner />
    </div>
  )
}

function App(): React.JSX.Element {
  return (
    <NextThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <Shell />
    </NextThemeProvider>
  )
}

export default App
