import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'

type StorageType = 'local' | 'session'

export interface Serializer<T> {
  read: (raw: string) => T
  write: (value: T) => string
}

/** Minimal synchronous storage contract; `localStorage`-compatible. */
export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> }

/** Minimal Standard Schema v1 interface (standardschema.dev), vendored to stay dependency-free. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>
  }
}

/**
 * Augment this interface to get fully typed keys in `getSmartState`,
 * `setSmartState`, `subscribeSmartState` and `useSmartSelector`:
 *
 * ```ts
 * declare module 'smart-state' {
 *   interface SmartStateRegistry { theme: 'light' | 'dark' }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SmartStateRegistry {}

type RegistryKey = keyof SmartStateRegistry & string

interface CommonOptions {
  /** Called instead of `console.warn` when reading, writing or syncing fails. */
  onError?: (error: unknown, context: 'read' | 'write' | 'sync') => void
}

export interface PersistOptions<T> extends CommonOptions {
  /** Persist the value to web storage. */
  persist: true
  /** Storage key — required with `persist`, enforced at the type level. */
  storageKey: string
  /** `local` (default) or `session`. Cross-tab sync only works with `local`. */
  storageType?: StorageType
  /** Custom synchronous storage backend; takes precedence over `storageType`. */
  storage?: StorageLike
  /** Keep the value in sync across browser tabs via the `storage` event. */
  syncTabs?: boolean
  /** Milliseconds a persisted value stays fresh; expired values fall back to the initial value. */
  ttl?: number
  /** Debounce storage writes by this many ms; pending writes flush on page hide. */
  writeDebounce?: number
  /** Custom (de)serialization; defaults to JSON. */
  serializer?: Serializer<T>
  /** Validate untrusted data from storage or other tabs: return the value or throw. */
  parse?: (value: unknown) => T
  /**
   * Standard Schema (zod 4, valibot, arktype…) run on hydration and cross-tab
   * data; invalid values fall back to the initial value. Wins over `parse`.
   * Sync schemas only: async validation is rejected at runtime.
   */
  schema?: StandardSchemaV1<unknown, T>
  /**
   * When both the stored and the initial value are plain objects, merge the
   * stored one over the defaults: `true` = shallow `{ ...defaults, ...stored }`,
   * or a custom merge function. Runs after `parse`/`schema`/`migrate`.
   */
  mergeDefaults?: boolean | ((stored: T, defaults: T) => T)
  /** Schema version of the persisted value. Bump it when the shape changes. */
  version?: number
  /** Upgrade values persisted with an older version; return undefined to discard them. */
  migrate?: (value: unknown, fromVersion: number) => T | undefined
}

export interface EphemeralOptions extends CommonOptions {
  persist?: false
}

export type SmartStateOptions<T> = PersistOptions<T> | EphemeralOptions

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
  v?: number
}

const isEnvelope = (parsed: unknown): parsed is Envelope =>
  typeof parsed === 'object' &&
  parsed !== null &&
  (parsed as { __vss?: unknown }).__vss === 1 &&
  typeof (parsed as { value?: unknown }).value === 'string'

interface Store<T> {
  value: T
  readonly initial: T
  readonly listeners: Set<() => void>
  readonly set: SetSmartState<T>
  readonly controls: SmartStateControls
  readonly hydrate: () => void
}

const isClient = typeof window !== 'undefined'
const stores = new Map<string, Store<unknown>>()

const defaultSerializer = <T>(): Serializer<T> => ({
  read: (raw) => JSON.parse(raw) as T,
  write: (value) => JSON.stringify(value)
})

const resolveNext = <T>(next: T | ((current: T) => T), current: T): T =>
  typeof next === 'function' ? (next as (current: T) => T)(current) : next

const resolveInitial = <T>(initial: T | (() => T)): T =>
  typeof initial === 'function' ? (initial as () => T)() : initial

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function createStore<T>(initial: T, options: SmartStateOptions<T>): Store<T> {
  const persisted = options.persist === true ? options : undefined
  const key = persisted?.storageKey
  const {
    onError = (error: unknown, context: string) =>
      console.warn(`[smart-state] ${context} failed${key ? ` for key "${key}"` : ''}`, error)
  } = options
  const serializer = persisted?.serializer ?? defaultSerializer<T>()
  const schema = persisted?.schema
  const ttl = persisted?.ttl
  const version = persisted?.version
  const writeDebounce = persisted?.writeDebounce

  const storage: StorageLike | undefined =
    persisted && key !== undefined && isClient
      ? persisted.storage ??
        (persisted.storageType === 'session' ? window.sessionStorage : window.localStorage)
      : undefined

  const decode = (raw: string): T | undefined => {
    let payload = raw
    let fromVersion = 0
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isEnvelope(parsed)) {
        if (parsed.expires !== undefined && Date.now() > parsed.expires) return undefined
        payload = parsed.value
        fromVersion = parsed.v ?? 0
      }
    } catch {
      // plain legacy value: fall through with version 0
    }
    let value: unknown = serializer.read(payload)
    if (version !== undefined && fromVersion !== version) {
      if (!persisted?.migrate) return undefined
      value = persisted.migrate(value, fromVersion)
      if (value === undefined) return undefined
    }
    if (schema) {
      const result = schema['~standard'].validate(value)
      if (result instanceof Promise) {
        console.error('[smart-state] async schema validation is not supported; using the initial value')
        return undefined
      }
      if (result.issues) {
        throw new Error(`schema rejected stored value: ${result.issues.map((issue) => issue.message).join('; ')}`)
      }
      value = result.value
    } else if (persisted?.parse) {
      value = persisted.parse(value)
    }
    const merge = persisted?.mergeDefaults
    if (merge !== undefined && merge !== false && isPlainObject(value) && isPlainObject(initial)) {
      return (merge === true ? { ...initial, ...value } : merge(value as T, initial)) as T
    }
    return value as T
  }

  const encode = (value: T): string => {
    const written = serializer.write(value)
    if (ttl === undefined && version === undefined) return written
    const envelope: Envelope = { __vss: 1, value: written }
    if (ttl !== undefined) envelope.expires = Date.now() + ttl
    if (version !== undefined) envelope.v = version
    return JSON.stringify(envelope)
  }

  let lastWritten: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const writeNow = (value: T): void => {
    if (!storage || key === undefined) return
    try {
      const raw = encode(value)
      if (raw === lastWritten) return
      lastWritten = raw
      storage.setItem(key, raw)
    } catch (error) {
      onError(error, 'write')
    }
  }

  const write = (value: T): void => {
    if (writeDebounce === undefined) {
      writeNow(value)
      return
    }
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      writeNow(store.value)
    }, writeDebounce)
  }

  const notify = (): void => store.listeners.forEach((listener) => listener())

  let hydrated = !storage

  const store: Store<T> = {
    value: initial,
    initial,
    listeners: new Set(),
    hydrate: () => {
      if (hydrated || !storage || key === undefined) return
      hydrated = true
      try {
        const raw = storage.getItem(key)
        if (raw !== null) {
          const decoded = decode(raw)
          if (decoded !== undefined && !Object.is(decoded, store.value)) {
            store.value = decoded
            notify()
          }
        }
      } catch (error) {
        onError(error, 'read')
      }
    },
    set: (next) => {
      const resolved = resolveNext(next, store.value)
      if (Object.is(resolved, store.value)) return
      store.value = resolved
      write(resolved)
      notify()
    },
    controls: {
      reset: () => {
        if (timer !== undefined) clearTimeout(timer)
        store.value = store.initial
        writeNow(store.initial)
        notify()
      },
      clear: () => {
        if (timer !== undefined) clearTimeout(timer)
        try {
          if (key !== undefined) storage?.removeItem(key)
        } catch (error) {
          onError(error, 'write')
        }
        lastWritten = undefined
        store.value = store.initial
        notify()
      }
    }
  }

  if (storage && key !== undefined && persisted?.syncTabs) {
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

function getKeyedStore<T>(key: string): Store<T> | undefined {
  return stores.get(key) as Store<T> | undefined
}

/**
 * React's useState, grown up: persistent, shared across components and tabs,
 * with TTL, versioned migrations, runtime validation, debounced writes and
 * custom serializers. SSR-safe (Next.js included): the server renders the
 * initial value, the client hydrates from storage right after mount — no
 * hydration mismatch.
 */
export function useSmartState<T>(
  initialValue: T | (() => T),
  options: SmartStateOptions<T> = {}
): SmartStateReturn<T> {
  const anonymous = useRef<Store<T>>(undefined)
  const key = options.persist === true ? options.storageKey : undefined

  let store: Store<T>
  if (key !== undefined) {
    const existing = getKeyedStore<T>(key)
    store = existing ?? createStore(resolveInitial(initialValue), options)
    if (!existing) stores.set(key, store as Store<unknown>)
  } else {
    anonymous.current ??= createStore(resolveInitial(initialValue), options)
    store = anonymous.current
  }

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      store.listeners.add(onStoreChange)
      store.hydrate()
      return () => {
        store.listeners.delete(onStoreChange)
      }
    },
    [store]
  )

  const value = useSyncExternalStore(
    subscribe,
    () => store.value,
    () => store.initial
  )

  return [value, store.set, store.controls]
}

/**
 * Subscribe to a slice of a keyed smart state: the component re-renders only
 * when the selected value changes (per `isEqual`, `Object.is` by default).
 */
export function useSmartSelector<K extends RegistryKey, S>(
  storageKey: K,
  selector: (value: SmartStateRegistry[K] | undefined) => S,
  isEqual?: (a: S, b: S) => boolean
): S
export function useSmartSelector<T, S>(
  storageKey: string,
  selector: (value: T | undefined) => S,
  isEqual?: (a: S, b: S) => boolean
): S
export function useSmartSelector<T, S>(
  storageKey: string,
  selector: (value: T | undefined) => S,
  isEqual: (a: S, b: S) => boolean = Object.is
): S {
  const cache = useRef<{ has: boolean; value: S }>({ has: false, value: undefined as S })

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const store = getKeyedStore<T>(storageKey)
      if (!store) return () => {}
      store.listeners.add(onStoreChange)
      store.hydrate()
      return () => {
        store.listeners.delete(onStoreChange)
      }
    },
    [storageKey]
  )

  const getSnapshot = useCallback((): S => {
    const selected = selector(getKeyedStore<T>(storageKey)?.value)
    if (!cache.current.has || !isEqual(cache.current.value, selected)) {
      cache.current = { has: true, value: selected }
    }
    return cache.current.value
    // selector/isEqual are expected stable, keyed subscriptions re-create on key change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Read a keyed smart state outside React (undefined if never used). */
export function getSmartState<K extends RegistryKey>(storageKey: K): SmartStateRegistry[K] | undefined
export function getSmartState<T>(storageKey: string): T | undefined
export function getSmartState<T>(storageKey: string): T | undefined {
  return getKeyedStore<T>(storageKey)?.value
}

/** Write a keyed smart state outside React (no-op if never used). */
export function setSmartState<K extends RegistryKey>(
  storageKey: K,
  next: SmartStateRegistry[K] | ((current: SmartStateRegistry[K]) => SmartStateRegistry[K])
): void
export function setSmartState<T>(storageKey: string, next: T | ((current: T) => T)): void
export function setSmartState<T>(storageKey: string, next: T | ((current: T) => T)): void {
  getKeyedStore<T>(storageKey)?.set(next)
}

/** Listen to a keyed smart state outside React. Returns an unsubscribe function. */
export function subscribeSmartState<K extends RegistryKey>(
  storageKey: K,
  listener: (value: SmartStateRegistry[K]) => void
): () => void
export function subscribeSmartState<T>(storageKey: string, listener: (value: T) => void): () => void
export function subscribeSmartState<T>(
  storageKey: string,
  listener: (value: T) => void
): () => void {
  const store = getKeyedStore<T>(storageKey)
  if (!store) return () => {}
  const wrapped = () => listener(store.value)
  store.listeners.add(wrapped)
  return () => {
    store.listeners.delete(wrapped)
  }
}

export interface CookieStorageOptions {
  /** Days until the cookie expires. Default: 365. */
  days?: number
  /** Cookie path. Default: `/`. */
  path?: string
  /** SameSite attribute. Default: `lax`. */
  sameSite?: 'lax' | 'strict' | 'none'
  /** Secure attribute. Default: true when `sameSite` is `none`. */
  secure?: boolean
}

/**
 * A `StorageLike` over `document.cookie`, so the server can read the value too
 * (e.g. render the persisted theme without a flash). SSR-safe: without a
 * `document`, reads return null and writes no-op.
 */
export function cookieStorage(options: CookieStorageOptions = {}): StorageLike {
  const { days = 365, path = '/', sameSite = 'lax', secure = sameSite === 'none' } = options
  const write = (key: string, value: string, expires: Date): void => {
    if (typeof document === 'undefined') return
    document.cookie =
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}` +
      `; expires=${expires.toUTCString()}; path=${path}; samesite=${sameSite}${secure ? '; secure' : ''}`
  }
  return {
    getItem: (key) => {
      if (typeof document === 'undefined') return null
      const prefix = `${encodeURIComponent(key)}=`
      for (const part of document.cookie.split(';')) {
        const cookie = part.trim()
        if (cookie.startsWith(prefix)) return decodeURIComponent(cookie.slice(prefix.length))
      }
      return null
    },
    setItem: (key, value) => write(key, value, new Date(Date.now() + days * 86_400_000)),
    removeItem: (key) => write(key, '', new Date(0))
  }
}
