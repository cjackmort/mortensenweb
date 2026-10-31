// Vendored from cjackmort/website-business, .claude/skills/noise-backdrop/web/noise-backdrop.js.
// Change it there and copy it here; the two should stay identical below this line.
/**
 * <noise-backdrop>: a full-bleed, slowly moving domain-warped noise field. No dependencies.
 *
 *   <noise-backdrop fixed preset="smoke"></noise-backdrop>
 *   <script type="module" src="/js/noise-backdrop.js"></script>
 *
 * The field is a port of the marbled smoke behind Jack Mortensen's portfolio
 * (cjackmort/Portfolio, src/components/SmokeBackground.jsx): value noise, fbm of five
 * octaves each rotated and doubled by mat2(1,-1.2,.2,1.2)*2, warped by itself
 * (fbm -> noise -> fbm), sampled three times with tiny UV offsets (.003/.006) so the
 * channels part into a faint colour fringe, then tinted by luminance and lifted out of a
 * dark floor. With the smoke preset and no other attributes it draws that page's frames.
 * The other presets keep the same field and change only how it is coloured.
 *
 * It fills its own box (give it a size), or with `fixed` the viewport, behind everything,
 * ignoring the pointer. Without WebGL it shows `background` as a plain colour; with
 * prefers-reduced-motion it draws one still frame. It pauses off-screen and in hidden tabs.
 *
 * Attributes (all optional; a preset sets defaults, any attribute overrides them)
 *   preset      smoke (default) | aurora | topo | ink.
 *   color       Hex tint, or up to three space-separated hexes. smoke: the tint. aurora: the
 *               bands' colours. topo: lines, then index lines. ink: ink, then its sheen.
 *   background  Hex colour under the field, or "transparent": the canvas then draws only the
 *               field, as `color` at partial alpha, over whatever is behind it.
 *   intensity   How far the field rises out of the background, 0-1. Alias: opacity.
 *   speed       Time multiplier. Default 1.
 *   scale       Feature size; 2 is twice as large. Default 1.
 *   warp        Strength of the self-warp, 0 is plain fbm. Default 1.
 *   chroma      Size of the channel offsets, 0 is none. Default 1.
 *   contrast    Contrast of the field about its middle. Default 1.
 *   fade        Seconds the field takes to rise in on arrival. smoke default 10, as the original.
 *   seed        Shifts the pattern in time, so two backdrops differ. Default 0.
 *   fps         Frame-rate cap. Default 60.
 *   resolution  Render scale, 0.1-1; the canvas is stretched to fit. 0.5 costs a quarter. Default 1.
 *   fixed       Boolean: cover the viewport, fixed, behind the page.
 *
 * el.ready resolves true once it is drawing, false if it fell back to the plain colour.
 * el.setTime(seconds) draws the frame at that time with the fade complete and stops the clock.
 * el.frameTime() is the time one frame takes on the GPU, in ms, for checking a budget.
 */

const MAX_DPR = 2
const MAX_STEP_S = 0.1 // a long frame (tab switch, jank) never jumps the field
const T0 = 660 // the original's time offset: where its field starts
const FRAME_SLACK_MS = 4 // so a 30 fps cap on a 60 Hz screen draws every other frame, not every third

// Each preset: look (how the field is coloured) and default attributes.
const PRESETS = {
  smoke: { look: 0, color: '#c0c0c0', background: '#141414', intensity: 1, speed: 1, scale: 1, warp: 1, chroma: 1, contrast: 1, fade: 10 },
  aurora: { look: 1, color: '#34f5c5 #3b82f6 #c084fc', background: '#050816', intensity: 1, speed: 0.6, scale: 1.3, warp: 1.5, chroma: 0, contrast: 1, fade: 3 },
  topo: { look: 2, color: '#3d5a4a #24392e', background: '#efeadf', intensity: 0.75, speed: 0.2, scale: 1.8, warp: 0.3, chroma: 0, contrast: 1, fade: 2 },
  ink: { look: 3, color: '#0b0c0f #aeb6c2', background: '#f2f0eb', intensity: 1, speed: 0.5, scale: 1.2, warp: 1.6, chroma: 2, contrast: 2.2, fade: 2 },
}
const NUMBERS = ['intensity', 'speed', 'scale', 'warp', 'chroma', 'contrast', 'fade', 'seed', 'fps', 'resolution']
const ATTRIBUTES = ['preset', 'color', 'background', 'opacity', 'fixed', ...NUMBERS]

// The original's field, kept line for line; the uniforms default to its constants.
const FRAGMENT = `
uniform vec2 uRes;
uniform float uT, uScale, uWarp, uChroma, uContrast, uK;
uniform int uLook, uMode; // mode 0 dark ground, 1 light ground, 2 transparent
uniform vec3 uBg, uC1, uC2, uC3;

const vec3 LUMA = vec3(.21, .71, .07); // the original's weights
const float MID = .03125;              // the field's mean: 1 - (1+.5+.25+.125+.0625)/2

float rnd(vec2 p){p=fract(p*vec2(12.9898,78.233));p+=dot(p,p+34.56);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);return mix(mix(rnd(i),rnd(i+vec2(1,0)),u.x),mix(rnd(i+vec2(0,1)),rnd(i+1.),u.x),u.y);}
float fbm(vec2 p){float t=.0,a=1.;for(int i=0;i<5;i++){t+=a*noise(p);p*=mat2(1,-1.2,.2,1.2)*2.;a*=.5;}return t;}

// Anti-aliased contour lines of x: 1 on a line w pixels wide, 0 between.
float contour(float x, float w) {
  float d = abs(fract(x - .5) - .5) / max(fwidth(x), 1e-4);
  return 1. - smoothstep(w - 1., w, d);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - .5 * uRes) / uRes.y;
  uv.x += .25;
  uv *= vec2(2, 1);
  uv /= uScale;

  float n = fbm(uv * .28 - vec2(uT * .01, 0));
  n = noise(uv * 3. + n * 2. * uWarp) * uWarp;
  vec2 drift = vec2(0, uT * .015);
  float o1 = .003 * uChroma, o2 = .006 * uChroma;
  vec3 c = 1. - vec3(fbm(uv + drift + n),
                     fbm(uv * (1. + o1) + drift + n + o1),
                     fbm(uv * (1. + o2) + drift + n + o2));
  c = (c - MID) * uContrast + MID;

  // Each look gives a colour and how much of it covers the ground, per channel.
  vec3 col = uC1, cover = clamp(c, 0., 1.);
  if (uLook == 0) {
    // smoke: the original. Bright where the field is high, tinted by its luminance, and
    // never below the ground. On a light ground, the same picture in negative.
    if (uMode == 1) { col = 1. - mix(c, 1. - uC1, dot(c, LUMA)); cover = step(col, uBg); }
    else if (uMode == 0) { col = clamp(mix(c, uC1, dot(c, LUMA)), 0., 1.); cover = step(uBg, col); }
  } else if (uLook == 1) {
    // aurora: luminous ribbons along the warped field, the three colours cycling across them.
    float v = dot(c, LUMA);
    float s = v * .4 + uv.y * .75 + uv.x * .06 + uT * .004;
    vec3 w = pow(.5 + .5 * cos(6.2832 * (s - vec3(0., .3333, .6667))), vec3(6.));
    col = (w.x * uC1 + w.y * uC2 + w.z * uC3) / (w.x + w.y + w.z);
    float ribbon = .12 + .88 * pow(.5 + .5 * cos(6.2832 * (v * 1.3 + uv.y * .25)), 3.);
    cover = vec3(ribbon * (.45 + .55 * smoothstep(-.6, .6, v)));
  } else if (uLook == 2) {
    // topo: contour lines of the warped field, every fifth one heavier.
    vec3 x = c * 12.;
    vec3 minor = vec3(contour(x.r, 1.), contour(x.g, 1.), contour(x.b, 1.));
    vec3 major = vec3(contour(x.r * .2, 1.8), contour(x.g * .2, 1.8), contour(x.b * .2, 1.8));
    col = mix(uC1, uC2, step(.5, dot(major, LUMA)));
    cover = max(minor * .55, major);
  } else {
    // ink: the field cut at its mean into ink and paper, a steel sheen in ribbons inside
    // the ink where the field folds, and the channels' fringe along every edge.
    cover = smoothstep(-.03, .03, MID - c);
    float d = MID - dot(c, LUMA);
    float sheen = (1. - smoothstep(0., .07, abs(d - .22))) * .9 + (1. - smoothstep(0., .04, abs(d - .05))) * .5;
    col = mix(uC1, uC2, sheen);
  }

  cover *= uK;
  if (uMode == 2) {
    float a = max(cover.r, max(cover.g, cover.b));
    OUT = vec4(min(col * cover, vec3(a)), a); // premultiplied
  } else {
    OUT = vec4(mix(uBg, col, cover), 1.);
  }
}`

const VERTEX = `
IN vec2 aPos;
void main() { gl_Position = vec4(aPos, 0., 1.); }`

const SOURCES = {
  webgl2: {
    vertex: `#version 300 es\n#define IN in\n${VERTEX}`,
    fragment: `#version 300 es\nprecision highp float;\nprecision highp int;\nout vec4 OUT;\n${FRAGMENT}`,
  },
  webgl: {
    vertex: `#define IN attribute\n${VERTEX}`,
    fragment: `#extension GL_OES_standard_derivatives : enable
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define OUT gl_FragColor
${FRAGMENT}`,
  },
}

// Zero specificity, so any rule of the page's own wins.
const STYLE = `:where(noise-backdrop){display:block;position:relative;overflow:hidden;pointer-events:none}
:where(noise-backdrop[fixed]){position:fixed;inset:0;z-index:-1}
:where(noise-backdrop>canvas){position:absolute;inset:0;width:100%;height:100%;display:block}`

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

const hexColor = (hex = '') => {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]
  const n = parseInt(h, 16)
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
  return shader
}

function createProgram(gl, { vertex, fragment }) {
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
  const uniforms = {}
  for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
    const { name } = gl.getActiveUniform(program, i)
    uniforms[name] = gl.getUniformLocation(program, name)
  }
  return { program, uniforms }
}

// WebGL2, else WebGL1 with derivatives (topo's lines need fwidth), else nothing.
function getContext(canvas) {
  const options = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' }
  const gl2 = canvas.getContext('webgl2', options)
  if (gl2) return { gl: gl2, sources: SOURCES.webgl2 }
  const gl1 = canvas.getContext('webgl', options)
  if (gl1?.getExtension('OES_standard_derivatives')) return { gl: gl1, sources: SOURCES.webgl }
  return null
}

class NoiseBackdrop extends HTMLElement {
  static get observedAttributes() { return ATTRIBUTES }

  constructor() {
    super()
    this.ready = new Promise((resolve) => { this._resolveReady = resolve })
    this._time = 0
    this._elapsed = 0
    this._inView = true
    this._manual = false
    this._onChange = () => this._update()
  }

  // An attribute, else the preset's value, else the smoke preset's.
  _setting(name) {
    const preset = PRESETS[this.getAttribute('preset')] ?? PRESETS.smoke
    const raw = this.getAttribute(name) ?? (name === 'intensity' ? this.getAttribute('opacity') : null)
    if (!NUMBERS.includes(name)) return raw ?? preset[name]
    const n = parseFloat(raw)
    return Number.isFinite(n) ? n : preset[name] ?? { seed: 0, fps: 60, resolution: 1 }[name]
  }

  connectedCallback() {
    if (!document.getElementById('noise-backdrop-style')) {
      const style = document.createElement('style')
      style.id = 'noise-backdrop-style'
      style.textContent = STYLE
      document.head.append(style)
    }
    this.setAttribute('aria-hidden', 'true')
    reducedMotion.addEventListener('change', this._onChange)
    document.addEventListener('visibilitychange', this._onChange)
    if (!this._start()) this._fallBack()
  }

  disconnectedCallback() {
    reducedMotion.removeEventListener('change', this._onChange)
    document.removeEventListener('visibilitychange', this._onChange)
    this._teardown()
  }

  attributeChangedCallback() {
    if (!this.gl) { if (this._fellBack) this._fallBack(); return }
    this._readSettings()
    this._resize()
    if (!this._raf) this._draw()
  }

  _start() {
    const canvas = document.createElement('canvas')
    const context = getContext(canvas)
    if (!context) return false
    const { gl, sources } = context
    try {
      Object.assign(this, createProgram(gl, sources))
    } catch (err) {
      console.warn('noise-backdrop: showing the plain background.', err)
      return false
    }
    gl.useProgram(this.program)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(this.program, 'aPos')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    this._onLost = () => { this._teardown(); this._fallBack() }
    canvas.addEventListener('webglcontextlost', this._onLost)
    Object.assign(this, { canvas, gl })
    this._fellBack = false
    this.style.background = ''
    this.append(canvas)
    this._readSettings()
    this._resizeObserver = new ResizeObserver(() => { this._resize(); if (!this._raf) this._draw() })
    this._resizeObserver.observe(this)
    this._intersection = new IntersectionObserver(([entry]) => { this._inView = entry.isIntersecting; this._update() })
    this._intersection.observe(this)
    this._resize()
    this._draw()
    this._resolveReady(true)
    this._update()
    return true
  }

  _fallBack() {
    this._fellBack = true
    const bg = this._setting('background')
    this.style.background = hexColor(bg) ? bg : ''
    this._resolveReady(false)
  }

  _readSettings() {
    const { gl, uniforms: u } = this
    const preset = PRESETS[this.getAttribute('preset')] ?? PRESETS.smoke
    const colors = String(this._setting('color')).split(/\s+/).map(hexColor).filter(Boolean)
    const fallbackColors = preset.color.split(/\s+/).map(hexColor)
    const [c1, c2 = c1, c3 = c2] = colors.length ? colors : fallbackColors
    const bgName = String(this._setting('background')).trim().toLowerCase()
    const bg = hexColor(bgName)
    const transparent = bgName === 'transparent' || bgName === 'none' || !bg
    gl.uniform1i(u.uLook, preset.look)
    gl.uniform1i(u.uMode, transparent ? 2 : luma(bg) > 0.5 ? 1 : 0)
    gl.uniform3fv(u.uBg, bg ?? [0, 0, 0])
    gl.uniform3fv(u.uC1, c1)
    gl.uniform3fv(u.uC2, c2)
    gl.uniform3fv(u.uC3, c3)
    gl.uniform1f(u.uScale, Math.max(0.05, this._setting('scale')))
    gl.uniform1f(u.uWarp, Math.max(0, this._setting('warp')))
    gl.uniform1f(u.uChroma, this._setting('chroma'))
    gl.uniform1f(u.uContrast, Math.max(0, this._setting('contrast')))
    this._intensity = clamp(this._setting('intensity'), 0, 1)
    this._speed = this._setting('speed')
    this._fade = Math.max(0, this._setting('fade'))
    this._seed = this._setting('seed')
    this._frameMs = 1000 / clamp(this._setting('fps'), 1, 240)
    this._scaleRes = clamp(this._setting('resolution'), 0.1, 1)
  }

  // Starts, pauses or resumes from the current conditions. Reduced motion draws one still.
  _update() {
    if (!this.gl || this._manual) return
    const moving = !reducedMotion.matches && this._inView && document.visibilityState === 'visible'
    if (moving) this._run()
    else { this._stop(); if (reducedMotion.matches) this._draw() }
  }

  _resize() {
    const { canvas, gl } = this
    const scale = Math.min(MAX_DPR, devicePixelRatio || 1) * this._scaleRes
    const w = Math.max(1, Math.round(this.clientWidth * scale)), h = Math.max(1, Math.round(this.clientHeight * scale))
    if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h })
    gl.viewport(0, 0, w, h)
  }

  _draw() {
    const { gl, uniforms: u, canvas } = this
    const still = this._manual || reducedMotion.matches
    const fade = still || !this._fade ? 1 : Math.min(this._elapsed / this._fade, 1)
    gl.uniform2f(u.uRes, canvas.width, canvas.height)
    gl.uniform1f(u.uT, T0 + this._seed + this._time * this._speed)
    gl.uniform1f(u.uK, fade * this._intensity)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  _run() {
    if (this._raf) return
    let last = performance.now(), lastDraw = -Infinity
    const tick = (now) => {
      this._raf = requestAnimationFrame(tick)
      const dt = Math.min(MAX_STEP_S, (now - last) / 1000)
      last = now
      this._time += dt
      this._elapsed += dt
      if (now - lastDraw < this._frameMs - FRAME_SLACK_MS) return
      lastDraw = now
      this._draw()
    }
    this._raf = requestAnimationFrame(tick)
  }

  _stop() {
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = 0
  }

  _teardown() {
    this._stop()
    this._resizeObserver?.disconnect()
    this._intersection?.disconnect()
    this.canvas?.removeEventListener('webglcontextlost', this._onLost)
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext()
    this.canvas?.remove()
    this.gl = null
  }

  setTime(seconds) {
    if (!this.gl) return false
    this._manual = true
    this._stop()
    this._time = seconds
    this._draw()
    return true
  }

  // Reading a pixel back waits for the GPU to finish everything queued before it;
  // gl.finish() returns at once in Chromium, so it measures nothing.
  frameTime(frames = 30) {
    if (!this.gl) return null
    const gl = this.gl, pixel = new Uint8Array(4)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    const start = performance.now()
    for (let i = 0; i < frames; i++) this._draw()
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return (performance.now() - start) / frames
  }
}

if (!customElements.get('noise-backdrop')) customElements.define('noise-backdrop', NoiseBackdrop)

export { NoiseBackdrop, PRESETS }
