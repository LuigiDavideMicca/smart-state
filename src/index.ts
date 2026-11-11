import { useCallback, useRef, useSyncExternalStore } from 'react'

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

/** Options that shape how a persisted value is decoded; shared by the hook and `readSmartCookie`. */
export interface DecodeOptions<T> {
  /** Custom (de)serialization; defaults to JSON (so NaN, Date, Map, Set… need one). */
  serializer?: Serializer<T>
  /** Validate untrusted data from storage or other tabs: return the value or throw. */
  parse?: (value: unknown) => T
  /**
   * Standard Schema (zod 4, valibot, arktype…) run on hydration and cross-tab
   * data; invalid values fall back to the initial value. Wins over `parse`.
   * Sync schemas only: async validation is rejected at runtime.
   */
  schema?: StandardSchemaV1<unknown, T>
  /** Schema version of the persisted value. Bump it when the shape changes. */
  version?: number
  /** Upgrade values persisted with an older version; return undefined to discard them. */
  migrate?: (value: unknown, fromVersion: number) => T | undefined
}

export interface PersistOptions<T> extends CommonOptions, DecodeOptions<T> {
  /** Persist the value to web storage. */
  persist: true
  /** Storage key — required with `persist`, enforced at the type level. */
  storageKey: string
  /** `local` (default) or `session`. `storage`-event sync only works with `local`. */
  storageType?: StorageType
  /** Custom synchronous storage backend; takes precedence over `storageType`. */
  storage?: StorageLike
  /**
   * Keep the value in sync across browser tabs. `true`/`'storage'` use the
   * `storage` event (localStorage only); `'broadcast'` uses a BroadcastChannel,
   * which also covers sessionStorage and custom storage, and falls back to the
   * `storage` event where BroadcastChannel is unavailable.
   */
  syncTabs?: boolean | 'storage' | 'broadcast'
  /**
   * Milliseconds a persisted value stays fresh, counted from its last write
   * (every write renews it; reads don't). Expired values fall back to the
   * initial value, in memory too.
   */
  ttl?: number
  /** Debounce storage writes by this many ms; pending writes flush when the page is hidden. */
  writeDebounce?: number
  /**
   * When both the stored and the initial value are plain objects, merge the
   * stored one over the defaults: `true` = shallow `{ ...defaults, ...stored }`,
   * or a custom merge function. Runs after `parse`/`schema`/`migrate`.
   */
  mergeDefaults?: boolean | ((stored: T, defaults: T) => T)
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

type StoreOptions<T> = Omit<Partial<PersistOptions<T>>, 'persist'>

interface Store<T> {
  readonly initial: T
  readonly key: string | undefined
  options: StoreOptions<T>
  readonly listeners: Set<() => void>
  readonly get: () => T
  readonly set: SetSmartState<T>
  readonly controls: SmartStateControls
  readonly sync: () => void
  readonly flush: () => void
  readonly onStorage: (event: StorageEvent) => void
  readonly signature: string | undefined
  warned?: boolean
}

const isClient = typeof window !== 'undefined'

let dev = false
try {
  dev = process.env.NODE_ENV !== 'production'
} catch {
  // no `process` and no bundler replacement: treat as production
}

const stores = new Map<string, Store<unknown>>()
const primary = new Map<string, Store<unknown>>()
const watchers = new Map<string, Set<() => void>>()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json: Serializer<any> = { read: (raw) => JSON.parse(raw) as unknown, write: (value) => JSON.stringify(value) }

const resolveNext = <T>(next: T | ((current: T) => T), current: T): T =>
  typeof next === 'function' ? (next as (current: T) => T)(current) : next

const resolveInitial = <T>(initial: T | (() => T)): T =>
  typeof initial === 'function' ? (initial as () => T)() : initial

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const watchersOf = (key: string): Set<() => void> => {
  let set = watchers.get(key)
  if (!set) watchers.set(key, (set = new Set()))
  return set
}

const persistOf = <T>(options: SmartStateOptions<T>): PersistOptions<T> | undefined =>
  options.persist === true ? options : undefined

/** `null`: expired envelope; `undefined`: discarded by version/migrate. Throws on invalid data. */
function decode<T>(
  raw: string,
  options: DecodeOptions<T> & { mergeDefaults?: PersistOptions<T>['mergeDefaults'] },
  initial?: T
): { value: T; expires: number | undefined } | null | undefined {
  let payload = raw
  let fromVersion = 0
  let expires: number | undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isEnvelope(parsed)) {
      expires = parsed.expires
      if (expires !== undefined && Date.now() > expires) return null
      payload = parsed.value
      fromVersion = parsed.v ?? 0
    }
  } catch {
    // plain legacy value: fall through with version 0
  }
  let value: unknown = (options.serializer ?? json).read(payload)
  const { version, schema, migrate, parse, mergeDefaults: merge } = options
  if (version !== undefined && fromVersion !== version) {
    if (!migrate) return undefined
    value = migrate(value, fromVersion)
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
  } else if (parse) {
    value = parse(value)
  }
  if (merge !== undefined && merge !== false && isPlainObject(value) && isPlainObject(initial)) {
    value = merge === true ? { ...initial, ...value } : merge(value as T, initial as T)
  }
  return { value: value as T, expires }
}

function createStore<T>(
  initial: T,
  options: StoreOptions<T>,
  storage?: StorageLike,
  key?: string,
  signature?: string
): Store<T> {
  let value = initial
  let hydrated = !storage
  let lastWritten: string | null | undefined
  let expiresAt: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let channel: BroadcastChannel | undefined
  let announced = false

  const onError = (error: unknown, context: 'read' | 'write' | 'sync'): void =>
    store.options.onError
      ? store.options.onError(error, context)
      : console.warn(`[smart-state] ${context} failed${key ? ` for key "${key}"` : ''}`, error)

  const watched = (): Set<() => void> | undefined =>
    key !== undefined && primary.get(key) === store ? watchers.get(key) : undefined

  const notify = (): void => {
    store.listeners.forEach((listener) => listener())
    watched()?.forEach((listener) => listener())
  }

  const expire = (): void => {
    clearTimeout(expiryTimer)
    expiresAt = undefined
    value = initial
  }

  const track = (expires: number | undefined): void => {
    clearTimeout(expiryTimer)
    expiresAt = expires
    if (expires === undefined || expires - Date.now() > 2 ** 31 - 1) return
    expiryTimer = setTimeout(
      () => {
        if (expiresAt === undefined || Date.now() <= expiresAt) return
        expire()
        notify()
      },
      Math.max(expires - Date.now(), 0) + 1
    )
  }

  /** Apply a raw value read from storage or another tab; returns whether the value changed. */
  const load = (raw: string | null, context: 'read' | 'sync'): boolean => {
    if (raw !== null && raw === lastWritten) return false
    let next = initial
    let expires: number | undefined
    if (raw !== null) {
      try {
        const decoded = decode(raw, store.options, initial)
        if (decoded === null && storage && key !== undefined) {
          storage.removeItem(key)
          raw = null
        } else if (decoded) {
          next = decoded.value
          expires = decoded.expires
        }
      } catch (error) {
        onError(error, context)
        return false
      }
    }
    lastWritten = raw
    track(expires)
    if (Object.is(next, value)) return false
    value = next
    return true
  }

  const encode = (current: T): string => {
    const { serializer = json, ttl, version } = store.options
    const written = serializer.write(current)
    if (ttl === undefined && version === undefined) return written
    const envelope: Envelope = { __vss: 1, value: written }
    if (ttl !== undefined) envelope.expires = expiresAt ?? Date.now() + ttl
    if (version !== undefined) envelope.v = version
    return JSON.stringify(envelope)
  }

  const writeNow = (): void => {
    if (!storage || key === undefined) return
    try {
      const raw = value === undefined ? null : encode(value)
      if (raw === lastWritten) return
      if (raw === null) storage.removeItem(key)
      else storage.setItem(key, raw)
      lastWritten = raw
      channel?.postMessage(raw)
    } catch (error) {
      onError(error, 'write')
    }
  }

  const assign = (next: T): void => {
    clearTimeout(timer)
    timer = undefined
    value = next
    const ttl = store.options.ttl
    track(ttl === undefined ? undefined : Date.now() + ttl)
  }

  const store: Store<T> = {
    initial,
    key,
    options,
    signature,
    listeners: new Set(),
    get: () => {
      if (!hydrated) {
        hydrated = true
        try {
          load(storage!.getItem(key!), 'read')
        } catch (error) {
          onError(error, 'read')
        }
      }
      if (expiresAt !== undefined && Date.now() > expiresAt) expire()
      return value
    },
    set: (next) => {
      const resolved = resolveNext(next, store.get())
      if (Object.is(resolved, value)) return
      assign(resolved)
      const debounce = store.options.writeDebounce
      if (debounce === undefined) writeNow()
      else
        timer = setTimeout(() => {
          timer = undefined
          writeNow()
        }, debounce)
      notify()
    },
    controls: {
      reset: () => {
        store.get()
        assign(initial)
        writeNow()
        notify()
      },
      clear: () => {
        store.get()
        assign(initial)
        try {
          if (key !== undefined) storage?.removeItem(key)
          channel?.postMessage(null)
        } catch (error) {
          onError(error, 'write')
        }
        lastWritten = null
        track(undefined)
        notify()
      }
    },
    sync: () => {
      if (store.listeners.size > 0 && !announced) {
        announced = true
        watched()?.forEach((listener) => listener())
      }
      const wanted =
        store.listeners.size + (watched()?.size ?? 0) > 0 &&
        storage !== undefined &&
        key !== undefined &&
        store.options.syncTabs === 'broadcast' &&
        typeof BroadcastChannel !== 'undefined'
      if (wanted && !channel) {
        channel = new BroadcastChannel(`vss:${key as string}`)
        channel.onmessage = (event: MessageEvent) => {
          if (load(event.data as string | null, 'sync')) notify()
        }
        if (hydrated && timer === undefined) {
          try {
            if (load(storage.getItem(key as string), 'sync')) notify()
          } catch (error) {
            onError(error, 'sync')
          }
        }
      } else if (!wanted && channel) {
        channel.close()
        channel = undefined
      }
    },
    flush: () => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
      writeNow()
    },
    onStorage: (event) => {
      const sync = store.options.syncTabs
      if (
        !sync ||
        (sync === 'broadcast' && typeof BroadcastChannel !== 'undefined') ||
        !storage ||
        event.storageArea !== storage ||
        (event.key !== null && event.key !== key)
      )
        return
      if (load(event.key === null ? null : event.newValue, 'sync')) notify()
    }
  }
  return store
}

let listening = false

const listen = (): void => {
  if (listening) return
  listening = true
  const flush = (): void => stores.forEach((store) => store.flush())
  window.addEventListener('storage', (event) => stores.forEach((store) => store.onStorage(event)))
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}

const signatureOf = (o: StoreOptions<unknown>, initial: unknown): string | undefined => {
  if (!dev) return undefined
  try {
    return JSON.stringify([
      o.ttl,
      o.version,
      o.writeDebounce,
      o.syncTabs,
      [o.serializer, o.parse, o.schema, o.migrate, o.mergeDefaults].map((option) =>
        typeof option === 'function' || typeof option === 'object' ? 1 : option
      ),
      typeof initial === 'function' ? 0 : initial
    ])
  } catch {
    return undefined
  }
}

const storeId = (options: PersistOptions<unknown>): string =>
  `${options.storage ? 'custom' : (options.storageType ?? 'local')}:${options.storageKey}`

function keyedStore<T>(options: PersistOptions<T>, initialValue: T | (() => T)): Store<T> {
  const { storageKey: key, storage: custom, storageType } = options
  const id = storeId(options as PersistOptions<unknown>)
  let store = stores.get(id) as Store<T> | undefined
  const signature = signatureOf(options as StoreOptions<unknown>, initialValue)
  if (!store) {
    let storage: StorageLike | undefined
    try {
      storage = custom ?? (storageType === 'session' ? window.sessionStorage : window.localStorage) ?? undefined
    } catch (error) {
      ;(options.onError ?? console.warn)(error, 'read')
    }
    store = createStore(resolveInitial(initialValue), options, storage, key, signature)
    stores.set(id, store as Store<unknown>)
    if (!primary.has(key)) primary.set(key, store as Store<unknown>)
    listen()
  } else {
    store.options = { ...store.options, ...options }
    if (signature !== store.signature && !store.warned) {
      store.warned = true
      console.warn(
        `[smart-state] "${key}" is used with different options or initial values: ` +
          'they share one store, the first initial value wins, later options are merged in'
      )
    }
  }
  return store
}

/**
 * React's useState, grown up: persistent, shared across components and tabs,
 * with TTL, versioned migrations, runtime validation, debounced writes and
 * custom serializers. SSR-safe (Next.js included): the server renders the
 * initial value of each render, never shared between requests; hydration
 * renders the initial value too and switches to the stored one right after.
 * Client-only renders read storage synchronously, with no flash.
 */
export function useSmartState<T>(
  initialValue: T | (() => T),
  options: SmartStateOptions<T> = {}
): SmartStateReturn<T> {
  const local = useRef<Store<T>>(undefined)
  const attached = useRef<Store<T>>(undefined)
  const persisted = persistOf(options)
  const key = persisted?.storageKey

  let store: Store<T>
  if (persisted && isClient) {
    const existing = stores.get(storeId(persisted as PersistOptions<unknown>)) as Store<T> | undefined
    store = existing && existing === attached.current ? existing : keyedStore(persisted, initialValue)
    attached.current = store
  } else {
    store = local.current ??= createStore(resolveInitial(initialValue), {})
  }

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      store.listeners.add(onStoreChange)
      store.sync()
      return () => {
        store.listeners.delete(onStoreChange)
        store.sync()
      }
    },
    [store]
  )

  const value = useSyncExternalStore(subscribe, store.get, () => store.initial)

  return [value, store.set, store.controls]
}

/**
 * Subscribe to a slice of a keyed smart state: the component re-renders only
 * when the selected value changes (per `isEqual`, `Object.is` by default).
 * Works before the owning `useSmartState` mounts (the selector sees `undefined`
 * until then). Inline selectors are fine: the latest one is always used.
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
  const cache = useRef<{ value: S }>(undefined)

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const set = watchersOf(storageKey)
      set.add(onStoreChange)
      primary.get(storageKey)?.sync()
      return () => {
        set.delete(onStoreChange)
        primary.get(storageKey)?.sync()
      }
    },
    [storageKey]
  )

  const select = (value: unknown): S => {
    const selected = selector(value as T | undefined)
    if (!cache.current || !isEqual(cache.current.value, selected)) cache.current = { value: selected }
    return cache.current.value
  }

  return useSyncExternalStore(
    subscribe,
    () => select(primary.get(storageKey)?.get()),
    // On the server and while hydrating a selector sees undefined: a
    // module-level registry of initial values, cleared in a microtask, leaked
    // one request's value into the next render of the same tick and diverged
    // from the client inside a Suspense boundary that resumed later (found by
    // the verifier of the previous fix). It updates right after hydration.
    () => select(undefined)
  )
}

/** Read a keyed smart state outside React (undefined if no component has used it yet, and always on the server). */
export function getSmartState<K extends RegistryKey>(storageKey: K): SmartStateRegistry[K] | undefined
export function getSmartState<T>(storageKey: string): T | undefined
export function getSmartState<T>(storageKey: string): T | undefined {
  return primary.get(storageKey)?.get() as T | undefined
}

/** Write a keyed smart state outside React (no-op if no component has used it yet, and always on the server). */
export function setSmartState<K extends RegistryKey>(
  storageKey: K,
  next: SmartStateRegistry[K] | ((current: SmartStateRegistry[K]) => SmartStateRegistry[K])
): void
export function setSmartState<T>(storageKey: string, next: T | ((current: T) => T)): void
export function setSmartState<T>(storageKey: string, next: T | ((current: T) => T)): void {
  ;(primary.get(storageKey) as Store<T> | undefined)?.set(next)
}

/**
 * Listen to a keyed smart state outside React. Works before any component
 * uses the key. Returns an unsubscribe function.
 */
export function subscribeSmartState<K extends RegistryKey>(
  storageKey: K,
  listener: (value: SmartStateRegistry[K]) => void
): () => void
export function subscribeSmartState<T>(storageKey: string, listener: (value: T) => void): () => void
export function subscribeSmartState<T>(
  storageKey: string,
  listener: (value: T) => void
): () => void {
  const set = watchersOf(storageKey)
  let last = primary.get(storageKey)?.get()
  const wrapped = (): void => {
    const value = primary.get(storageKey)?.get()
    if (Object.is(value, last)) return
    last = value
    listener(value as T)
  }
  set.add(wrapped)
  primary.get(storageKey)?.sync()
  return () => {
    set.delete(wrapped)
    primary.get(storageKey)?.sync()
  }
}

export interface CookieStorageOptions {
  /** Days until the cookie expires. Default: 365. */
  days?: number
  /** Cookie path. Default: `/`. */
  path?: string
  /** Cookie domain, e.g. `.example.com` to share it with subdomains. Default: the current host. */
  domain?: string
  /** SameSite attribute. Default: `lax`. */
  sameSite?: 'lax' | 'strict' | 'none'
  /** Secure attribute. Default: true when `sameSite` is `none`. */
  secure?: boolean
}

const COOKIE_LIMIT = 4096

const cookieValue = (cookies: string, key: string): string | null => {
  const prefix = `${encodeURIComponent(key)}=`
  for (const part of cookies.split(';')) {
    const cookie = part.trim()
    if (cookie.startsWith(prefix)) {
      try {
        return decodeURIComponent(cookie.slice(prefix.length))
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * A `StorageLike` over `document.cookie`, so the server can read the value too
 * (see `readSmartCookie`). SSR-safe: without a `document`, reads return null
 * and writes no-op. Values over the 4 KB cookie limit throw, so `onError` fires.
 */
export function cookieStorage(options: CookieStorageOptions = {}): StorageLike {
  const { days = 365, path = '/', domain, sameSite = 'lax', secure = sameSite === 'none' } = options
  const write = (key: string, value: string, expires: Date): void => {
    if (typeof document === 'undefined') return
    const pair = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    if (pair.length > COOKIE_LIMIT) {
      throw new Error(`cookie "${key}" exceeds ${COOKIE_LIMIT} bytes`)
    }
    document.cookie =
      `${pair}; expires=${expires.toUTCString()}; path=${path}` +
      `${domain ? `; domain=${domain}` : ''}; samesite=${sameSite}${secure ? '; secure' : ''}`
  }
  return {
    getItem: (key) => (typeof document === 'undefined' ? null : cookieValue(document.cookie, key)),
    setItem: (key, value) => write(key, value, new Date(Date.now() + days * 86_400_000)),
    removeItem: (key) => write(key, '', new Date(0))
  }
}

/**
 * Read a value written by `cookieStorage` on the server, from a raw `Cookie`
 * request header. Understands the ttl/version envelope and runs the same
 * `serializer`/`version`/`migrate`/`schema`/`parse` pipeline as the hook.
 * Returns undefined when the cookie is missing, expired or invalid.
 */
export function readSmartCookie<K extends RegistryKey>(
  cookieHeader: string | null | undefined,
  storageKey: K,
  options?: DecodeOptions<SmartStateRegistry[K]>
): SmartStateRegistry[K] | undefined
export function readSmartCookie<T>(
  cookieHeader: string | null | undefined,
  storageKey: string,
  options?: DecodeOptions<T>
): T | undefined
export function readSmartCookie<T>(
  cookieHeader: string | null | undefined,
  storageKey: string,
  options: DecodeOptions<T> = {}
): T | undefined {
  const raw = cookieHeader ? cookieValue(cookieHeader, storageKey) : null
  if (raw === null) return undefined
  try {
    return decode(raw, options)?.value
  } catch {
    return undefined
  }
}
