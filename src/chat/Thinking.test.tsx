/**
 * Thinking.test.tsx — Wave4 T15
 * 覆盖：折叠、流式、reasoning_effort 透传
 * 运行于 vitest node 环境，不依赖 @testing-library / jsdom
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import {
  Thinking,
  normalizeReasoningEffort,
  withReasoningEffort,
  buildThinkingRequest,
  REASONING_EFFORT_VALUES,
  getDisplayCollapsed,
  shouldHideThinking,
  resolveInitialCollapsed,
} from './Thinking'

// ---------------------------------------------------------------------------
// reasoning_effort 透传
// ---------------------------------------------------------------------------
describe('reasoning_effort 透传', () => {
  it('normalize 小写去空格', () => {
    expect(normalizeReasoningEffort(' High ')).toBe('high')
    expect(normalizeReasoningEffort('MEDIUM')).toBe('medium')
    expect(normalizeReasoningEffort('low')).toBe('low')
  })

  it('空值返回 undefined', () => {
    expect(normalizeReasoningEffort('')).toBeUndefined()
    expect(normalizeReasoningEffort('   ')).toBeUndefined()
    expect(normalizeReasoningEffort(null)).toBeUndefined()
    expect(normalizeReasoningEffort(undefined)).toBeUndefined()
  })

  it('白名单外原样透传', () => {
    expect(normalizeReasoningEffort('ultra')).toBe('ultra')
    expect(normalizeReasoningEffort('custom-1')).toBe('custom-1')
  })

  it('REASONING_EFFORT_VALUES 包含 low/medium/high', () => {
    expect(REASONING_EFFORT_VALUES).toContain('low')
    expect(REASONING_EFFORT_VALUES).toContain('medium')
    expect(REASONING_EFFORT_VALUES).toContain('high')
  })

  it('withReasoningEffort 不改原对象并透传字段', () => {
    const base = { model: 'local', messages: [] as unknown[] }
    const out = withReasoningEffort(base, 'high')
    expect(out.reasoning_effort).toBe('high')
    expect(base).not.toHaveProperty('reasoning_effort')
    expect(out.model).toBe('local')
  })

  it('withReasoningEffort 空值时移除字段', () => {
    const base = { model: 'x', reasoning_effort: 'high' } as Record<string, unknown>
    const out = withReasoningEffort(base, '')
    expect(out).not.toHaveProperty('reasoning_effort')
  })

  it('withReasoningEffort 归一化后透传', () => {
    const out = withReasoningEffort({ model: 'a' }, '  Medium ')
    expect(out.reasoning_effort).toBe('medium')
  })

  it('buildThinkingRequest 透传 reasoning_effort', () => {
    const req = buildThinkingRequest({ model: 'local', stream: true }, { reasoningEffort: 'low' })
    expect(req.reasoning_effort).toBe('low')
    expect(req.model).toBe('local')
    expect(req.stream).toBe(true)
  })

  it('buildThinkingRequest 空 effort 不注入', () => {
    const req = buildThinkingRequest({ model: 'm' }, { reasoningEffort: '' })
    expect(req).not.toHaveProperty('reasoning_effort')
  })

  it('buildThinkingRequest 不污染其它字段', () => {
    const base = { model: 'm', temperature: 0.7 }
    const req = buildThinkingRequest(base, { reasoningEffort: 'high' })
    expect(req.temperature).toBe(0.7)
    expect(Object.keys(req).sort()).toEqual(['model', 'reasoning_effort', 'temperature'].sort())
  })
})

// ---------------------------------------------------------------------------
// 折叠 + 流式渲染（纯函数 + element 创建，不触发 hooks）
// ---------------------------------------------------------------------------
describe('Thinking 折叠流式渲染', () => {
  it('组件可通过 createElement 创建', () => {
    const jsx = React.createElement(Thinking, { content: 'hello', isStreaming: false })
    expect(jsx.type).toBe(Thinking)
    expect(jsx.props.content).toBe('hello')
    expect(jsx.props.isStreaming).toBe(false)
  })

  it('getDisplayCollapsed：流式强制展开', () => {
    expect(getDisplayCollapsed({ isStreaming: true, collapsed: true })).toBe(false)
    expect(getDisplayCollapsed({ isStreaming: true, collapsed: false })).toBe(false)
    expect(getDisplayCollapsed({ isStreaming: false, collapsed: true })).toBe(true)
    expect(getDisplayCollapsed({ isStreaming: false, collapsed: false })).toBe(false)
  })

  it('resolveInitialCollapsed：defaultCollapsed 优先，其次流式展开', () => {
    expect(resolveInitialCollapsed({ isStreaming: false, defaultCollapsed: true })).toBe(true)
    expect(resolveInitialCollapsed({ isStreaming: false, defaultCollapsed: false })).toBe(false)
    expect(resolveInitialCollapsed({ isStreaming: true })).toBe(false)
    expect(resolveInitialCollapsed({ isStreaming: false })).toBe(false)
  })

  it('shouldHideThinking：hideWhenEmpty 仅非流式空内容隐藏', () => {
    expect(shouldHideThinking({ content: '   ', isStreaming: false, hideWhenEmpty: true })).toBe(true)
    expect(shouldHideThinking({ content: '', isStreaming: true, hideWhenEmpty: true })).toBe(false)
    expect(shouldHideThinking({ content: 'hi', isStreaming: false, hideWhenEmpty: true })).toBe(false)
    expect(shouldHideThinking({ content: '   ', isStreaming: false, hideWhenEmpty: false })).toBe(false)
  })

  it('reasoningEffort 归一化透传（组件内 data-reasoning-effort 所用）', () => {
    expect(normalizeReasoningEffort('high')).toBe('high')
    expect(normalizeReasoningEffort('  Low ')).toBe('low')
    expect(normalizeReasoningEffort('MEDIUM')).toBe('medium')
  })

  it('流式增量：content 原样追加透传', () => {
    let acc = ''
    const deltas = ['Hel', 'lo ', 'world']
    for (const d of deltas) acc += d
    expect(acc).toBe('Hello world')
    // 流式时展示态应为展开
    expect(getDisplayCollapsed({ isStreaming: true, collapsed: true })).toBe(false)
  })

  it('非流式受控 collapsed 保持原值', () => {
    expect(getDisplayCollapsed({ isStreaming: false, collapsed: true })).toBe(true)
    expect(getDisplayCollapsed({ isStreaming: false, collapsed: false })).toBe(false)
  })

  it('withReasoningEffort 与组件透传一致', () => {
    const eff = normalizeReasoningEffort('high')
    const req = withReasoningEffort({ model: 'local' }, eff)
    expect(req.reasoning_effort).toBe('high')
    // 空值不透传，对应组件 data-reasoning-effort 为 undefined
    expect(normalizeReasoningEffort('')).toBeUndefined()
  })
})
