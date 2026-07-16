# smart-state

React's `useState`, grown up: **persistent, shared across components and tabs, TTL expiry, versioned migrations, runtime validation, debounced writes, SSR/Next.js-safe** — with no provider, zero dependencies and **~1.4 kB** min+gzip.

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

Storage data is user-editable and survives your releases — treat it as untrusted input:

```tsx
const [user, setUser] = useSmartState<User>(guest, {
  persist: true,
  storageKey: 'user',
  parse: userSchema.parse, // zod, valibot, or any (value: unknown) => T that throws
  version: 2,
  migrate: (old, fromVersion) =>
    fromVersion === 1 ? upgradeV1(old) : undefined // undefined = discard
})
```

`parse` runs on every read and cross-tab message; anything invalid falls back to the initial value (and reaches `onError`). `version`/`migrate` upgrade values persisted by previous releases instead of crashing on old shapes.

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

## Sharing state with Vue

`smart-state` uses the same storage format as its sibling [`vue-smart-state`](https://github.com/LuigiDavideMicca/vue-smart-state) (TTL envelope included): a React app and a Vue app on the same origin can share persisted state out of the box.

## How it compares

| | `smart-state` | `use-local-storage-state` | `usehooks-ts` | `zustand` + persist |
| --- | :-: | :-: | :-: | :-: |
| Drop-in `useState` API (lazy init, updater) | ✅ | partial | partial | ❌ (store API) |
| Shared across components, no provider | ✅ | ✅ | ❌ | ✅ |
| Cross-tab sync | ✅ | ✅ | ✅ | via extra code |
| TTL / expiry | ✅ | ❌ | ❌ | ❌ |
| Versioned migrations | ✅ | ❌ | ❌ | ✅ |
| Runtime validation (`parse`, schema-friendly) | ✅ | ❌ | ❌ | ❌ |
| Selector subscriptions (slice re-renders) | ✅ | ❌ | ❌ | ✅ |
| Debounced writes + flush on page hide | ✅ | ❌ | ❌ | ❌ |
| Type-enforced options, typed key registry | ✅ | ❌ | ❌ | ❌ |
| Imperative access outside React | ✅ | ❌ | ❌ | ✅ |
| Cross-framework storage format (Vue sibling) | ✅ | ❌ | ❌ | ❌ |
| Size (min+gzip, no deps) | **~1.4 kB** | ~1.9 kB | part of a suite | ~3+ kB |

Built on `useSyncExternalStore`: concurrent-mode correct, tearing-safe, and re-renders only the components that use the key.

## Options

| Option          | Type                                     | Default        | Description                                                        |
| --------------- | ---------------------------------------- | -------------- | ------------------------------------------------------------------ |
| `persist`       | `boolean`                                | `false`        | Persist to web storage (requires `storageKey`).                    |
| `storageKey`    | `string`                                 | —              | Storage key; also the sharing key across components.               |
| `storageType`   | `'local' \| 'session'`                   | `'local'`      | Which storage to use.                                              |
| `syncTabs`      | `boolean`                                | `false`        | Sync the value across tabs.                                        |
| `ttl`           | `number`                                 | —              | Milliseconds a persisted value stays fresh.                        |
| `writeDebounce` | `number`                                 | —              | Debounce storage writes; flushed on `pagehide`.                    |
| `serializer`    | `{ read(raw): T; write(value): string }` | JSON           | Custom (de)serialization.                                          |
| `onError`       | `(error, context) => void`               | `console.warn` | Called on read/write/sync failures.                                |
| `parse`         | `(value: unknown) => T`                  | —              | Validate untrusted data from storage/sync (throw to reject).       |
| `version`       | `number`                                 | —              | Schema version of the persisted value.                             |
| `migrate`       | `(value, fromVersion) => T | undefined` | —              | Upgrade older persisted values; undefined discards them.           |

## Development

```bash
bun install && bun run test   # or npm / pnpm / yarn
bun run typecheck && bun run build && bun run size
```

## License

[MIT](./LICENSE) © [Luigi Davide Micca](https://luigimicca.com)
