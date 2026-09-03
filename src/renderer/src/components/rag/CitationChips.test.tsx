// @vitest-environment jsdom
/**
 * CitationChips.test.tsx — todo39 [n] 角标点击定位 dialog（compact/cards 两形态）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CitationChips } from './CitationChips'
import type { RagCitation } from '../../../../main/ipc/whitelist'

;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function cite(n: number, over: Partial<RagCitation> = {}): RagCitation {
  return {
    n,
    chunkId: `c${n}`,
    source: `D:/docs/doc${n}.md`,
    page: n,
    line: 2,
    charOffset: 5,
    snippet: `text ${n}`,
    rrf: 0.03,
    ranks: { bm25: n, vector: n },
    ...over,
  }
}

let container: HTMLDivElement
let root: Root

async function mount(el: React.JSX.Element): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(el))
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('CitationChips', () => {
  it('空引用集渲染为 null', async () => {
    await mount(<CitationChips citations={[]} />)
    expect(container.querySelector('[data-testid="citation-chips"]')).toBeNull()
  })

  it('compact 形态渲染 [n] 角标 + basename；点击打开 dialog，关闭按钮收起', async () => {
    await mount(<CitationChips citations={[cite(1), cite(2, { rerankScore: 0.87 })]} />)
    const chip1 = container.querySelector('[data-testid="cite-chip-1"]') as HTMLButtonElement
    expect(chip1.textContent).toContain('[1]')
    expect(chip1.textContent).toContain('doc1.md')
    expect(container.querySelector('[data-testid="cite-rerank-2"]')).toBeTruthy()
    await act(async () => chip1.click())
    const dialog = container.querySelector('[data-testid="citation-dialog"]') as HTMLDialogElement
    expect(dialog).toBeTruthy()
    expect(container.querySelector('[data-testid="citation-snippet"]')?.textContent).toBe('text 1')
    await act(async () => {
      ;(container.querySelector('[aria-label="close-citation"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[data-testid="citation-dialog"]')).toBeNull()
  })

  it('cards 形态展示 lane 徽章与页/行锚点', async () => {
    await mount(<CitationChips citations={[cite(1, { ranks: { vector: 1 } })]} variant="cards" />)
    const card = container.querySelector('[data-testid="cite-chip-1"]') as HTMLElement
    expect(card.textContent).toContain('向量')
    expect(card.textContent).toContain('第 2 页')
    expect(card.textContent).toContain('RRF')
  })
})
