import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'

type StorageType = 'local' | 'session'

export interface Serializer<T> {
  read: (raw: string) => T
  write: (value: T) => string
}

export interface SmartStateOptions<T> {
  /** Persist the value to web storage (requires `storageKey`). */
  persist?: boolean
  /** Storage key. Also shares the state between every component using it. */
  storageKey?: string
  /** `local` (default) or `session`. Cross-tab sync only works with `local`. */
  storageType?: StorageType
  /** Keep the value in sync across browser tabs via the `storage` event. */
  syncTabs?: boolean
  /** Milliseconds a persisted value stays fresh; expired values fall back to the initial value. */
  ttl?: number
  /** Debounce storage writes by this many ms; pending writes flush on page hide. */
  writeDebounce?: number
  /** Custom (de)serialization; defaults to JSON. */
  serializer?: Serializer<T>
  /** Called instead of `console.warn` when reading, writing or syncing fails. */
  onError?: (error: unknown, context: 'read' | 'write' | 'sync') => void
}

export type SetSmartState<T> = (next: T | ((current: T) => T)) => void

export interface SmartStateControls {
  /** Back to the initial value (persisted too, when persistence is on). */
  reset: () => void
  /** Remove the persisted entry and go back to the initial value. */
  clear: () => void
}

export type SmartStateReturn<T> = [T, SetSmartState<T>, SmartStateControls]

/** Same persisted envelope as vue-smart-state: state is shareable across frameworks. */
interface Envelope {
  __vss: 1
  value: string
  expires?: number
}

interface Store<T> {
  value: T
  initial: T
  listeners: Set<() => void>
  set: SetSmartState<T>
  reset: () => void
  clear: () => void
  hydrated: boolean
  hydrate: () => void
}

const isClient = typeof window !== 'undefined'
const stores = new Map<string, Store<unknown>>()

const defaultSerializer = <T>(): Serializer<T> => ({
  read: (raw) => JSON.parse(raw) as T,
  write: (value) => JSON.stringify(value)
})

const resolve = <T>(next: T | ((current: T) => T), current: T): T =>
  typeof next === 'function' ? (next as (current: T) => T)(current) : next

function createStore<T>(initial: T, key: string | undefined, options: SmartStateOptions<T>): Store<T> {
  const {
    persist = false,
    storageType = 'local',
    syncTabs = false,
    ttl,
    writeDebounce,
    serializer = defaultSerializer<T>(),
    onError = (error, context) =>
      console.warn(`[smart-state] ${context} failed for key "${key}"`, error)
  } = options

  const storage =
    persist && key && isClient
      ? storageType === 'local'
        ? window.localStorage
        : window.sessionStorage
      : undefined

  const decode = (raw: string): T | undefined => {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && (parsed as Envelope).__vss === 1) {
        const envelope = parsed as Envelope
        if (envelope.expires !== undefined && Date.now() > envelope.expires) return undefined
        return serializer.read(envelope.value)
      }
    } catch {
      // plain legacy value: fall through
    }
    return serializer.read(raw)
  }

  const encode = (value: T): string => {
    const written = serializer.write(value)
    if (ttl === undefined) return written
    return JSON.stringify({ __vss: 1, value: written, expires: Date.now() + ttl } satisfies Envelope)
  }

  let lastWritten: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const writeNow = (value: T) => {
    if (!storage || !key) return
    try {
      const raw = encode(value)
      if (raw === lastWritten) return
      lastWritten = raw
      storage.setItem(key, raw)
    } catch (error) {
      onError(error, 'write')
    }
  }

  const write = (value: T) => {
    if (writeDebounce === undefined) return writeNow(value)
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      writeNow(store.value)
    }, writeDebounce)
  }

  const notify = () => store.listeners.forEach((listener) => listener())

  const store: Store<T> = {
    value: initial,
    initial,
    listeners: new Set(),
    hydrated: !storage,
    hydrate: () => {
      if (store.hydrated || !storage || !key) return
      store.hydrated = true
      try {
        const raw = storage.getItem(key)
        if (raw !== null) {
          const decoded = decode(raw)
          if (decoded !== undefined && decoded !== store.value) {
            store.value = decoded
            notify()
          }
        }
      } catch (error) {
        onError(error, 'read')
      }
    },
    set: (next) => {
      const resolved = resolve(next, store.value)
      if (Object.is(resolved, store.value)) return
      store.value = resolved
      write(resolved)
      notify()
    },
    reset: () => {
      if (timer !== undefined) clearTimeout(timer)
      store.value = store.initial
      writeNow(store.initial)
      notify()
    },
    clear: () => {
      if (timer !== undefined) clearTimeout(timer)
      try {
        storage?.removeItem(key!)
      } catch (error) {
        onError(error, 'write')
      }
      lastWritten = undefined
      store.value = store.initial
      notify()
    }
  }

  if (storage && key && syncTabs) {
    window.addEventListener('storage', (event) => {
      if (event.key !== key || event.storageArea !== storage) return
      if (event.newValue === null) {
        store.value = store.initial
        notify()
        return
      }
      if (event.newValue === lastWritten) return
      try {
        const decoded = decode(event.newValue)
        lastWritten = event.newValue
        store.value = decoded === undefined ? store.initial : decoded
        notify()
      } catch (error) {
        onError(error, 'sync')
      }
    })
  }

  if (storage && writeDebounce !== undefined) {
    window.addEventListener('pagehide', () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
        writeNow(store.value)
      }
    })
  }

  return store
}

function getStore<T>(
  initial: T | (() => T),
  options: SmartStateOptions<T>,
  anonymous: { current?: Store<T> }
): Store<T> {
  const key = options.persist && options.storageKey ? options.storageKey : undefined
  if (key) {
    let store = stores.get(key) as Store<T> | undefined
    if (!store) {
      store = createStore(resolve(initial as T | ((c: T) => T), undefined as T), key, options)
      stores.set(key, store as Store<unknown>)
    }
    return store
  }
  if (!anonymous.current) {
    anonymous.current = createStore(resolve(initial as T | ((c: T) => T), undefined as T), undefined, options)
  }
  return anonymous.current
}

/**
 * React's useState, grown up: persistent, shared across components and tabs,
 * with TTL, debounced writes and custom serializers. SSR-safe (Next.js
 * included): the server renders the initial value, the client hydrates from
 * storage right after mount — no hydration mismatch.
 */
export function useSmartState<T>(
  initialValue: T | (() => T),
  options: SmartStateOptions<T> = {}
): SmartStateReturn<T> {
  const anonymous = useRef<Store<T>>(undefined)
  const store = getStore(initialValue, options, anonymous)

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      store.listeners.add(onStoreChange)
      store.hydrate()
      return () => store.listeners.delete(onStoreChange)
    },
    [store]
  )

  const value = useSyncExternalStore(
    subscribe,
    () => store.value,
    () => store.initial
  )

  const controls = useMemo<SmartStateControls>(
    () => ({ reset: store.reset, clear: store.clear }),
    [store]
  )

  return [value, store.set, controls]
}

/** Read a keyed smart state outside React (returns undefined if never used). */
export function getSmartState<T>(storageKey: string): T | undefined {
  return (stores.get(storageKey) as Store<T> | undefined)?.value
}

/** Write a keyed smart state outside React (no-op if never used). */
export function setSmartState<T>(storageKey: string, next: T | ((current: T) => T)): void {
  ;(stores.get(storageKey) as Store<T> | undefined)?.set(next)
}
