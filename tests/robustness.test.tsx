import { act, render, renderHook } from '@testing-library/react'
import { StrictMode, createElement, useEffect, useLayoutEffect, useState } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cookieStorage, getSmartState, readSmartCookie, subscribeSmartState, useSmartSelector, useSmartState } from '../src/index'

let seq = 0
let KEY = ''

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  KEY = `h${seq++}`
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const fireStorage = (key: string | null, newValue: string | null) =>
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: window.localStorage }))
  })

describe('storage access throwing (Safari/Chrome with site data blocked, sandboxed iframes)', () => {
  it('accessing window.localStorage that throws crashes the render instead of falling back', () => {
    const desc = Object.getOwnPropertyDescriptor(window, 'localStorage')!
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      }
    })
    const onError = vi.fn()
    try {
      const { result } = renderHook(() => useSmartState(1, { persist: true, storageKey: KEY, onError }))
      expect(result.current[0]).toBe(1)
    } finally {
      Object.defineProperty(window, 'localStorage', desc)
    }
  })
})

describe('lost writes', () => {
  it('after another tab removes the key, setting the previous value back is never persisted', () => {
    const { result } = renderHook(() => useSmartState(0, { persist: true, storageKey: KEY, syncTabs: true }))
    act(() => result.current[1](5))
    expect(localStorage.getItem(KEY)).toBe('5')
    localStorage.removeItem(KEY)
    fireStorage(KEY, null) // other tab: localStorage.removeItem / clear()
    expect(result.current[0]).toBe(0)
    act(() => result.current[1](5))
    expect(result.current[0]).toBe(5)
    expect(localStorage.getItem(KEY)).toBe('5') // observed: null — the write is deduped against a stale lastWritten
  })

  it('clear() with writeDebounce, then pagehide, re-creates the cleared entry', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() =>
      useSmartState('', { persist: true, storageKey: KEY, writeDebounce: 300 })
    )
    act(() => result.current[1]('secret'))
    act(() => result.current[2].clear())
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.getItem(KEY)).toBeNull() // observed: '""' — timer handle not reset in clear()/reset()
  })

  it('debounced write is lost when the page is backgrounded on mobile (visibilitychange, no pagehide)', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() =>
      useSmartState('', { persist: true, storageKey: KEY, writeDebounce: 300 })
    )
    act(() => result.current[1]('draft'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    try {
      expect(localStorage.getItem(KEY)).toBe('"draft"') // the OS may kill a backgrounded tab without pagehide
    } finally {
      delete (document as unknown as { visibilityState?: string }).visibilityState
    }
  })

  it('a functional update issued before the hook has hydrated is computed from the initial value and clobbers storage', () => {
    localStorage.setItem(KEY, '5')
    function Visits() {
      const [visits, setVisits] = useSmartState(0, { persist: true, storageKey: KEY })
      useLayoutEffect(() => setVisits((v) => v + 1), [setVisits])
      return createElement('span', null, visits)
    }
    const { container } = render(createElement(Visits))
    expect(container.textContent).toBe('6') // observed: '1', and storage now holds 1
    expect(localStorage.getItem(KEY)).toBe('6')
  })

  it('same with useEffect in a child component (child effects run before the parent subscribes)', () => {
    localStorage.setItem(KEY, '5')
    function Child({ bump }: { bump: (fn: (v: number) => number) => void }) {
      useEffect(() => bump((v) => v + 1), [bump])
      return null
    }
    function Parent() {
      const [n, setN] = useSmartState(0, { persist: true, storageKey: KEY })
      return createElement('div', null, createElement('span', null, n), createElement(Child, { bump: setN }))
    }
    const { container } = render(createElement(Parent))
    expect(container.textContent).toBe('6')
  })
})

describe('values JSON cannot represent', () => {
  // undefined is not representable in JSON: it removes the entry, so a reload yields the initial value
  it('undefined + ttl removes the entry instead of persisting a broken envelope', () => {
    const opts = { persist: true as const, storageKey: KEY, ttl: 60_000 }
    const first = renderHook(() => useSmartState<string | undefined>('x', opts))
    act(() => first.result.current[1]('y'))
    expect(localStorage.getItem(KEY)).toContain('__vss')
    act(() => first.result.current[1](undefined))
    expect(first.result.current[0]).toBeUndefined()
    expect(localStorage.getItem(KEY)).toBeNull() // was: an envelope without `value`, read back as the envelope object
    const KEY2 = KEY + 'reload'
    const second = renderHook(() => useSmartState<string | undefined>('x', { ...opts, storageKey: KEY2 }))
    expect(second.result.current[0]).toBe('x')
  })

  it('undefined without ttl removes the entry instead of storing the string "undefined"', () => {
    // happy-dom drops setItem(k, undefined); real browsers store the string "undefined"
    const map = new Map<string, string>()
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, String(v)), removeItem: (k: string) => void map.delete(k) }
    const onError = vi.fn()
    const first = renderHook(() => useSmartState<number | undefined>(1, { persist: true, storageKey: KEY, storage, onError }))
    act(() => first.result.current[1](2))
    act(() => first.result.current[1](undefined))
    expect(map.has(KEY)).toBe(false) // was: the string 'undefined', a SyntaxError on every load
    act(() => first.result.current[1](2))
    expect(map.get(KEY)).toBe('2')
    expect(onError).not.toHaveBeenCalled()
  })

  it('setting undefined as the first write of a session is skipped entirely; the old value comes back on reload', () => {
    localStorage.setItem(KEY, '5') // previous session
    const { result } = renderHook(() => useSmartState<number | undefined>(1, { persist: true, storageKey: KEY }))
    expect(result.current[0]).toBe(5)
    act(() => result.current[1](undefined)) // encode() returns undefined === lastWritten (undefined) -> early return
    expect(localStorage.getItem(KEY)).not.toBe('5') // observed: '5' resurrects on next load
  })
})

describe('same key, different options', () => {
  it('a second hook with the same storageKey but a different storageType silently shares the first one', () => {
    const local = renderHook(() => useSmartState('a', { persist: true, storageKey: KEY }))
    const session = renderHook(() => useSmartState('b', { persist: true, storageKey: KEY, storageType: 'session' }))
    act(() => session.result.current[1]('written-to-session'))
    expect(sessionStorage.getItem(KEY)).toBe('"written-to-session"') // observed: null, it went to localStorage
    void local
  })

  it('options of the second hook (ttl, schema, initial value) are ignored without a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderHook(() => useSmartState(0, { persist: true, storageKey: KEY }))
    const b = renderHook(() =>
      useSmartState(10, {
        persist: true,
        storageKey: KEY,
        ttl: 1000,
        parse: (v) => {
          if (typeof v !== 'number') throw new Error('nope')
          return v
        }
      })
    )
    act(() => b.result.current[1](3))
    expect(localStorage.getItem(KEY)).toContain('__vss') // observed: '3', ttl of hook B is ignored
    expect(warn).toHaveBeenCalled() // observed: no dev warning for conflicting options
  })
})

describe('ttl', () => {
  it('an expired value stays live in memory while the tab is open (no in-memory expiry)', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useSmartState('', { persist: true, storageKey: KEY, ttl: 1000 }))
    act(() => result.current[1]('token'))
    act(() => vi.advanceTimersByTime(5000))
    // a fresh component mounting after expiry still gets the stale token
    const late = renderHook(() => useSmartState('', { persist: true, storageKey: KEY, ttl: 1000 }))
    expect(late.result.current[0]).toBe('') // observed: 'token'
    expect(getSmartState(KEY)).toBe('')
  })

  it('an expired entry is never removed from storage', () => {
    localStorage.setItem(KEY, JSON.stringify({ __vss: 1, value: '"old"', expires: Date.now() - 1 }))
    const { result } = renderHook(() => useSmartState('init', { persist: true, storageKey: KEY, ttl: 1000 }))
    expect(result.current[0]).toBe('init')
    expect(localStorage.getItem(KEY)).toBeNull() // observed: expired token still sitting in storage
  })
})

describe('cross-tab', () => {
  it('localStorage.clear() in another tab (event.key === null) is ignored', () => {
    const { result } = renderHook(() => useSmartState(0, { persist: true, storageKey: KEY, syncTabs: true }))
    act(() => result.current[1](7))
    localStorage.clear()
    fireStorage(null, null)
    expect(result.current[0]).toBe(0) // observed: 7
  })

  it('with syncTabs:"broadcast", messages arriving while no component is mounted are lost; remount shows stale data', () => {
    class BC {
      static all = new Set<BC>()
      onmessage: ((e: { data: unknown }) => void) | null = null
      constructor(readonly name: string) {
        BC.all.add(this)
      }
      postMessage(data: unknown) {
        for (const o of BC.all) if (o !== this && o.name === this.name) o.onmessage?.({ data })
      }
      close() {
        BC.all.delete(this)
      }
    }
    vi.stubGlobal('BroadcastChannel', BC)
    const opts = { persist: true as const, storageKey: KEY, storageType: 'session' as const, syncTabs: 'broadcast' as const }
    const first = renderHook(() => useSmartState('a', opts))
    first.unmount() // route change
    // another tab writes and broadcasts
    const other = new BC(`vss:${KEY}`)
    sessionStorage.setItem(KEY, '"b"') // (sessionStorage is per-tab; for localStorage+broadcast the same holds)
    other.postMessage('"b"')
    const again = renderHook(() => useSmartState('a', opts))
    expect(again.result.current[0]).toBe('b') // observed: 'a'
  })
})

describe('useSmartSelector', () => {
  it('a selector mounted before the owning useSmartState never updates', () => {
    function Count() {
      return createElement('b', null, useSmartSelector<number, number>(KEY, (v) => v ?? -1))
    }
    function Owner() {
      const [n, setN] = useSmartState(1, { persist: true, storageKey: KEY })
      return createElement('button', { onClick: () => setN(n + 1) }, 'inc')
    }
    function App() {
      const [showOwner, setShowOwner] = useState(false)
      return createElement(
        'div',
        null,
        createElement(Count),
        showOwner ? createElement(Owner) : createElement('i', { onClick: () => setShowOwner(true) }, 'open')
      )
    }
    const { container } = render(createElement(App))
    act(() => (container.querySelector('i') as HTMLElement).click())
    act(() => (container.querySelector('button') as HTMLElement).click())
    expect(container.querySelector('b')!.textContent).toBe('2') // observed: '-1' forever
  })

  it('selector capturing props goes stale (memoized by key only)', () => {
    renderHook(() => useSmartState({ a: 1, b: 2 }, { persist: true, storageKey: KEY }))
    const { result, rerender } = renderHook(
      ({ field }: { field: 'a' | 'b' }) => useSmartSelector<{ a: number; b: number }, number>(KEY, (v) => v![field]),
      { initialProps: { field: 'a' as 'a' | 'b' } }
    )
    expect(result.current).toBe(1)
    rerender({ field: 'b' })
    expect(result.current).toBe(2) // observed: 1
  })

  it('hydration mismatch when a selector hydrates after the store was already hydrated (Suspense/islands)', async () => {
    localStorage.setItem(KEY, '5')
    // island 1 (already hydrated / client-rendered) owns the state
    const c1 = document.createElement('div')
    document.body.appendChild(c1)
    function Owner() {
      const [n] = useSmartState(0, { persist: true, storageKey: KEY })
      return createElement('span', null, n)
    }
    const r1 = createRoot(c1)
    await act(async () => r1.render(createElement(Owner)))
    expect(c1.textContent).toBe('5')
    // island 2: server rendered the initial value (0)
    function Sel() {
      return createElement('b', null, useSmartSelector<number, number>(KEY, (v) => v ?? 0))
    }
    const c2 = document.createElement('div')
    c2.innerHTML = '<b>0</b>'
    document.body.appendChild(c2)
    const recoverable = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      hydrateRoot(c2, createElement(Sel), { onRecoverableError: recoverable })
    })
    expect(recoverable).not.toHaveBeenCalled() // observed: hydration mismatch, server snapshot = live client value
    errSpy.mockRestore()
  })
})

describe('client-only apps (Vite SPA, no SSR)', () => {
  it('the first committed frame shows the initial value even though storage is readable synchronously (flash)', () => {
    localStorage.setItem(KEY, '"dark"')
    const firstFrame: string[] = []
    function Theme() {
      const [theme] = useSmartState('light', { persist: true, storageKey: KEY })
      useLayoutEffect(() => {
        firstFrame.push(theme)
      })
      return createElement('span', null, theme)
    }
    render(createElement(Theme))
    expect(firstFrame[0]).toBe('dark') // observed: 'light' painted first, then 'dark'
  })

  it('README cookie recipe — a component syncing document class in an effect flips to the initial theme first', () => {
    const storage = cookieStorage()
    storage.setItem(KEY, '"dark"')
    document.documentElement.className = 'dark' // what the server rendered
    const seen: string[] = []
    function ThemeSync() {
      const [theme] = useSmartState<'light' | 'dark'>('light', { persist: true, storageKey: KEY, storage })
      useEffect(() => {
        document.documentElement.className = theme
        seen.push(theme)
      }, [theme])
      return null
    }
    render(createElement(ThemeSync))
    storage.removeItem(KEY)
    expect(seen).toEqual(['dark']) // observed: ['light', 'dark'] — the "no flash" promise breaks
  })
})

describe('StrictMode', () => {
  it('StrictMode + broadcast keeps one channel and closes it on unmount', () => {
    let open = 0
    class BC {
      onmessage: unknown = null
      constructor() {
        open++
      }
      postMessage() {}
      close() {
        open--
      }
    }
    vi.stubGlobal('BroadcastChannel', BC)
    const { unmount } = render(
      createElement(StrictMode, null, createElement(() => {
        useSmartState(0, { persist: true, storageKey: KEY, syncTabs: 'broadcast' })
        return null
      }))
    )
    expect(open).toBe(1)
    unmount()
    expect(open).toBe(0)
  })
})

describe('cookieStorage', () => {
  it('values over the ~4 KB cookie limit are dropped silently (no onError)', () => {
    const onError = vi.fn()
    const storage = cookieStorage()
    const { result } = renderHook(() => useSmartState('', { persist: true, storageKey: KEY, storage, onError }))
    // emulate a real browser: document.cookie ignores oversized cookies
    let proto: object | null = document
    while (proto && !Object.getOwnPropertyDescriptor(proto, 'cookie')) proto = Object.getPrototypeOf(proto)
    const real = Object.getOwnPropertyDescriptor(proto!, 'cookie')!
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => real.get!.call(document),
      set: (v: string) => {
        if (v.length <= 4096) real.set!.call(document, v)
      }
    })
    try {
      act(() => result.current[1]('x'.repeat(5000)))
      expect(storage.getItem(KEY)).toBeNull() // the browser dropped it
      expect(onError).toHaveBeenCalled() // observed: neither persisted nor reported
    } finally {
      delete (document as unknown as { cookie?: string }).cookie
    }
  })

  it('a cookie with a malformed %-sequence (set by server/other code) breaks every read through getItem', () => {
    document.cookie = `${KEY}=100%`
    expect(() => cookieStorage().getItem(KEY)).not.toThrow()
    document.cookie = `${KEY}=; expires=${new Date(0).toUTCString()}`
  })
})

describe('hydration', () => {
  const hydrate = async (html: string, element: ReturnType<typeof createElement>) => {
    const container = document.createElement('div')
    container.innerHTML = html
    document.body.appendChild(container)
    const recoverable = vi.fn()
    await act(async () => {
      hydrateRoot(container, element, { onRecoverableError: recoverable })
    })
    return { container, recoverable }
  }

  it('hydrates with the initial value, then switches to the stored one without a mismatch', async () => {
    localStorage.setItem(KEY, '"dark"')
    function Theme() {
      const [theme] = useSmartState('light', { persist: true, storageKey: KEY })
      return createElement('span', null, theme)
    }
    const { container, recoverable } = await hydrate('<span>light</span>', createElement(Theme))
    expect(recoverable).not.toHaveBeenCalled()
    expect(container.textContent).toBe('dark')
  })

  it('cookie recipe: a server-provided initial value hydrates without a flash', async () => {
    const storage = cookieStorage()
    storage.setItem(KEY, '"dark"')
    const fromServer = readSmartCookie<'light' | 'dark'>(document.cookie, KEY) ?? 'light'
    const seen: string[] = []
    function ThemeSync({ initial }: { initial: 'light' | 'dark' }) {
      const [theme] = useSmartState(initial, { persist: true, storageKey: KEY, storage })
      useEffect(() => {
        seen.push(theme)
      }, [theme])
      return createElement('span', null, theme)
    }
    const { recoverable } = await hydrate('<span>dark</span>', createElement(ThemeSync, { initial: fromServer }))
    storage.removeItem(KEY)
    expect(recoverable).not.toHaveBeenCalled()
    expect(seen).toEqual(['dark'])
  })
})

describe('readSmartCookie', () => {
  const header = (value: string) => `a=1; ${KEY}=${encodeURIComponent(value)}; b=2`

  it('reads plain and enveloped values from a Cookie header', () => {
    expect(readSmartCookie(header('"dark"'), KEY)).toBe('dark')
    const fresh = JSON.stringify({ __vss: 1, value: '{"n":1}', expires: Date.now() + 60_000, v: 2 })
    expect(readSmartCookie(header(fresh), KEY, { version: 2 })).toEqual({ n: 1 })
  })

  it('returns undefined for missing, expired, malformed, invalid or outdated values', () => {
    expect(readSmartCookie(undefined, KEY)).toBeUndefined()
    expect(readSmartCookie('a=1', KEY)).toBeUndefined()
    expect(readSmartCookie(`${KEY}=100%`, KEY)).toBeUndefined()
    expect(readSmartCookie(header('{oops'), KEY)).toBeUndefined()
    const expired = JSON.stringify({ __vss: 1, value: '"x"', expires: Date.now() - 1 })
    expect(readSmartCookie(header(expired), KEY)).toBeUndefined()
    expect(readSmartCookie(header('"x"'), KEY, { version: 1 })).toBeUndefined()
    expect(readSmartCookie(header('"x"'), KEY, { version: 1, migrate: (v) => `${String(v)}!` })).toBe('x!')
    const parse = (v: unknown) => {
      if (typeof v !== 'number') throw new Error('nope')
      return v
    }
    expect(readSmartCookie(header('"x"'), KEY, { parse })).toBeUndefined()
  })
})

describe('cookieStorage options', () => {
  it('writes the domain attribute', () => {
    const written: string[] = []
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: (v: string) => void written.push(v) })
    try {
      cookieStorage({ domain: '.example.com' }).setItem(KEY, '1')
      expect(written[0]).toContain('; domain=.example.com;')
    } finally {
      delete (document as unknown as { cookie?: string }).cookie
    }
  })
})

describe('more edge cases', () => {
  it('reports a throwing storage accessor through onError and keeps working in memory', () => {
    const desc = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      }
    })
    const onError = vi.fn()
    try {
      const { result } = renderHook(() => useSmartState(1, { persist: true, storageKey: KEY, storageType: 'session', onError }))
      act(() => result.current[1](2))
      expect(result.current[0]).toBe(2)
      expect(onError).toHaveBeenCalledWith(expect.any(DOMException), 'read')
    } finally {
      Object.defineProperty(window, 'sessionStorage', desc)
    }
  })

  it('subscribeSmartState registered before any component hears the first change', () => {
    const seen: number[] = []
    const off = subscribeSmartState<number>(KEY, (v) => seen.push(v))
    const { result } = renderHook(() => useSmartState(1, { persist: true, storageKey: KEY }))
    act(() => result.current[1](2))
    off()
    expect(seen).toEqual([1, 2])
  })

  it('a ttl longer than the setTimeout range does not expire immediately', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useSmartState('', { persist: true, storageKey: KEY, ttl: 30 * 86_400_000 }))
    act(() => result.current[1]('kept'))
    act(() => vi.advanceTimersByTime(10))
    expect(result.current[0]).toBe('kept')
    vi.setSystemTime(Date.now() + 31 * 86_400_000)
    expect(getSmartState(KEY)).toBe('')
  })

  it('in-memory expiry resets subscribed components when the ttl elapses', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useSmartState('', { persist: true, storageKey: KEY, ttl: 1000 }))
    act(() => result.current[1]('token'))
    act(() => vi.advanceTimersByTime(1001))
    expect(result.current[0]).toBe('')
  })
})
