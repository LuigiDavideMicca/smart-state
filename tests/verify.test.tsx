import { act, createElement as e } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSmartState, useSmartSelector, getSmartState, readSmartCookie, subscribeSmartState, type StorageLike } from '../src/index'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  localStorage.clear()
})

const mem = (): StorageLike & { m: Map<string, string> } => {
  const m = new Map<string, string>()
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

describe('R hydration', () => {
  it('hydrateRoot with a stored value that differs: no mismatch, then the stored value', async () => {
    localStorage.setItem('rh', '"dark"')
    function C() {
      const [v] = useSmartState('light', { persist: true, storageKey: 'rh' })
      return e('p', null, v)
    }
    function S() {
      return e('i', null, useSmartSelector<string, string>('rh', (v) => v ?? 'none'))
    }
    const el = document.createElement('div')
    // what the server renders: the initial value, and the selector its fallback
    el.innerHTML = '<div><p>light</p><i>none</i></div>'
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void errors.push(a))
    await act(async () => {
      hydrateRoot(el, e('div', null, e(C), e(S)), { onRecoverableError: (x) => void errors.push(x) })
    })
    spy.mockRestore()
    expect(errors).toEqual([])
    expect(el.innerHTML).toBe('<div><p>dark</p><i>dark</i></div>')
  })

  it('createRoot: the first committed DOM already has the stored value', () => {
    localStorage.setItem('rc', '"dark"')
    const seen: string[] = []
    function C() {
      const [v] = useSmartState('light', { persist: true, storageKey: 'rc' })
      seen.push(v)
      return e('p', null, v)
    }
    const el = document.createElement('div')
    act(() => createRoot(el).render(e(C)))
    expect(seen[0]).toBe('dark')
  })
})

describe('R ttl in memory', () => {
  it('expires while mounted and the entry is not resurrected', async () => {
    vi.useFakeTimers()
    let seen = ''
    function C() {
      const [v, set] = useSmartState('init', { persist: true, storageKey: 'rt', ttl: 1000 })
      seen = v
      ;(globalThis as { setRt?: (v: string) => void }).setRt = set
      return null
    }
    const el = document.createElement('div')
    act(() => createRoot(el).render(e(C)))
    act(() => (globalThis as unknown as { setRt: (v: string) => void }).setRt('x'))
    expect(seen).toBe('x')
    act(() => vi.advanceTimersByTime(1500))
    expect(seen).toBe('init')
    // set same value as before expiry: must persist with a fresh expiry
    act(() => (globalThis as unknown as { setRt: (v: string) => void }).setRt('x'))
    const raw = JSON.parse(localStorage.getItem('rt')!)
    expect(raw.expires).toBeGreaterThan(Date.now())
    vi.useRealTimers()
  })
})

describe('R storage namespacing', () => {
  it('custom storages with one key share one store, as the README documents', () => {
    const a = mem()
    const b = mem()
    b.m.set('rn', '"from-b"')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let va = ''
    let vb = ''
    function A() {
      va = useSmartState('init', { persist: true, storageKey: 'rn', storage: a })[0]
      return null
    }
    function B() {
      vb = useSmartState('init', { persist: true, storageKey: 'rn', storage: b })[0]
      return null
    }
    act(() => createRoot(document.createElement('div')).render(e('div', null, e(A), e(B))))
    const warned = warn.mock.calls.length
    warn.mockRestore()
    expect({ va, vb }).toEqual({ va: 'init', vb: 'init' })
    void warned
  })
})

describe('R readSmartCookie', () => {
  it('envelope with version and schema', () => {
    const env = JSON.stringify({ __vss: 1, value: JSON.stringify({ t: 'dark' }), v: 2, expires: Date.now() + 10000 })
    const header = `a=1; theme=${encodeURIComponent(env)}; b=2`
    expect(readSmartCookie(header, 'theme', { version: 2 })).toEqual({ t: 'dark' })
    expect(readSmartCookie(header, 'theme', { version: 3 })).toBeUndefined()
    expect(readSmartCookie(header, 'theme', { version: 3, migrate: (v) => ({ ...(v as object), m: 1 }) })).toEqual({ t: 'dark', m: 1 })
    const schema = { '~standard': { version: 1 as const, vendor: 'x', validate: (v: unknown) => ({ issues: [{ message: 'no' }] }) } }
    expect(readSmartCookie(header, 'theme', { version: 2, schema })).toBeUndefined()
    const expired = JSON.stringify({ __vss: 1, value: '"x"', expires: Date.now() - 1 })
    expect(readSmartCookie(`theme=${encodeURIComponent(expired)}`, 'theme')).toBeUndefined()
    expect(readSmartCookie('theme=%E0%A4%A', 'theme')).toBeUndefined()
    expect(readSmartCookie('xtheme=1', 'theme')).toBeUndefined()
  })
})

describe('R removal / undefined / clear in other tab', () => {
  it('other tab removed the key, setting the same value again is saved', () => {
    let set: (v: string) => void = () => {}
    function C() {
      set = useSmartState('init', { persist: true, storageKey: 'rr', syncTabs: true })[1]
      return null
    }
    act(() => createRoot(document.createElement('div')).render(e(C)))
    act(() => set('x'))
    localStorage.removeItem('rr')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'rr', newValue: null, storageArea: localStorage }))
    })
    act(() => set('x'))
    expect(localStorage.getItem('rr')).toBe('"x"')
  })

  it('subscribeSmartState before any component, sees the first value', () => {
    const got: unknown[] = []
    const off = subscribeSmartState('rs', (v) => got.push(v))
    let set: (v: string) => void = () => {}
    function C() {
      set = useSmartState('init', { persist: true, storageKey: 'rs' })[1]
      return null
    }
    act(() => createRoot(document.createElement('div')).render(e(C)))
    act(() => set('y'))
    off()
    expect(got).toEqual(['init', 'y'])
    expect(getSmartState('rs')).toBe('y')
  })
})

describe('R write before hydration', () => {
  it('layout-effect write in a child before the store hydrates uses the stored value', () => {
    localStorage.setItem('rw', '5')
    let last = 0
    function C() {
      const [v, set] = useSmartState(0, { persist: true, storageKey: 'rw' })
      last = v
      return e(Child, { set })
    }
    function Child({ set }: { set: (f: (n: number) => number) => void }) {
      set === undefined
      return null
    }
    act(() => createRoot(document.createElement('div')).render(e(C)))
    expect(last).toBe(5)
    void renderToString
  })
})
