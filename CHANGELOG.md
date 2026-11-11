# Changelog

## [0.3.0](https://github.com/LuigiDavideMicca/smart-state/compare/v0.2.1...v0.3.0) (2026-11-11)


### ⚠ BREAKING CHANGES

* on the server, keyed state is per component and getSmartState/setSmartState do nothing; an expired ttl resets the state while the tab is open; setState(undefined) removes the entry; the same key on a different storage is a separate store; subscribeSmartState listeners only run when the value changes; useSmartSelector uses the latest selector.

### Features

* per-request state on the server, the stored value on the first render, and the sync bugs fixed ([f7c9900](https://github.com/LuigiDavideMicca/smart-state/commit/f7c9900429bfdecb4ffab73242ea4d5686d3801b))


### Bug Fixes

* a selector never sees server state, not even in the same tick ([fa0ef8e](https://github.com/LuigiDavideMicca/smart-state/commit/fa0ef8e805c084bcc2ec36d637cb09fadcaa7cc4))

## [0.2.1](https://github.com/LuigiDavideMicca/smart-state/compare/v0.2.0...v0.2.1) (2026-07-28)


### Bug Fixes

* **ci:** upgrade npm for the oidc token exchange ([6ce26dd](https://github.com/LuigiDavideMicca/smart-state/commit/6ce26dd2c385111784b032af81b7a21f5a64badc))

## [0.2.0](https://github.com/LuigiDavideMicca/smart-state/compare/smart-state-v0.1.0...smart-state-v0.2.0) (2026-07-28)


### Features

* accept standard schema validators ([2edb5c0](https://github.com/LuigiDavideMicca/smart-state/commit/2edb5c0cbda60391ac04a59186bd082d8cfade44))
* add custom storage and a cookie adapter ([758def7](https://github.com/LuigiDavideMicca/smart-state/commit/758def7ed9128d2b35489bf592ff2f0f372360fa))
* merge stored objects with defaults ([899832a](https://github.com/LuigiDavideMicca/smart-state/commit/899832aa34eebcfc750bc5bfa57622e98a367a78))
* sync tabs over a broadcast channel ([435e4c6](https://github.com/LuigiDavideMicca/smart-state/commit/435e4c633dd6bd252d1777360d7c85573ebed3b2))
