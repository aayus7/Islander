// Liquid glass, rendered on the GPU (WebGL2).
//
// Input: a live picture of the screen *behind* the panel (streamed by the backend while
// the AI panel is open). The shader then does what real glass does:
//   • refraction: near the rim the image bends inward (the glass is thicker there)
//   • chromatic dispersion: red/blue split slightly at the rim
//   • frost: a soft blur + saturation boost (Apple's glass looks "richer" than what's behind)
//   • tint: dark at the top for readable text, clearing to see-through glass at the bottom
//   • specular rim light: a thin bright edge, brightest where it faces the light (top-left)
// When no live picture is available (e.g. the browser preview), it falls back to CSS
// backdrop-filter, which works there because the wallpaper is part of the same page.

import { motion, type MotionValue } from "motion/react";
import { useEffect, useRef } from "react";
import { bridge } from "../bridge";

/* ---------- live frames from the backend ---------- */

let latest: ImageBitmap | null = null;
let version = 0;
let listening = false;
let pending: string | null = null;
let decoding = false;

function startFrames() {
  if (listening) return;
  listening = true;
  bridge.onGlassFrame((url) => {
    pending = url;
    pump();
  });
}

async function pump() {
  if (decoding || !pending) return;
  decoding = true;
  const url = pending;
  pending = null;
  try {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob);
    latest?.close();
    latest = bmp;
    version++;
  } catch {
    /* skip bad frame */
  }
  decoding = false;
  if (pending) pump();
}

export function clearGlassFrames() {
  latest?.close();
  latest = null;
  version++;
}

/* ---------- shader ---------- */

const VERT = `#version 300 es
in vec2 a; out vec2 vUv;
void main(){ vUv = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex;
uniform vec2 uSize;      // panel size in CSS px
uniform float uRadius;   // corner radius in CSS px
uniform float uHasTex;   // 0 → no live picture yet
uniform float uClearFrom;// px from the bottom where the glass starts to clear
uniform float uTintTop;  // darkness at the top (0..1)
uniform float uTintBottom; // darkness at the very bottom (0..1)

float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q,0.0)) + min(max(q.x,q.y),0.0) - r; }

vec3 tap(vec2 uv){ return texture(uTex, clamp(uv, 0.002, 0.998)).rgb; }

vec3 frosted(vec2 uv, float rad){
  // 13-tap disk blur, radius in uv units
  vec3 c = tap(uv) * 0.2;
  const int N = 12;
  for (int i = 0; i < N; i++) {
    float a = 6.2831853 * float(i) / float(N);
    float r = (i % 2 == 0) ? 1.0 : 0.55;
    c += tap(uv + vec2(cos(a), sin(a)) * rad * r) * (0.8 / float(N));
  }
  return c;
}

void main(){
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uSize;        // top-left origin
  vec2 c = px - uSize * 0.5;
  float d = sdRound(c, uSize * 0.5, uRadius);        // < 0 inside

  // Surface normal from the distance field.
  vec2 e = vec2(1.0, 0.0);
  vec2 n = normalize(vec2(
    sdRound(c + e.xy, uSize * 0.5, uRadius) - sdRound(c - e.xy, uSize * 0.5, uRadius),
    sdRound(c + e.yx, uSize * 0.5, uRadius) - sdRound(c - e.yx, uSize * 0.5, uRadius)) + 1e-5);

  // Refraction: strongest at the rim, fading over a 24px band → a convex lens edge.
  // Kept gentle: a strong bend stretches the picture into streaks along the rim.
  float band = 22.0;
  float t = clamp(1.0 + d / band, 0.0, 1.0);
  float bend = t * t * (3.0 - 2.0 * t) * t;           // smooth onset, no hard crease
  vec2 shift = -n * bend * 12.0;                      // pull the picture inward at the edge
  vec2 uv = px / uSize;
  vec2 inv = 1.0 / uSize;

  vec3 col;
  if (uHasTex > 0.5) {
    // Light frost, a little heavier at the rim so the bend never shows raw pixels.
    float rad = (3.5 + 6.0 * bend) * inv.x + 0.0025;
    vec2 base = uv + shift * inv;
    vec2 disp = n * bend * 0.6 * inv;                 // barely-there dispersion: no rainbow fringes
    col.r = frosted(base + disp, rad).r;
    col.g = frosted(base, rad).g;
    col.b = frosted(base - disp, rad).b;
    // Apple-like richness: lift saturation, keep it slightly dim so text stays readable.
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), col, 1.25) * 0.92;
  } else {
    col = vec3(0.07);
  }

  // Tint: near-black at the top, clearing toward the bottom like the iOS card.
  float fromBottom = uSize.y - px.y;
  float clearT = smoothstep(uClearFrom, 0.0, fromBottom);
  float tint = mix(uTintTop, uTintBottom, clearT);
  col = mix(col, vec3(0.0), tint);

  // Specular rim: thin bright edge, brighter facing the light (top-left), plus a faint
  // inner glow along the bottom where light exits the glass.
  float rim = smoothstep(1.8, 0.0, abs(d + 1.0));
  float facing = max(dot(-n, normalize(vec2(-0.55, -0.85))), 0.0);   // top-left light
  float under = max(dot(-n, vec2(0.0, 1.0)), 0.0) * clearT;            // bright lip along the clear bottom
  col += rim * (0.08 + 0.26 * facing + 0.55 * under);
  float inner = smoothstep(14.0, 0.0, -d) * (1.0 - smoothstep(0.0, uSize.y * 0.5, px.y));
  col += inner * 0.035;

  o = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
  return s;
}

/* ---------- component ---------- */

interface Props {
  width: number;
  /** Live panel height/radius (spring-animated): read every frame, no re-renders. */
  height: MotionValue<number>;
  radius: MotionValue<number>;
  /** px from the bottom over which the tint clears into glass */
  clearFrom: number;
  /** Canvas is sized for this max height; the visible part follows `height`. */
  maxHeight: number;
  /** Darkness at the top and the very bottom (0 = clear glass, 1 = black). */
  tintTop: number;
  tintBottom: number;
}

/**
 * Build the glass shader once ahead of time, on a throwaway canvas, a moment after start-up.
 * The graphics driver keeps the compiled result, so the first time Search or Ask opens the
 * glass is ready on its first frame instead of stalling while the shader compiles.
 */
let warmed = false;
export function warmGlass() {
  if (warmed || !bridge.isNative) return;
  warmed = true;
  try {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 2;
    const gl = cv.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: false });
    if (!gl) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    /* nothing to warm: the panel still works, just compiles on first open */
  }
}

export function LiquidGlass({ width, height, radius, clearFrom, maxHeight, tintTop, tintBottom }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const props = useRef({ width, clearFrom, tintTop, tintBottom });
  props.current = { width, clearFrom, tintTop, tintBottom };
  const native = bridge.isNative;

  useEffect(() => {
    if (!native) return;
    startFrames();
    const cv = canvas.current!;
    const gl = cv.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: false });
    if (!gl) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const U = (n: string) => gl.getUniformLocation(prog, n);
    const uSize = U("uSize"), uRadius = U("uRadius"), uHasTex = U("uHasTex"), uClear = U("uClearFrom");
    const uTop = U("uTintTop"), uBot = U("uTintBottom");

    let raf = 0;
    let seen = -1;
    let lastKey = "";
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { width: w, clearFrom: cf, tintTop: tt, tintBottom: tb } = props.current;
      const h = Math.max(1, height.get());
      const r = Math.min(radius.get(), h / 2);
      const dpr = window.devicePixelRatio || 1;
      // No live picture yet: stay invisible (the island's own black shows) instead of
      // flashing a dark placeholder for the first few frames.
      const vis = latest ? "1" : "0";
      if (cv.style.opacity !== vis) cv.style.opacity = vis;
      const key = `${w}x${h}x${r}x${cf}x${dpr}x${tt}x${tb}`;
      if (key === lastKey && seen === version) return; // nothing changed: skip the GPU work
      lastKey = key;
      const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
      if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
      }
      if (seen !== version && latest) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, latest);
      }
      seen = version;
      gl.viewport(0, 0, W, H);
      gl.uniform2f(uSize, w, h);
      gl.uniform1f(uRadius, r);
      gl.uniform1f(uHasTex, latest ? 1 : 0);
      gl.uniform1f(uClear, cf);
      gl.uniform1f(uTop, tt);
      gl.uniform1f(uBot, tb);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [native, height, radius]);

  void maxHeight;
  if (!native) {
    // Preview fallback: real backdrop blur over the page's wallpaper.
    return (
      <motion.div
        className="glass-fallback"
        style={{ width, height, ["--clear" as string]: `${clearFrom}px`, ["--top" as string]: tintTop, ["--bot" as string]: tintBottom }}
      />
    );
  }
  return <motion.canvas ref={canvas} className="glass-canvas" style={{ width, height }} />;
}
