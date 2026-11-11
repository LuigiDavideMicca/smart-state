// Type-level checks: run `bunx tsc --noEmit -p .` — each "Unused '@ts-expect-error'" is a README promise the types break.
import { useSmartState, useSmartSelector, type StandardSchemaV1 } from '../src/index'

export function readmePromises(flag: boolean) {
  // README: "ttl, syncTabs, serializer, version only exist alongside persist — using them without it is a type error"
  // @ts-expect-error ttl without persist
  useSmartState(0, { ttl: 1000 })
  // @ts-expect-error syncTabs without persist
  useSmartState(0, { syncTabs: true })
  // @ts-expect-error persist:false + storageKey + ttl
  useSmartState(0, { persist: false, storageKey: 'k', ttl: 5 })

  // README options table: persist is `boolean` — a runtime flag should be accepted
  useSmartState(0, { persist: flag, storageKey: 'k' })

  // README: "T is inferred from the schema output" — a schema whose output disagrees with the initial value should not compile
  const User: StandardSchemaV1<unknown, { name: string }> = {
    '~standard': { version: 1, vendor: 'x', validate: (v) => ({ value: v as { name: string } }) }
  }
  // @ts-expect-error initial value does not match schema output
  useSmartState(42, { persist: true, storageKey: 'u', schema: User })

  // useState parity: a union initial value widens
  const [t, setT] = useSmartState<'light' | 'dark'>('light')
  setT('dark')
  void t

  // selector over an unregistered key: the selector type param is not tied to the stored type
  const n: number = useSmartSelector<string, number>('k', (s) => (s ?? '').length)
  void n
}
