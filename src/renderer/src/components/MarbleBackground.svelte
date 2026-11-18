<script lang="ts">
  /**
   * Slow-moving marbled colour with film grain, in a soft semicircle rising
   * from the bottom of its parent. Purely decorative: it ignores the pointer
   * and is hidden from assistive tech. The parent must be positioned (it fills
   * it with inset: 0).
   *
   * The colour draws at half resolution and caps at 30 fps, stops while the
   * window is hidden, and shows one still frame when the OS asks for reduced
   * motion. With no WebGL it falls back to a static CSS gradient. The grain is
   * a separate overlay at device pixels, so it stays fine however the colour
   * is scaled.
   *
   * While `active` (an app is being made) the marble drifts about 2.5x faster
   * and rises a little higher, easing in and out over a second or two.
   *
   * When the screen closes because an app was just built, the marble swells to
   * fill the pane and dissolves while the new app fades in over it.
   */
  import { onMount } from 'svelte'
  import { cubicOut } from 'svelte/easing'
  import type { TransitionConfig } from 'svelte/transition'
  import { settings } from '../lib/stores/settings.svelte'
  import { ui } from '../lib/stores/ui.svelte'

  let { active = false }: { active?: boolean } = $props()

  let canvas = $state<HTMLCanvasElement>()
  let ready = $state(false)
  let fallback = $state(false)
  let grain = $state<{ url: string; size: number } | null>(null)

  const dark = $derived(settings.resolvedTheme === 'dark')
  /** Set once WebGL is up: draws one frame now. */
  let redraw: (() => void) | null = null

  const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

  // Domain-warped fbm (noise fed back into its own coordinates) gives the
  // marbled streaks; the colours come from the logo. The semicircle shape is a
  // CSS mask, so the shader just fills the canvas.
  const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uDark;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Three octaves: smooth enough for the colour bands.
float fbm3(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v / 0.875;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;            // 0..1, y up
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y) * 1.1;
  float t = uTime * 0.03;

  // Two rounds of warping with the smooth, low-detail noise, so the streaks
  // stay broad and silky like the logo instead of turning into mottled blobs.
  vec2 q = vec2(fbm3(p + vec2(0.0, t)), fbm3(p + vec2(5.2, 1.3) - t * 0.8));
  vec2 r = vec2(
    fbm3(p + 2.2 * q + vec2(1.7, 9.2) + t * 1.1),
    fbm3(p + 2.2 * q + vec2(8.3, 2.8) - t * 0.9)
  );
  // A sine of the warped field repeats, so every part of the screen gets a
  // few bands instead of one colour filling a whole noise cell.
  float w = fbm3(p + 2.0 * r) + 0.35 * uv.x;
  float f = 0.5 + 0.5 * sin(w * 9.0 - t * 2.0);

  vec3 green = vec3(0.30, 0.56, 0.25);
  vec3 olive = vec3(0.58, 0.58, 0.30);
  vec3 pink  = vec3(0.95, 0.58, 0.67);
  vec3 sand  = vec3(0.84, 0.76, 0.54);
  vec3 cream = vec3(0.94, 0.88, 0.81);

  // The warped field's contour lines become the bands: green, olive, a pink
  // vein, then sand and cream, in the logo's order.
  vec3 col = green;
  col = mix(col, olive, smoothstep(0.04, 0.22, f));
  col = mix(col, pink,  smoothstep(0.28, 0.42, f));
  col = mix(col, sand,  smoothstep(0.55, 0.70, f));
  col = mix(col, cream, smoothstep(0.82, 0.96, f));

  float a = 0.9;

  if (uDark > 0.5) {
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), col, 0.8) * 0.92;
    a *= 0.9;
  }

  // One step of dither so the smooth gradients don't band.
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * a, a);
}
`

  /**
   * Exit: only after a build (any other way of leaving is instant). `t` runs
   * 1 to 0; the marble grows the whole way and holds its colour for the first
   * half before fading out.
   */
  function bloom(node: Element): TransitionConfig {
    if (!ui.justBuilt || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return { duration: 0 }
    }
    node.classList.add('blooming')
    return {
      duration: 900,
      easing: cubicOut,
      css: (t) => `--bloom: ${1 - t}; opacity: ${Math.min(1, t * 2)};`
    }
  }

  /** A tile of soft monochrome noise, one texel per device pixel. */
  function makeGrain(): { url: string; size: number } | null {
    const px = 192
    const c = document.createElement('canvas')
    c.width = c.height = px
    const ctx = c.getContext('2d')
    if (!ctx) return null
    const img = ctx.createImageData(px, px)
    for (let i = 0; i < img.data.length; i += 4) {
      // The mean of two randoms clusters around mid-grey: gentler than flat noise.
      const v = ((Math.random() + Math.random()) / 2) * 255
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    return { url: c.toDataURL(), size: px / Math.max(1, devicePixelRatio) }
  }

  onMount(() => {
    grain = makeGrain()
    if (!canvas) return undefined
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power'
    })
    if (!gl) {
      fallback = true
      return undefined
    }

    const compile = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type)
      if (!s) return null
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn('MarbleBackground shader:', gl.getShaderInfoLog(s))
        return null
      }
      return s
    }
    const vs = compile(gl.VERTEX_SHADER, VERT)
    const fs = compile(gl.FRAGMENT_SHADER, FRAG)
    const prog = gl.createProgram()
    if (!vs || !fs || !prog) {
      fallback = true
      return undefined
    }
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('MarbleBackground link:', gl.getProgramInfoLog(prog))
      fallback = true
      return undefined
    }
    gl.useProgram(prog)

    // One triangle that covers the whole viewport.
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const uRes = gl.getUniformLocation(prog, 'uRes')
    const uTime = gl.getUniformLocation(prog, 'uTime')
    const uDark = gl.getUniformLocation(prog, 'uDark')

    const reduce = matchMedia('(prefers-reduced-motion: reduce)')
    // Shader time is a phase we advance ourselves, so the speed can change
    // without the pattern jumping. Starting mid-loop means the first frame
    // already looks marbled.
    const STILL = 40
    let phase = STILL
    let energy = 0
    let raf = 0
    let last = 0
    let lost = false

    const resize = (): void => {
      if (!canvas) return undefined
      // Half of a CSS pixel per canvas pixel; the colour is soft, so nobody can tell.
      const scale = 0.5
      const w = Math.max(1, Math.round(canvas.clientWidth * scale))
      const h = Math.max(1, Math.round(canvas.clientHeight * scale))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
      }
    }

    const draw = (time: number): void => {
      if (lost) return
      gl.uniform2f(uRes, canvas!.width, canvas!.height)
      gl.uniform1f(uTime, time)
      gl.uniform1f(uDark, dark ? 1 : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      if (now - last < 1000 / 30) return
      // Clamp so a long pause (a hidden window) doesn't jump the pattern.
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 0
      last = now
      energy += ((active ? 1 : 0) - energy) * Math.min(1, dt * 1.5)
      phase += dt * (1 + 1.5 * energy)
      draw(phase)
    }

    const start = (): void => {
      cancelAnimationFrame(raf)
      resize()
      last = 0
      if (reduce.matches) draw(STILL)
      else if (!document.hidden) raf = requestAnimationFrame(frame)
    }

    redraw = () => draw(reduce.matches ? STILL : phase)
    const ro = new ResizeObserver(() => {
      resize()
      // A resize clears the canvas, so redraw straight away, even when paused.
      redraw?.()
    })
    ro.observe(canvas)

    const onVisibility = (): void => {
      if (document.hidden) cancelAnimationFrame(raf)
      else start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    reduce.addEventListener('change', start)

    const onLost = (e: Event): void => {
      e.preventDefault()
      lost = true
      cancelAnimationFrame(raf)
      fallback = true
    }
    canvas.addEventListener('webglcontextlost', onLost)

    start()
    ready = true

    return () => {
      redraw = null
      cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      reduce.removeEventListener('change', start)
      canvas?.removeEventListener('webglcontextlost', onLost)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  })

  // The theme only changes a uniform; with reduced motion there is no loop to pick it up.
  $effect(() => {
    void dark
    redraw?.()
  })
</script>

<div class="marble" class:dark class:active aria-hidden="true" out:bloom|global>
  <div class="shape" class:fallback>
    {#if !fallback}
      <canvas bind:this={canvas} class:ready></canvas>
    {/if}
    {#if grain}
      <div
        class="grain"
        style:background-image="url({grain.url})"
        style:background-size="{grain.size}px {grain.size}px"
      ></div>
    {/if}
  </div>
</div>

<style>
  .marble {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    overflow: hidden;
    container-type: size;
  }
  /* Registered so the radius can transition when the marble rises. */
  @property --r {
    syntax: '<length>';
    inherits: false;
    initial-value: 0px;
  }
  /* A semicircle on the bottom edge, solid in the middle and feathered out. */
  .shape {
    --r: min(46cqw, 58cqh);
    transition: --r 1.6s var(--ease);
    position: absolute;
    inset: 0;
    mask-image: radial-gradient(circle var(--r) at 50% 100%, #000 50%, transparent 100%);
  }
  .active .shape {
    --r: min(62cqw, 85cqh);
  }
  /* Leaving after a build: rise above the incoming app (clicks still pass
     through) and swell from wherever it was to past the corners. */
  .marble:global(.blooming) {
    z-index: 2;
  }
  .marble:global(.blooming) .shape {
    --r: calc(min(62cqw, 85cqh) * (1 + var(--bloom, 0) * 1.6));
    transition: none;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    opacity: 0;
    transition: opacity 900ms var(--ease);
  }
  canvas.ready {
    opacity: 1;
  }
  .fallback {
    background:
      radial-gradient(60% 45% at 25% 100%, rgb(51 125 43 / 0.55), transparent 70%),
      radial-gradient(50% 40% at 55% 100%, rgb(242 145 168 / 0.6), transparent 70%),
      radial-gradient(55% 45% at 85% 100%, rgb(214 194 135 / 0.6), transparent 70%);
  }
  .dark .fallback {
    opacity: 0.6;
  }
  /* Grain only shifts the colour under it, a little lighter or darker. */
  .grain {
    position: absolute;
    inset: 0;
    image-rendering: pixelated;
    mix-blend-mode: soft-light;
    opacity: 0.15;
    animation: grain 0.6s steps(1) infinite;
  }
  @keyframes grain {
    0% {
      background-position: 0 0;
    }
    20% {
      background-position: -37px 23px;
    }
    40% {
      background-position: 61px -47px;
    }
    60% {
      background-position: -13px -71px;
    }
    80% {
      background-position: 83px 41px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    canvas,
    .shape {
      transition: none;
    }
    .grain {
      animation: none;
    }
  }
</style>
