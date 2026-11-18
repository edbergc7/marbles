/* Marbles slider fill: keeps --p in sync on input.slider. Shared by shim.js (in-app) and
   export-shim.js (standalone export); both loaders append this file to their shim script. */
;(function () {
  'use strict'
  if (window.__marblesSliderShim) return
  window.__marblesSliderShim = true

  function syncSlider(el) {
    if (!el || el.type !== 'range') return
    var min = el.min === '' ? 0 : parseFloat(el.min)
    var max = el.max === '' ? 100 : parseFloat(el.max)
    var v = parseFloat(el.value)
    var p = max > min ? ((v - min) / (max - min)) * 100 : 0
    el.style.setProperty('--p', Math.max(0, Math.min(100, p)) + '%')
  }
  function syncAll(root) {
    var list = (root || document).querySelectorAll('input.slider')
    for (var i = 0; i < list.length; i++) syncSlider(list[i])
  }
  function isSlider(t) {
    return t && t.tagName === 'INPUT' && t.classList && t.classList.contains('slider')
  }
  ;['input', 'change'].forEach(function (type) {
    document.addEventListener(
      type,
      function (e) {
        if (isSlider(e.target)) syncSlider(e.target)
      },
      true
    )
  })
  // Programmatic .value = x: patch the setter on range inputs.
  try {
    var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    if (desc && desc.set) {
      Object.defineProperty(HTMLInputElement.prototype, 'value', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (v) {
          desc.set.call(this, v)
          if (this.type === 'range' && this.classList.contains('slider')) syncSlider(this)
        }
      })
    }
  } catch (e) {
    /* ignore */
  }
  // Also catch min/max changes and newly added sliders.
  function observe() {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i]
        if (m.type === 'attributes') {
          if (isSlider(m.target)) syncSlider(m.target)
        } else {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var n = m.addedNodes[j]
            if (n.nodeType !== 1) continue
            if (isSlider(n)) syncSlider(n)
            if (n.querySelectorAll) syncAll(n)
          }
        }
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['min', 'max', 'value', 'class']
    })
  }
  observe()

  function ready() {
    syncAll()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready)
  else ready()
})()
