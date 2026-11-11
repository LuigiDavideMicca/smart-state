// @vitest-environment node
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { cookieStorage, useSmartSelector, useSmartState } from '../src/index'

describe('SSR (no window)', () => {
  it('renders without window and without crashing', () => {
    function C() {
      const [v] = useSmartState('light', { persist: true, storageKey: 'ssr-basic', storage: cookieStorage() })
      return createElement('span', null, v)
    }
    expect(renderToString(createElement(C))).toBe('<span>light</span>')
  })

  it('keyed stores are module singletons on the server, so request 2 renders request 1 initial value', () => {
    // A real app passes per-request data (e.g. the theme cookie read in a Server Component, or the user's name)
    function Theme({ fromCookie }: { fromCookie: string }) {
      const [theme] = useSmartState(fromCookie, { persist: true, storageKey: 'ssr-theme', storage: cookieStorage() })
      return createElement('span', null, theme)
    }
    const requestA = renderToString(createElement(Theme, { fromCookie: 'dark' }))
    const requestB = renderToString(createElement(Theme, { fromCookie: 'light' }))
    expect(requestA).toBe('<span>dark</span>')
    expect(requestB).toBe('<span>light</span>') // observed: <span>dark</span>
  })

  it('server-side setState leaks into every later request (cross-request state sharing)', () => {
    function Greeter({ user }: { user: string }) {
      const [name, setName] = useSmartState('guest', { persist: true, storageKey: 'ssr-user' })
      if (name !== user) setName(user) // render-phase sync of request data, a common pattern
      return createElement('span', null, name)
    }
    renderToString(createElement(Greeter, { user: 'alice' }))
    function Anonymous() {
      const [name] = useSmartState('guest', { persist: true, storageKey: 'ssr-user' })
      return createElement('span', null, name)
    }
    function Selector() {
      return createElement('b', null, useSmartSelector<string, string>('ssr-user', (v) => v ?? 'none'))
    }
    expect(renderToString(createElement('div', null, createElement(Anonymous), createElement(Selector)))).toBe(
      '<div><span>guest</span><b>none</b></div>'
    ) // observed: <b>alice</b> — another user's data in an anonymous request
  })
})

describe('SSR isolation', () => {
  function Selector() {
    return createElement('b', null, useSmartSelector<string, string>('ssr-iso', (v) => v ?? 'none'))
  }

  it('a selector never sees server state, not even an owner rendered in the same tick', async () => {
    function Owner({ initial }: { initial: string }) {
      const [v] = useSmartState(initial, { persist: true, storageKey: 'ssr-iso' })
      return createElement('span', null, v)
    }
    expect(renderToString(createElement('div', null, createElement(Owner, { initial: 'alice' }), createElement(Selector)))).toBe(
      '<div><span>alice</span><b>none</b></div>'
    )
    expect(renderToString(createElement(Selector))).toBe('<b>none</b>')
    // two renders in one synchronous segment, as a prerender loop does
    expect(renderToString(createElement('div', null, createElement(Owner, { initial: 'bob' }), createElement(Selector)))).toBe(
      '<div><span>bob</span><b>none</b></div>'
    )
  })

  it('imperative APIs never expose server state', async () => {
    const { getSmartState } = await import('../src/index')
    expect(getSmartState('ssr-user')).toBeUndefined()
  })
})
