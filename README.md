# smart-state

React's `useState`, grown up: **persistent, shared across components and tabs, TTL expiry, versioned migrations, schema validation (Standard Schema), custom storage with a cookie adapter, debounced writes, SSR/Next.js-safe** — with no provider, zero dependencies and **~2.1 kB** min+gzip.

[![npm](https://img.shields.io/npm/v/smart-state)](https://www.npmjs.com/package/smart-state)
[![ci](https://github.com/LuigiDavideMicca/smart-state/actions/workflows/ci.yml/badge.svg)](https://github.com/LuigiDavideMicca/smart-state/actions/workflows/ci.yml)
[![bundle size](https://img.shields.io/bundlephobia/minzip/smart-state)](https://bundlephobia.com/package/smart-state)
[![license](https://img.shields.io/npm/l/smart-state)](./LICENSE)

If you searched for *"React useState with localStorage"*, *"persist state Next.js"*, *"share state between components without context"* or *"sync React state across tabs"* — this is that package, in one call.

## Installation

```bash
npm install smart-state
# or: pnpm add / bun add / yarn add
```

Requires React `>= 18`.

## Quick start

```tsx
import { useSmartState } from 'smart-state'

function Counter() {
  const [count, setCount] = useSmartState(0)
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>
}
```

Drop-in `useState` semantics — lazy initializer included — plus a third element with `reset()` and `clear()`.

## Persistence (and everything around it)

```tsx
const [theme, setTheme] = useSmartState<'light' | 'dark'>('light', {
  persist: true,
  storageKey: 'theme',
  syncTabs: true
})
```

One call gives you: restore on load, write on change, cross-tab sync, and — because keyed state lives in a shared store — **every component using `storageKey: 'theme'` sees the same value instantly, with no Context provider**.

```tsx
// A session that expires on its own
useSmartState('', { persist: true, storageKey: 'token', ttl: 15 * 60 * 1000 })

// A draft that doesn't hammer storage on every keystroke
useSmartState('', { persist: true, storageKey: 'draft', writeDebounce: 300 })

// Non-JSON values
useSmartState(new Set<string>(), {
  persist: true,
  storageKey: 'tags',
  serializer: {
    read: (raw) => new Set(JSON.parse(raw)),
    write: (v) => JSON.stringify([...v])
  }
})
```

Pending debounced writes are flushed on `pagehide`, so closing the tab never loses the last value.

## Trust nothing from storage: validation and migrations

Storage data is user-editable and survives your releases — treat it as untrusted input. Hand over any [Standard Schema](https://standardschema.dev) validator — Zod 4, Valibot, ArkType, or your own — and anything invalid falls back to the initial value (and reaches `onError`):

```tsx
import { z } from 'zod'

const User = z.object({ name: z.string(), plan: z.enum(['free', 'pro']) })

const [user, setUser] = useSmartState(guest, {
  persist: true,
  storageKey: 'user',
  schema: User, // T is inferred from the schema output
  version: 2,
  migrate: (old, fromVersion) =>
    fromVersion === 1 ? upgradeV1(old) : undefined // undefined = discard
})
```

The schema runs on every read and cross-tab message, after `migrate`. Validation is synchronous by design: an async schema is rejected at runtime with a `console.error` and the initial value is used. No schema library? The lighter `parse` option — any `(value: unknown) => T` that throws — does the same job; when both are provided, `schema` wins and `parse` is ignored. `version`/`migrate` upgrade values persisted by previous releases instead of crashing on old shapes.

### Defaults for new fields

Shipped a new field? Old stored objects don't have it. `mergeDefaults: true` shallow-merges the stored object over your defaults — `{ ...defaults, ...stored }`, top level only — or pass `(stored, defaults) => T` for anything deeper. It applies only when both sides are plain objects and runs after `parse`/`schema`/`migrate`:

```tsx
useSmartState({ theme: 'light', density: 'normal' }, {
  persist: true,
  storageKey: 'prefs',
  mergeDefaults: true // stored { theme: 'dark' } hydrates as { theme: 'dark', density: 'normal' }
})
```

## Custom storage and the no-flash cookie recipe

`storage` accepts anything with `getItem`/`setItem`/`removeItem` and takes precedence over `storageType`. Adapters are synchronous by design — async storage is out of scope. The built-in `cookieStorage()` writes to `document.cookie`, which means **the server can read the value too** — that kills the theme flash in Next.js App Router:

```tsx
'use client'
import { useSmartState, cookieStorage } from 'smart-state'

export const useTheme = () =>
  useSmartState<'light' | 'dark'>('light', {
    persist: true,
    storageKey: 'theme',
    storage: cookieStorage({ days: 365 })
  })
```

```tsx
// app/layout.tsx — Server Component
import { cookies } from 'next/headers'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const raw = (await cookies()).get('theme')?.value
  const theme = raw ? (JSON.parse(decodeURIComponent(raw)) as 'light' | 'dark') : 'light'
  return (
    <html lang="en" className={theme}>
      <body>{children}</body>
    </html>
  )
}
```

The server renders the right class in the first byte; the client hydrates from the same cookie — no flash, no `suppressHydrationWarning` gymnastics. Values are URI-encoded JSON, hence the `decodeURIComponent` + `JSON.parse`. `cookieStorage` is SSR-safe on its own: without a `document`, reads return `null` and writes no-op. Options: `days` (365), `path` (`/`), `sameSite` (`lax`), `secure` (`true` when `sameSite: 'none'`).

## Cross-tab sync, two transports

`syncTabs: true` (or `'storage'`) uses the `storage` event: zero setup, `localStorage` only. `syncTabs: 'broadcast'` uses a `BroadcastChannel` named after the key, which also covers `sessionStorage` and custom storage backends:

```tsx
useSmartState('draft', { persist: true, storageKey: 'draft', storageType: 'session', syncTabs: 'broadcast' })
```

The channel closes cleanly when the last subscriber unmounts, and where `BroadcastChannel` doesn't exist the option silently degrades to the `storage`-event path.

## Fine-grained subscriptions

Re-render only on the slice you care about:

```tsx
const itemCount = useSmartSelector<Cart, number>('cart', (cart) => cart?.items.length ?? 0)
```

And listen from anywhere, React or not:

```ts
const unsubscribe = subscribeSmartState<Cart>('cart', (cart) => analytics.track(cart))
```

## Obsessively typed

- **Impossible states don't compile**: `persist: true` *requires* `storageKey`; `ttl`, `syncTabs`, `serializer`, `version` only exist alongside `persist` — using them without it is a type error, not a runtime surprise.
- **Typed keys via declaration merging**: augment the registry once and every keyed API becomes fully typed:

```ts
declare module 'smart-state' {
  interface SmartStateRegistry {
    theme: 'light' | 'dark'
    cart: Cart
  }
}

getSmartState('theme') // 'light' | 'dark' | undefined — no generics needed
setSmartState('theme', 'blue') // ❌ compile error
```

- Built with the strictest TypeScript settings (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) and shipped with type-level tests.

## Next.js / SSR

Safe by design: the server renders the initial value; the client hydrates from storage right after mount — **no hydration mismatch warnings**, no `typeof window` guards in your code. Works in the App Router and Pages Router alike.

## Outside React

```ts
import { getSmartState, setSmartState } from 'smart-state'

setSmartState('theme', 'dark') // every subscribed component re-renders
```

Handy in event handlers, analytics glue or non-React islands.

## Sharing state across frameworks

`smart-state` writes the exact same storage envelope (`{"__vss":1,…}`, TTL and version included) as its siblings [`vue-smart-state`](https://github.com/LuigiDavideMicca/vue-smart-state) and [`nuxt-smart-state`](https://github.com/LuigiDavideMicca/nuxt-smart-state): a React island and a Vue app on the same origin read each other's persisted state out of the box. The format is a hard invariant, locked by byte-level fixture tests.

## How it compares

Sizes are the tree-shaken import, min+gzip, measured with esbuild.

| | `smart-state` | `zustand` + `persist` | `use-local-storage-state` | hand-rolled hook |
| --- | :-: | :-: | :-: | :-: |
| Bundle size | ~2.1 kB, zero deps | ~1.3 kB | ~0.7 kB | 0 kB — you maintain it |
| TTL / expiry | ✅ | ❌ | ❌ | you write it |
| Versioned migrations | ✅ | ✅ | ❌ | you write it |
| Validation (Standard Schema / `parse`) | ✅ | ❌ (bring your own) | ❌ | you write it |
| Debounced writes + flush on page hide | ✅ | ❌ | ❌ | you write it |
| Shared state, no provider | ✅ | ✅ (store API) | ✅ | you write it |
| Cross-tab sync | ✅ storage + broadcast | third-party middleware | ✅ storage event | you write it |
| Custom storage | ✅ sync | ✅ sync + async | ❌ | you write it |
| Cookie/SSR no-flash recipe | ✅ built-in `cookieStorage` | possible via custom storage | ❌ | you write it |

To be fair: zustand's persist middleware is excellent — it has custom and async storage, `partialize`, and versioned `migrate`. If you need async adapters or partial persistence of a large store, use it. `smart-state` trades those for a drop-in `useState` API with TTL, schema validation, debounce and a cookie recipe included in one call.

Built on `useSyncExternalStore`: concurrent-mode correct, tearing-safe, and re-renders only the components that use the key.

## Options

| Option          | Type                                     | Default        | Description                                                        |
| --------------- | ---------------------------------------- | -------------- | ------------------------------------------------------------------ |
| `persist`       | `boolean`                                | `false`        | Persist to web storage (requires `storageKey`).                    |
| `storageKey`    | `string`                                 | —              | Storage key; also the sharing key across components.               |
| `storageType`   | `'local' \| 'session'`                   | `'local'`      | Which storage to use.                                              |
| `storage`       | `StorageLike`                            | —              | Custom sync storage backend; wins over `storageType`.              |
| `syncTabs`      | `boolean \| 'storage' \| 'broadcast'`    | `false`        | Sync across tabs via the `storage` event or a BroadcastChannel.    |
| `ttl`           | `number`                                 | —              | Milliseconds a persisted value stays fresh.                        |
| `writeDebounce` | `number`                                 | —              | Debounce storage writes; flushed on `pagehide`.                    |
| `serializer`    | `{ read(raw): T; write(value): string }` | JSON           | Custom (de)serialization.                                          |
| `onError`       | `(error, context) => void`               | `console.warn` | Called on read/write/sync failures.                                |
| `parse`         | `(value: unknown) => T`                  | —              | Validate untrusted data from storage/sync (throw to reject).       |
| `schema`        | `StandardSchemaV1<unknown, T>`           | —              | Standard Schema validator (sync only); wins over `parse`.          |
| `mergeDefaults` | `boolean \| (stored, defaults) => T`     | `false`        | Merge stored plain objects over the defaults (`true` = shallow).   |
| `version`       | `number`                                 | —              | Schema version of the persisted value.                             |
| `migrate`       | `(value, fromVersion) => T | undefined` | —              | Upgrade older persisted values; undefined discards them.           |

## Development

```bash
bun install && bun run test   # or npm / pnpm / yarn
bun run typecheck && bun run build && bun run size
```

## License

[MIT](./LICENSE) © [Luigi Davide Micca](https://luigimicca.com)
