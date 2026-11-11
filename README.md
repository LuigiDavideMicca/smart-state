# smart-state

React's `useState`, grown up: **persistent, shared across components and tabs, TTL expiry, versioned migrations, schema validation (Standard Schema), custom storage with a cookie adapter, debounced writes, SSR/Next.js-safe** — with no provider, zero dependencies and **~2.9 kB** min+gzip.

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

Stores are shared per key *and* backend: `storageKey: 'theme'` in `localStorage`, in `sessionStorage` and in a custom `storage` are three separate stores (all custom backends share one store per key: an inline `cookieStorage()` is a new object on every render, so the store cannot key on the instance) (`getSmartState`, `useSmartSelector` & co. address the first one created for that key). Components sharing a store should pass the same options and initial value: the first initial value wins (it is what `reset()`/`clear()` go back to), options from later components are merged in, and in development a `console.warn` flags the mismatch.

```tsx
// A session that expires on its own
useSmartState('', { persist: true, storageKey: 'token', ttl: 15 * 60 * 1000 })

// A draft that doesn't hammer storage on every keystroke
useSmartState('', { persist: true, storageKey: 'draft', writeDebounce: 300 })

// Non-JSON values (Set, Map, Date, NaN, BigInt…) need a serializer
useSmartState(new Set<string>(), {
  persist: true,
  storageKey: 'tags',
  serializer: {
    read: (raw) => new Set(JSON.parse(raw)),
    write: (v) => JSON.stringify([...v])
  }
})
```

Pending debounced writes are flushed on `pagehide` and when the tab is hidden (`visibilitychange`, often the last event a mobile browser fires before discarding a background tab), so closing or backgrounding the tab doesn't lose the last value.

**TTL** counts from the last *write*: every update renews it, reading doesn't (a sliding expiry on writes, not an absolute deadline from the first write). Once it elapses the value falls back to the initial value in memory too — open tabs reset on time and later reads get the initial value — and an expired entry is deleted from storage the next time it is read.

**`undefined`** can't be represented in JSON, so setting a persisted state to `undefined` removes the stored entry: the current tab sees `undefined`, a reload (or another tab) sees the initial value. The same goes for an entry removed from outside, including `localStorage.clear()` in another tab.

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

`storage` accepts anything with `getItem`/`setItem`/`removeItem` and takes precedence over `storageType`. Adapters are synchronous by design — async storage is out of scope. The built-in `cookieStorage()` writes to `document.cookie`, which means **the server can read the value too**. Read it with `readSmartCookie` and hand it to the hook as the initial value: server and client then render the same thing, so there is nothing to flash and nothing to mismatch (Next.js App Router shown):

```tsx
// theme.tsx
'use client'
import { useSmartState, cookieStorage } from 'smart-state'

export type Theme = 'light' | 'dark'

export const useTheme = (initial: Theme = 'light') =>
  useSmartState<Theme>(initial, {
    persist: true,
    storageKey: 'theme',
    storage: cookieStorage({ days: 365 })
  })

export function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useTheme(initial)
  return <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme}</button>
}
```

```tsx
// app/layout.tsx — Server Component
import { headers } from 'next/headers'
import { readSmartCookie } from 'smart-state'
import { ThemeToggle, type Theme } from './theme'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = readSmartCookie<Theme>((await headers()).get('cookie'), 'theme') ?? 'light'
  return (
    <html lang="en" className={theme}>
      <body>
        <ThemeToggle initial={theme} />
        {children}
      </body>
    </html>
  )
}
```

The server renders the right class and the right toggle in the first byte, and hydration starts from the same value. Without the server-provided initial value the page is still correct, but hydration renders `'light'` first and switches to the stored theme right after (see [Next.js / SSR](#nextjs--ssr)), so anything that syncs the theme from an effect would flicker. Only the *first* component to use a key sets its initial value, so pass the server value to the component that renders first (or to all of them).

`readSmartCookie(cookieHeader, key, options?)` takes the raw `Cookie` request header (`headers().get('cookie')`, `request.headers.get('cookie')`, `req.headers.cookie`), URI-decodes the value, understands the TTL/version envelope and runs the same `serializer`/`version`/`migrate`/`schema`/`parse` options as the hook; it returns `undefined` when the cookie is missing, expired or invalid. It is a plain function, safe to call in Server Components.

`cookieStorage` is SSR-safe on its own: without a `document`, reads return `null` and writes no-op. A malformed cookie value reads as `null`, and a value over the browser's 4 KB cookie limit throws, so it reaches `onError` instead of being dropped silently. Options: `days` (365), `path` (`/`), `domain` (current host), `sameSite` (`lax`), `secure` (`true` when `sameSite: 'none'`).

## Cross-tab sync, two transports

`syncTabs: true` (or `'storage'`) uses the `storage` event: zero setup, `localStorage` only. `syncTabs: 'broadcast'` uses a `BroadcastChannel` named after the key, which also covers `sessionStorage` and custom storage backends:

```tsx
useSmartState('draft', { persist: true, storageKey: 'draft', storageType: 'session', syncTabs: 'broadcast' })
```

The channel closes cleanly when the last subscriber unmounts, and storage is re-read when the first one mounts again, so messages missed in between aren't lost. Where `BroadcastChannel` doesn't exist the option silently degrades to the `storage`-event path.

## Fine-grained subscriptions

Re-render only on the slice you care about:

```tsx
const itemCount = useSmartSelector<Cart, number>('cart', (cart) => cart?.items.length ?? 0)
```

Inline selectors and `isEqual` functions are fine: the latest ones are used on every render, so selectors that close over props stay correct. A selector may mount before the component owning the key: it sees `undefined` until the owning `useSmartState` mounts, then updates. On the server and while hydrating it renders `selector(undefined)` — the same on both sides, so there is no mismatch — and switches to the stored value right after hydration. Where a value must render on the server, read it with `useSmartState`.

And listen from anywhere, React or not (also before any component uses the key):

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

Safe by design, App Router and Pages Router alike, with no `typeof window` guards in your code:

- **The server never shares state between requests.** On the server each component renders the initial value it was given in that render; `setState` during a server render only affects that render, and nothing is kept in module-level memory. `getSmartState` returns `undefined` and `setSmartState` is a no-op on the server; `useSmartSelector` renders `selector(undefined)`.
- **Hydration renders the initial value**, exactly like the server, and switches to the stored value right after: no hydration mismatch. Pass a server-provided initial value (see the [cookie recipe](#custom-storage-and-the-no-flash-cookie-recipe)) to start from the right value.
- **Client-only renders read storage synchronously**: a Vite SPA, a client-side navigation or anything mounted after hydration shows the stored value in its first frame, with no flash.
- The build ships with a `'use client'` directive, so Server Components can import it as a client boundary (`readSmartCookie` is a plain function and works there too).

## Outside React

```ts
import { getSmartState, setSmartState } from 'smart-state'

setSmartState('theme', 'dark') // every subscribed component re-renders
```

Handy in event handlers, analytics glue or non-React islands. They address a store created by a mounted `useSmartState`: before that, `getSmartState` returns `undefined` and `setSmartState` does nothing.

## Sharing state across frameworks

`smart-state` writes the exact same storage envelope (`{"__vss":1,…}`, TTL and version included) as its siblings [`vue-smart-state`](https://github.com/LuigiDavideMicca/vue-smart-state) and [`nuxt-smart-state`](https://github.com/LuigiDavideMicca/nuxt-smart-state): a React island and a Vue app on the same origin read each other's persisted state out of the box. The format is a hard invariant, locked by byte-level fixture tests.

## How it compares

Sizes are the tree-shaken import, min+gzip, measured with esbuild.

| | `smart-state` | `zustand` + `persist` | `use-local-storage-state` | hand-rolled hook |
| --- | :-: | :-: | :-: | :-: |
| Bundle size | ~2.9 kB, zero deps | ~1.3 kB | ~0.7 kB | 0 kB — you maintain it |
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
| `ttl`           | `number`                                 | —              | Milliseconds a persisted value stays fresh after its last write.   |
| `writeDebounce` | `number`                                 | —              | Debounce storage writes; flushed when the page is hidden.          |
| `serializer`    | `{ read(raw): T; write(value): string }` | JSON           | Custom (de)serialization (needed for Set, Map, Date, NaN…).        |
| `onError`       | `(error, context) => void`               | `console.warn` | Called on read/write/sync failures.                                |
| `parse`         | `(value: unknown) => T`                  | —              | Validate untrusted data from storage/sync (throw to reject).       |
| `schema`        | `StandardSchemaV1<unknown, T>`           | —              | Standard Schema validator (sync only); wins over `parse`.          |
| `mergeDefaults` | `boolean \| (stored, defaults) => T`     | `false`        | Merge stored plain objects over the defaults (`true` = shallow).   |
| `version`       | `number`                                 | —              | Schema version of the persisted value.                             |
| `migrate`       | `(value, fromVersion) => T | undefined` | —              | Upgrade older persisted values; undefined discards them.           |

Also exported: `cookieStorage(options)` and `readSmartCookie(cookieHeader, key, options?)` (see the [cookie recipe](#custom-storage-and-the-no-flash-cookie-recipe)), plus `useSmartSelector`, `getSmartState`, `setSmartState` and `subscribeSmartState`.

## Development

```bash
bun install && bun run test   # or npm / pnpm / yarn
bun run typecheck && bun run build && bun run size
```

## License

[MIT](./LICENSE) © [Luigi Davide Micca](https://luigimicca.com)
