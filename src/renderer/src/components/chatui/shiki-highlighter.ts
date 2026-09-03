/**
 * shiki-highlighter.ts — todo15 代码块高亮（离线红线）
 * shiki 细粒度 core + JavaScript regex engine：无 Oniguruma WASM、无 CDN、
 * 语法/主题全部来自 @shikijs/langs / @shikijs/themes 的本地 JSON，按需动态 import
 * （Vite 构建期打成 renderer chunk，运行时零网络）。
 * 失败语义：任何一步抛错 → 返回 null，由 CodeBlock 降级为纯文本 <pre>。
 */
import type { HighlighterCore, LanguageRegistration } from 'shiki'

/** 语言别名 → 规范 id（仅映射 LANGUAGE_LOADERS 支持的语言） */
export const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  golang: 'go',
  sh: 'shell',
  zsh: 'shell',
  console: 'shell',
  ps1: 'powershell',
  'c++': 'cpp',
  yml: 'yaml',
  docker: 'dockerfile',
  md: 'markdown',
  mdx: 'markdown',
  plaintext: 'text',
}

/** 可高亮语言 → 惰性语法加载器（新增语言只需在此登记一行） */
export const LANGUAGE_LOADERS: Readonly<Record<string, () => Promise<{ default: LanguageRegistration[] }>>> = {
  bash: () => import('@shikijs/langs/bash'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsx: () => import('@shikijs/langs/jsx'),
  markdown: () => import('@shikijs/langs/markdown'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  shell: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
}

/** 归一化 info-string → 可加载语言 id；'text' 为 shiki 内建特例；未知返回 null */
export function resolveLanguageId(info: string | undefined | null): string | null {
  if (!info) return null
  const raw = info.trim().toLowerCase()
  if (!raw) return null
  const id = LANGUAGE_ALIASES[raw] ?? raw
  if (id === 'text') return 'text'
  return id in LANGUAGE_LOADERS ? id : null
}

const THEME_NAME = 'github-dark'

let highlighterPromise: Promise<HighlighterCore> | null = null
const loadedLanguages = new Set<string>()

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    const build = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('@shikijs/themes/github-dark'),
      ])
      return createHighlighterCore({
        themes: [theme.default ?? theme],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      })
    })()
    highlighterPromise = build
    build.catch(() => {
      // 构建失败允许下次重试（否则单次网络外故障会永久毒化单例）
      highlighterPromise = null
    })
  }
  return highlighterPromise
}

/**
 * 高亮一段代码为 HTML 字符串（<pre class="shiki ...">）。
 * 语言不可知 / 引擎不可用 / 任何异常 → null，调用方降级纯文本。
 * 返回的 HTML 由 shiki 自身做实体转义，token 内容不可能形成可执行节点。
 */
export async function highlightToHtml(code: string, info: string | undefined): Promise<string | null> {
  const id = resolveLanguageId(info)
  if (!id) return null
  try {
    const highlighter = await getHighlighter()
    if (id !== 'text' && !loadedLanguages.has(id)) {
      await highlighter.loadLanguage((await LANGUAGE_LOADERS[id]()).default)
      loadedLanguages.add(id)
    }
    return highlighter.codeToHtml(code, { lang: id, theme: THEME_NAME })
  } catch {
    return null
  }
}

/** 仅供测试：单例与语言缓存不可跨用例泄漏时重置 */
export function __resetHighlighterForTests(): void {
  highlighterPromise = null
  loadedLanguages.clear()
}
