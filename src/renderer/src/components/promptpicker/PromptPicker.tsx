/**
 * PromptPicker（阶段2）— 织词提示词库选择器：像 prompt-weaver 一样手动
 * 点选标签/预设/角色组装提示词，与 AI 润色可叠加。
 *
 * 数据全部来自 src/shared/prompt-data（dynamic import 惰性分包）；
 * 无 window.api 也可用（纯渲染层）。限制级内容默认隐藏，需显式勾选。
 */
import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import {
  characterToPrompt,
  loadCharacters,
  loadPresets,
  loadTagCategory,
  searchCharacters,
  searchPresets,
  searchTags,
  TAG_CATEGORIES,
  type CharacterItem,
  type PresetItem,
  type TagItem,
} from '../../../../shared/promptLibrary'
import './promptpicker.css'

export type PromptPickerProps = {
  open: boolean
  onClose: () => void
  /** 点击标签/预设/角色 → 追加片段（逗号拼接由调用方处理） */
  onInsert: (snippet: string) => void
}

type Tab = 'tags' | 'presets' | 'characters'

export function PromptPicker({ open, onClose, onInsert }: PromptPickerProps): React.JSX.Element | null {
  const [tab, setTab] = useState<Tab>('tags')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('quality')
  const [includeNsfw, setIncludeNsfw] = useState(false)
  const [tags, setTags] = useState<TagItem[]>([])
  const [presets, setPresets] = useState<PresetItem[]>([])
  const [characters, setCharacters] = useState<CharacterItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        if (tab === 'tags') {
          const items = await loadTagCategory(category)
          if (!cancelled) setTags(items)
        } else if (tab === 'presets') {
          const items = await loadPresets(includeNsfw)
          if (!cancelled) setPresets(items)
        } else {
          const items = await loadCharacters()
          if (!cancelled) setCharacters(items)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, tab, category, includeNsfw])

  const results = useMemo(() => {
    if (tab === 'tags') return { kind: 'tags' as const, items: searchTags(tags, query) }
    if (tab === 'presets') return { kind: 'presets' as const, items: searchPresets(presets, query) }
    return { kind: 'characters' as const, items: searchCharacters(characters, query) }
  }, [tab, tags, presets, characters, query])

  if (!open) return null

  const insert = (snippet: string): void => {
    if (snippet.trim() !== '') onInsert(snippet.trim())
  }

  return (
    <div className="las-pp-backdrop" onClick={onClose} data-testid="prompt-picker">
      <div className="las-pp-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="提示词库">
        <div className="las-pp-head">
          <div className="las-pp-tabs">
            {(
              [
                ['tags', '标签'],
                ['presets', '预设'],
                ['characters', '角色'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={tab === id ? 'las-pp-tab active' : 'las-pp-tab'} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          <input
            className="las-pp-search"
            placeholder="搜索（中文/英文）…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="pp-search"
          />
          <button className="las-pp-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        {tab === 'tags' ? (
          <div className="las-pp-cats">
            {TAG_CATEGORIES.filter((c) => includeNsfw || c.id !== 'nsfw').map((c) => (
              <button key={c.id} className={category === c.id ? 'las-pp-cat active' : 'las-pp-cat'} onClick={() => setCategory(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        ) : null}

        {tab === 'presets' ? (
          <label className="las-pp-nsfw-toggle">
            <input type="checkbox" checked={includeNsfw} onChange={(e) => setIncludeNsfw(e.target.checked)} />
            显示限制级预设
          </label>
        ) : null}

        <div className="las-pp-body">
          {loading ? <p className="las-pp-loading">加载中…</p> : null}
          {!loading && results.items.length === 0 ? <p className="las-pp-loading">没有匹配的条目</p> : null}
          {results.kind === 'tags' && !loading
            ? results.items.map((t) => (
                <button key={`${t.en}`} className="las-pp-tag" title={t.en} onClick={() => insert(t.en)}>
                  <span className="las-pp-tag-zh">{t.zh}</span>
                  <span className="las-pp-tag-en">{t.en}</span>
                </button>
              ))
            : null}
          {results.kind === 'presets' && !loading
            ? results.items.map((p) => (
                <button key={p.id} className="las-pp-preset" onClick={() => insert(p.prompt)}>
                  <strong>{p.name}</strong>
                  <span className="las-pp-preset-desc">{p.desc}</span>
                  <span className="las-pp-preset-tags">{p.tags.slice(0, 8).join(', ')}</span>
                </button>
              ))
            : null}
          {results.kind === 'characters' && !loading
            ? results.items.map((c) => (
                <button key={c.id} className="las-pp-preset" onClick={() => insert(characterToPrompt(c))}>
                  <strong>
                    {c.zhName ?? c.enName}
                    {c.zhName !== undefined && c.zhName !== c.enName ? <span className="las-pp-tag-en"> {c.enName}</span> : null}
                  </strong>
                  <span className="las-pp-preset-desc">{c.media ?? '—'}</span>
                </button>
              ))
            : null}
        </div>
      </div>
    </div>
  )
}

export default PromptPicker
