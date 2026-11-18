/* Marbles standalone export shim: defines window.host for use outside the Marbles app. */
;(function () {
  'use strict'
  if (window.__marblesShim) return
  window.__marblesShim = true

  var PREFIX = 'marbles:__APP_ID__:'
  var mem = new Map()
  var useMem = false

  function checkKey(key) {
    if (typeof key !== 'string' || !key)
      throw new TypeError('host.storage: key must be a non-empty string')
  }
  function toJson(v) {
    if (v === undefined)
      throw new TypeError('host.storage.set: value must be JSON-serializable (got undefined)')
    var s
    try {
      s = JSON.stringify(v)
    } catch (e) {
      throw new TypeError(
        'host.storage.set: value must be JSON-serializable (' + (e && e.message) + ')'
      )
    }
    if (s === undefined) throw new TypeError('host.storage.set: value must be JSON-serializable')
    return s
  }
  function wrap(fn) {
    return function () {
      try {
        return Promise.resolve(fn.apply(null, arguments))
      } catch (e) {
        return Promise.reject(e)
      }
    }
  }
  function parse(raw) {
    if (raw === null || raw === undefined) return undefined
    try {
      return JSON.parse(raw)
    } catch (e) {
      return undefined
    }
  }
  function lsGet(k) {
    if (!useMem) {
      try {
        return localStorage.getItem(PREFIX + k)
      } catch (e) {
        useMem = true
      }
    }
    return mem.has(k) ? mem.get(k) : null
  }
  function lsSet(k, s) {
    if (!useMem) {
      try {
        localStorage.setItem(PREFIX + k, s)
        return
      } catch (e) {
        useMem = true
      }
    }
    mem.set(k, s)
  }
  function lsRemove(k) {
    if (!useMem) {
      try {
        localStorage.removeItem(PREFIX + k)
        return
      } catch (e) {
        useMem = true
      }
    }
    mem.delete(k)
  }
  function lsKeys() {
    if (!useMem) {
      try {
        var out = []
        for (var i = 0; i < localStorage.length; i++) {
          var name = localStorage.key(i)
          if (name && name.indexOf(PREFIX) === 0) out.push(name.slice(PREFIX.length))
        }
        return out
      } catch (e) {
        useMem = true
      }
    }
    return Array.from(mem.keys())
  }

  // The app's files, embedded at export time: [{ name, mime, size, width?, height?, base64, text? }].
  var ASSETS = __ASSETS__
  function findAsset(name) {
    if (typeof name !== 'string' || !name) throw new TypeError('host.assets: name must be a string')
    var bare = name.replace(/^\.?\/?assets\//, '')
    for (var i = 0; i < ASSETS.length; i++) if (ASSETS[i].name === bare) return ASSETS[i]
    throw new Error('host.assets: this app has no file called ' + bare)
  }

  var unavailable = function (name) {
    return function () {
      return Promise.reject(new Error('host.' + name + ' is not available outside the Marbles app'))
    }
  }

  // Exported apps have no Marbles to schedule for them; a failed notification shouldn't break them.
  var notify = function () {
    return Promise.reject(new Error('host.notify is not available outside the Marbles app'))
  }
  notify.cancel = function () {
    return Promise.resolve()
  }
  notify.list = function () {
    return Promise.resolve([])
  }

  window.host = {
    storage: {
      get: wrap(function (key) {
        checkKey(key)
        return parse(lsGet(key))
      }),
      set: wrap(function (key, value) {
        checkKey(key)
        lsSet(key, toJson(value))
      }),
      remove: wrap(function (key) {
        checkKey(key)
        lsRemove(key)
      }),
      keys: wrap(function () {
        return lsKeys()
      })
    },
    ai: unavailable('ai'),
    fetch: unavailable('fetch'),
    notify: notify,
    assets: {
      list: wrap(function () {
        return ASSETS.map(function (a) {
          var o = { name: a.name, mime: a.mime, size: a.size }
          if (a.width) o.width = a.width
          if (a.height) o.height = a.height
          return o
        })
      }),
      text: wrap(function (name) {
        var a = findAsset(name)
        if (a.text === undefined)
          throw new Error('host.assets.text: ' + a.name + " isn't text. Use host.assets.base64.")
        return a.text
      }),
      base64: wrap(function (name) {
        return findAsset(name).base64
      })
    }
  }
  try {
    Object.freeze(window.host.assets)
    Object.freeze(window.host.storage)
    Object.freeze(notify)
    Object.freeze(window.host)
  } catch (e) {
    /* ignore */
  }
})()
