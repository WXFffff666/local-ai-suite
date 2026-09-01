/**
 * hashRouter.ts — todo9 轻量 hash 路由（无第三方 router 依赖）
 * URL 形态：#/chat、#/image、#/gallery、#/search、#/market、#/settings
 * 非法/空 hash 一律回落到默认路由（chat）。
 */
import { useCallback, useEffect, useState } from 'react'

export const ROUTE_IDS = ['chat', 'image', 'gallery', 'search', 'market', 'settings'] as const
export type RouteId = (typeof ROUTE_IDS)[number]

export const DEFAULT_ROUTE: RouteId = 'chat'

export function parseHash(hash: string | null | undefined): RouteId {
  const seg = (hash ?? '').replace(/^#\/?/, '').trim().toLowerCase()
  return (ROUTE_IDS as readonly string[]).includes(seg) ? (seg as RouteId) : DEFAULT_ROUTE
}

export function useHashRoute(): { route: RouteId; navigate: (r: RouteId) => void } {
  const [route, setRoute] = useState<RouteId>(() =>
    typeof window === 'undefined' ? DEFAULT_ROUTE : parseHash(window.location.hash),
  )

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((r: RouteId) => {
    const target = `#/${r}`
    // 同步更新 hash（触发 hashchange 也会幂等 setRoute）
    if (window.location.hash !== target) {
      window.location.hash = target
    }
    setRoute(r)
  }, [])

  return { route, navigate }
}
