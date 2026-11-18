/* Marbles sandbox shim: defines window.host and talks to the parent renderer via postMessage. */
;(function () {
  'use strict'
  if (window.__marblesShim) return
  window.__marblesShim = true

  // ---------- lockdown ----------
  // WebRTC opens network connections that skip the frame's CSP and host.fetch's local-network
  // guard, so its API is removed before any app code runs. Each name becomes a locked
  // undefined that app code can't redefine or delete. An <iframe> gets a fresh realm even under
  // frame-src 'none' (its initial about:blank), so every child window is locked down the same
  // way when the app can first reach it: contentWindow/contentDocument, its load event (fired
  // synchronously on insert), or a DOM change. Best effort: main also limits WebRTC to proxied
  // UDP, which there isn't, and stops child frames from navigating.
  var RTC_NAME = /^(webkit)?RTC/
  var LOCKED = typeof Symbol === 'function' ? Symbol('marbles') : '__marblesLocked'

  function lock(obj, name, value) {
    try {
      delete obj[name]
    } catch (e) {
      /* ignore */
    }
    try {
      Object.defineProperty(obj, name, {
        value: value,
        writable: false,
        enumerable: false,
        configurable: false
      })
    } catch (e) {
      /* ignore */
    }
  }

  function removeWebRTC(w) {
    // The interfaces live on the global itself; check the prototype chain too in case.
    for (var o = w; o; o = Object.getPrototypeOf(o)) {
      var names = Object.getOwnPropertyNames(o)
      for (var i = 0; i < names.length; i++) if (RTC_NAME.test(names[i])) lock(o, names[i])
    }
  }

  function hookFrameAccess(w) {
    ;['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement', 'HTMLEmbedElement'].forEach(
      function (n) {
        var proto = w[n] && w[n].prototype
        if (!proto) return
        ;['contentWindow', 'contentDocument'].forEach(function (prop) {
          var d = Object.getOwnPropertyDescriptor(proto, prop)
          if (!d || !d.get) return
          var get = d.get
          Object.defineProperty(proto, prop, {
            configurable: false,
            enumerable: d.enumerable,
            get: function () {
              var v = get.call(this)
              if (v) lockDown(prop === 'contentWindow' ? v : v.defaultView)
              return v
            }
          })
        })
        var svg = proto.getSVGDocument
        if (typeof svg === 'function') {
          lock(proto, 'getSVGDocument', function getSVGDocument() {
            var doc = svg.call(this)
            if (doc) lockDown(doc.defaultView)
            return doc
          })
        }
      }
    )
  }

  function lockChildren(w) {
    try {
      for (var i = 0; i < w.length; i++) lockDown(w[i])
    } catch (e) {
      /* ignore */
    }
  }

  function watchFrames(w) {
    var doc = w.document
    function onLoad(e) {
      var t = e.target
      // the hooked getter locks the child down
      if (t && t.nodeType === 1 && 'contentWindow' in t) void t.contentWindow
      lockChildren(w)
    }
    function arm(target) {
      target.addEventListener('load', onLoad, true)
    }
    arm(doc)
    // document.open() drops every listener on the document; put ours back.
    var docProto = w.Document && w.Document.prototype
    var open = docProto && docProto.open
    if (typeof open === 'function') {
      lock(docProto, 'open', function () {
        var r = open.apply(this, arguments)
        if (this === doc) arm(doc)
        return r
      })
    }
    // Load events in a shadow tree never reach the document.
    var elProto = w.Element && w.Element.prototype
    var attach = elProto && elProto.attachShadow
    if (typeof attach === 'function') {
      lock(elProto, 'attachShadow', function attachShadow() {
        var root = attach.apply(this, arguments)
        arm(root)
        return root
      })
    }
    new w.MutationObserver(function () {
      lockChildren(w)
    }).observe(doc, { childList: true, subtree: true })
  }

  function lockDown(w) {
    try {
      if (!w || w[LOCKED]) return
      lock(w, LOCKED, true)
      removeWebRTC(w)
      // A child window has no business opening anything.
      if (w !== window) {
        lock(w, 'open', function open() {
          return null
        })
      }
      hookFrameAccess(w)
      watchFrames(w)
    } catch (e) {
      /* cross-origin or gone */
    }
  }
  lockDown(window)

  // ---------- links ----------
  // The frame can't open popups (no allow-popups) and may not navigate away, so a link would
  // either do nothing or replace the app with an error page. Ask the host instead: main shows
  // the person a prompt before anything opens in their browser.
  function openLink(url) {
    try {
      var u = new URL(String(url), location.href)
      if (u.protocol === 'http:' || u.protocol === 'https:') post({ kind: 'open', url: u.href })
    } catch (e) {
      /* ignore */
    }
  }
  lock(window, 'open', function open(url) {
    if (url !== undefined && url !== null && String(url) !== '') openLink(url)
    return null
  })
  // Bubble phase on window: the app's own handlers have run and may have cancelled the click.
  window.addEventListener('click', function (e) {
    var t = e.target
    var a = t && t.closest ? t.closest('a[href], area[href]') : null
    if (!a || typeof a.href !== 'string' || e.defaultPrevented) return
    if (!/^https?:/i.test(a.href)) return
    e.preventDefault()
    openLink(a.href)
  })

  var parent = window.parent
  function post(msg) {
    msg.__marbles = 1
    try {
      parent.postMessage(msg, '*')
    } catch (e) {
      /* ignore */
    }
  }

  // ---------- host bridge ----------
  var nextId = 1
  var pending = new Map()
  var TIMEOUT = { ai: 180000 }

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = nextId++
      var ms = TIMEOUT[method] || 30000
      var timer = setTimeout(function () {
        pending.delete(id)
        reject(new Error('host.' + method + ' timed out after ' + ms / 1000 + 's'))
      }, ms)
      pending.set(id, { resolve: resolve, reject: reject, timer: timer })
      post({ kind: 'call', id: id, method: method, args: args })
    })
  }

  function checkKey(key) {
    if (typeof key !== 'string' || !key)
      throw new TypeError('host.storage: key must be a non-empty string')
  }
  function toJson(v) {
    if (v === undefined)
      throw new TypeError('host.storage.set: value must be JSON-serializable (got undefined)')
    try {
      var s = JSON.stringify(v)
      if (s === undefined) throw new Error('not serializable')
      return JSON.parse(s)
    } catch (e) {
      throw new TypeError(
        'host.storage.set: value must be JSON-serializable (' + (e && e.message) + ')'
      )
    }
  }
  function wrap(fn) {
    return function () {
      try {
        return fn.apply(null, arguments)
      } catch (e) {
        return Promise.reject(e)
      }
    }
  }

  // ---------- images and PDFs for host.ai ----------
  var MAX_EDGE = 2000
  var SEND_AS_IS = 4 * 1024 * 1024

  function readDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader()
      r.onload = function () {
        resolve(r.result)
      }
      r.onerror = function () {
        reject(new Error('host.ai: could not read the file'))
      }
      r.readAsDataURL(blob)
    })
  }

  /** A File/Blob, canvas, <img> or data: URL → an image data: URL, shrunk if large. */
  function toImage(x, i) {
    if (typeof x === 'string') {
      if (x.indexOf('data:image/') === 0) return Promise.resolve(x)
      return Promise.reject(
        new TypeError('host.ai: images[' + i + '] must be a File, Blob, canvas or data: URL')
      )
    }
    if (x && typeof x.toDataURL === 'function') return Promise.resolve(x.toDataURL('image/png'))
    var source = x
    if (x && x.tagName === 'IMG') {
      if (!x.complete || !x.naturalWidth)
        return Promise.reject(new Error('host.ai: images[' + i + '] has not loaded'))
    } else if (!(x instanceof Blob) || x.type.indexOf('image/') !== 0) {
      return Promise.reject(new TypeError('host.ai: images[' + i + '] must be an image file'))
    }
    return createImageBitmap(source).then(function (bmp) {
      var big = Math.max(bmp.width, bmp.height) > MAX_EDGE
      var blob = x instanceof Blob ? x : null
      if (blob && !big && blob.type !== 'image/gif' && blob.size <= SEND_AS_IS) {
        bmp.close()
        return readDataUrl(blob)
      }
      var scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height))
      var c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(bmp.width * scale))
      c.height = Math.max(1, Math.round(bmp.height * scale))
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
      bmp.close()
      var jpeg = blob && blob.type === 'image/jpeg'
      return c.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.9)
    })
  }

  /** A PDF File/Blob or data: URL → { name, data }. */
  function toPdf(x, i) {
    if (typeof x === 'string') {
      if (x.indexOf('data:application/pdf') === 0) return Promise.resolve({ data: x })
    } else if (
      x instanceof Blob &&
      (x.type === 'application/pdf' || /\.pdf$/i.test(x.name || ''))
    ) {
      return readDataUrl(x).then(function (url) {
        // A .pdf with no type reads as application/octet-stream; the bytes are checked in main.
        var data = url.replace(/^data:[^;,]*/, 'data:application/pdf')
        return x.name ? { name: String(x.name), data: data } : { data: data }
      })
    }
    return Promise.reject(new TypeError('host.ai: files[' + i + '] must be a PDF file'))
  }

  /** Copies opts with images and files turned into data: URLs (other options untouched). */
  function prepareMedia(opts) {
    if (opts.images === undefined && opts.files === undefined) return Promise.resolve(opts)
    if (opts.images !== undefined && !Array.isArray(opts.images))
      return Promise.reject(new TypeError('host.ai: images must be an array'))
    if (opts.files !== undefined && !Array.isArray(opts.files))
      return Promise.reject(new TypeError('host.ai: files must be an array'))
    return Promise.all([
      Promise.all((opts.images || []).map(toImage)),
      Promise.all((opts.files || []).map(toPdf))
    ]).then(function (r) {
      var o = {}
      for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k]
      if (opts.images !== undefined) o.images = r[0]
      if (opts.files !== undefined) o.files = r[1]
      return o
    })
  }

  // ---------- notifications ----------
  var notify = wrap(function (opts) {
    if (typeof opts === 'string') opts = { message: opts }
    if (!opts || typeof opts !== 'object')
      throw new TypeError('host.notify: options object required')
    return call('notify', [toJson(opts)])
  })
  notify.cancel = wrap(function (id) {
    if (typeof id !== 'string') throw new TypeError('host.notify.cancel: id must be a string')
    return call('notify.cancel', [id])
  })
  notify.list = wrap(function () {
    return call('notify.list', [])
  })

  window.host = {
    storage: {
      get: wrap(function (key) {
        checkKey(key)
        return call('storage.get', [key])
      }),
      set: wrap(function (key, value) {
        checkKey(key)
        return call('storage.set', [key, toJson(value)])
      }),
      remove: wrap(function (key) {
        checkKey(key)
        return call('storage.remove', [key])
      }),
      keys: wrap(function () {
        return call('storage.keys', [])
      })
    },
    ai: wrap(function (opts) {
      if (typeof opts === 'string') opts = { prompt: opts }
      if (!opts || typeof opts !== 'object') throw new TypeError('host.ai: options object required')
      if (opts.saveAs !== undefined && (typeof opts.saveAs !== 'string' || !opts.saveAs))
        throw new TypeError('host.ai: saveAs must be a storage key')
      return prepareMedia(opts).then(function (o) {
        return call('ai', [toJson(o)])
      })
    }),
    notify: notify,
    fetch: wrap(function (url, init) {
      if (typeof url !== 'string' && !(url && typeof url.href === 'string')) {
        throw new TypeError('host.fetch: url must be a string')
      }
      return call('fetch', [String(url.href || url), init ? toJson(init) : undefined])
    }),
    assets: {
      list: wrap(function () {
        return call('assets.list', [])
      }),
      text: wrap(function (name) {
        if (typeof name !== 'string' || !name)
          throw new TypeError('host.assets: name must be a string')
        return call('assets.text', [name])
      }),
      base64: wrap(function (name) {
        if (typeof name !== 'string' || !name)
          throw new TypeError('host.assets: name must be a string')
        return call('assets.base64', [name])
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

  // ---------- incoming messages ----------
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return
    var d = event.data
    if (!d || d.__marbles !== 1) return
    if (d.kind === 'result') {
      var p = pending.get(d.id)
      if (!p) return
      pending.delete(d.id)
      clearTimeout(p.timer)
      if (d.ok) p.resolve(d.value)
      else p.reject(new Error(typeof d.error === 'string' ? d.error : 'Unknown error'))
    } else if (d.kind === 'theme') {
      var root = document.documentElement
      root.setAttribute('data-theme', d.theme === 'light' ? 'light' : 'dark')
      if (typeof d.accent === 'string') root.style.setProperty('--accent', d.accent)
    }
  })

  // ---------- error capture ----------
  var errCount = 0
  var recent = new Map()
  function report(err) {
    if (errCount >= 50) return
    var key = err.kind + '|' + err.message
    var now = Date.now()
    var last = recent.get(key)
    if (last && now - last < 1000) return
    recent.set(key, now)
    errCount++
    err.ts = new Date().toISOString()
    post({ kind: 'error', error: err })
  }
  function str(v) {
    try {
      if (v instanceof Error) return v.message || String(v)
      if (typeof v === 'string') return v
      return JSON.stringify(v) || String(v)
    } catch (e) {
      return String(v)
    }
  }

  window.addEventListener(
    'error',
    function (e) {
      var t = e.target
      if (t && t !== window && t.nodeType === 1) {
        var tag = t.tagName
        if (tag === 'SCRIPT' || tag === 'LINK' || tag === 'IMG') {
          var url = t.src || t.href || ''
          var what = tag === 'SCRIPT' ? 'script' : tag === 'LINK' ? 'stylesheet' : 'image'
          report({ kind: 'resource', message: 'Failed to load ' + what + ': ' + url, source: url })
        }
        return
      }
      report({
        kind: 'error',
        message: e.message || str(e.error),
        source: e.filename || undefined,
        line: e.lineno || undefined,
        col: e.colno || undefined,
        stack: e.error && e.error.stack ? String(e.error.stack) : undefined
      })
    },
    true
  )
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason
    report({
      kind: 'unhandledrejection',
      message: 'Unhandled promise rejection: ' + str(r),
      stack: r && r.stack ? String(r.stack) : undefined
    })
  })
  var origConsoleError = console.error
  console.error = function () {
    try {
      var parts = []
      for (var i = 0; i < arguments.length; i++) parts.push(str(arguments[i]))
      var first = arguments[0]
      report({
        kind: 'console',
        message: parts.join(' '),
        stack: first instanceof Error && first.stack ? String(first.stack) : undefined
      })
    } catch (e) {
      /* ignore */
    }
    return origConsoleError.apply(console, arguments)
  }

  // ---------- key forwarding ----------
  window.addEventListener(
    'keydown',
    function (e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      var k = (e.key || '').toLowerCase()
      if (k === 'n' || k === 'j' || k === 'b' || k === 'k' || k === ',') {
        e.preventDefault()
        post({ kind: 'key', key: k, shift: !!e.shiftKey })
      }
    },
    true
  )

  // ---------- ready ----------
  function ready() {
    post({ kind: 'ready' })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready)
  else ready()
})()
