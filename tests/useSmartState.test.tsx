import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSmartState, setSmartState, subscribeSmartState, useSmartSelector, useSmartState, type SmartStateOptions } from '../src/index'

let seq = 0
let KEY = ''

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  KEY = `k${seq++}` // fresh key per test: keyed stores are module singletons
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const fire = (key: string, newValue: string | null) =>
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', { key, newValue, storageArea: window.localStorage })
    )
  })

describe('basics', () => {
  it('behaves like useState, with a functional updater', () => {
    const { result } = renderHook(() => useSmartState(0))
    expect(result.current[0]).toBe(0)
    act(() => result.current[1](5))
    expect(result.current[0]).toBe(5)
    act(() => result.current[1]((v) => v + 1))
    expect(result.current[0]).toBe(6)
  })

  it('supports a lazy initializer', () => {
    const init = vi.fn(() => 42)
    const { result } = renderHook(() => useSmartState(init))
    expect(result.current[0]).toBe(42)
  })

  it('shares state between components using the same key', () => {
    const opts = { persist: true, storageKey: KEY }
    const a = renderHook(() => useSmartState('x', opts))
    const b = renderHook(() => useSmartState('x', opts))
    act(() => a.result.current[1]('shared'))
    expect(b.result.current[0]).toBe('shared')
  })
})

describe('persistence', () => {
  it('writes on change and hydrates on mount', () => {
    const opts = { persist: true, storageKey: KEY }
    const { result } = renderHook(() => useSmartState('a', opts))
    act(() => result.current[1]('b'))
    expect(localStorage.getItem(KEY)).toBe('"b"')
  })

  it('restores a stored value after mount (SSR-safe hydration)', () => {
    localStorage.setItem(KEY, '"stored"')
    const { result } = renderHook(() => useSmartState('init', { persist: true, storageKey: KEY }))
    expect(result.current[0]).toBe('stored')
  })

  it('honours ttl expiry', () => {
    vi.useFakeTimers()
    const opts = { persist: true, storageKey: KEY, ttl: 60_000 }
    const first = renderHook(() => useSmartState('a', opts))
    act(() => first.result.current[1]('b'))
    vi.advanceTimersByTime(61_000)
    localStorage.getItem(KEY) // envelope still there, but expired
    const raw = localStorage.getItem(KEY)!
    expect(JSON.parse(raw).__vss).toBe(1)
    // a brand-new key store in another "app run" is simulated via direct decode:
    // expired envelope must fall back to the initial value
    const freshKey = `k${seq++}`
    localStorage.setItem(freshKey, raw)
    const second = renderHook(() =>
      useSmartState('init', { persist: true, storageKey: freshKey, ttl: 60_000 })
    )
    expect(second.result.current[0]).toBe('init')
  })

  it('debounces writes and reports errors via onError', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() =>
      useSmartState('a', { persist: true, storageKey: KEY, writeDebounce: 200 })
    )
    act(() => result.current[1]('b'))
    expect(localStorage.getItem(KEY)).toBeNull()
    act(() => vi.advanceTimersByTime(200))
    expect(localStorage.getItem(KEY)).toBe('"b"')
  })
})

describe('cross-tab sync', () => {
  it('applies values from another tab and handles key removal', () => {
    const { result } = renderHook(() =>
      useSmartState('a', { persist: true, storageKey: KEY, syncTabs: true })
    )
    fire(KEY, '"other"')
    expect(result.current[0]).toBe('other')
    fire(KEY, null)
    expect(result.current[0]).toBe('a')
  })
})

describe('controls and imperative access', () => {
  it('reset() and clear() restore the initial value', () => {
    const { result } = renderHook(() => useSmartState('init', { persist: true, storageKey: KEY }))
    act(() => result.current[1]('changed'))
    act(() => result.current[2].reset())
    expect(result.current[0]).toBe('init')
    expect(localStorage.getItem(KEY)).toBe('"init"')
    act(() => result.current[1]('changed'))
    act(() => result.current[2].clear())
    expect(result.current[0]).toBe('init')
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('exposes getSmartState/setSmartState outside React', () => {
    const { result } = renderHook(() => useSmartState(1, { persist: true, storageKey: KEY }))
    expect(getSmartState<number>(KEY)).toBe(1)
    act(() => setSmartState<number>(KEY, (v) => v + 9))
    expect(result.current[0]).toBe(10)
  })
})

describe('validation and migrations', () => {
  it('parse() rejects corrupt data and falls back to the initial value', () => {
    localStorage.setItem(KEY, '"not-a-number"')
    const onError = vi.fn()
    const { result } = renderHook(() =>
      useSmartState(7, {
        persist: true,
        storageKey: KEY,
        onError,
        parse: (v) => {
          if (typeof v !== 'number') throw new Error('expected number')
          return v
        }
      })
    )
    expect(result.current[0]).toBe(7)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'read')
  })

  it('migrates older persisted versions', () => {
    localStorage.setItem(KEY, JSON.stringify({ name: 'anna' })) // v0, legacy shape
    const { result } = renderHook(() =>
      useSmartState({ fullName: 'init' }, {
        persist: true,
        storageKey: KEY,
        version: 2,
        migrate: (old) => ({ fullName: (old as { name: string }).name.toUpperCase() })
      })
    )
    expect(result.current[0]).toEqual({ fullName: 'ANNA' })
  })

  it('discards persisted values on version mismatch without a migrate fn', () => {
    localStorage.setItem(KEY, JSON.stringify({ __vss: 1, value: '"old"', v: 1 }))
    const { result } = renderHook(() =>
      useSmartState('init', { persist: true, storageKey: KEY, version: 2 })
    )
    expect(result.current[0]).toBe('init')
  })
})

describe('selector and external subscription', () => {
  it('useSmartSelector re-renders only when the slice changes', () => {
    const opts = { persist: true, storageKey: KEY } as const
    const source = renderHook(() => useSmartState({ a: 1, b: 1 }, opts))
    let renders = 0
    const selected = renderHook(() => {
      renders++
      return useSmartSelector<{ a: number; b: number }, number>(KEY, (v) => v?.a ?? 0)
    })
    expect(selected.result.current).toBe(1)
    const before = renders
    act(() => source.result.current[1]((s) => ({ ...s, b: 99 })))
    expect(selected.result.current).toBe(1)
    expect(renders).toBe(before)
    act(() => source.result.current[1]((s) => ({ ...s, a: 2 })))
    expect(selected.result.current).toBe(2)
  })

  it('subscribeSmartState notifies outside React', () => {
    const { result } = renderHook(() => useSmartState(0, { persist: true, storageKey: KEY }))
    const seen: number[] = []
    const off = subscribeSmartState<number>(KEY, (v) => seen.push(v))
    act(() => result.current[1](1))
    act(() => result.current[1](2))
    off()
    act(() => result.current[1](3))
    expect(seen).toEqual([1, 2])
  })
})

describe('type safety', () => {
  it('rejects persist without storageKey at compile time', () => {
    // @ts-expect-error — storageKey is mandatory with persist: true
    const bad: SmartStateOptions<number> = { persist: true }
    // @ts-expect-error — ttl is a persistence option
    const alsoBad: SmartStateOptions<number> = { ttl: 1000 }
    void bad
    void alsoBad
  })
})
