// A field of spins on a plane receding to the horizon: each point is teal
// (+1) or amber (−1) by the sign of a slowly travelling wave, and fades to
// dark where the wave crosses zero, so domain walls drift through the lattice.
// The pointer drops ripples into it. Pure decoration for the home hero, drawn
// with raw WebGL (a few thousand points, one draw call): it pauses off screen
// and in background tabs, caps the pixel ratio, and draws one still frame
// under prefers-reduced-motion. Without WebGL it renders nothing.
import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/motion";

const COLS = 150;
const RIPPLES = 8;
const NEAR = 2.0;
const FAR = 26.0;
const FOCAL = 1.1;

const VERT = `
attribute vec2 a_uv;
uniform float u_time;
uniform float u_aspect;
uniform float u_dpr;
uniform float u_horizon;
uniform float u_camh;
uniform vec4 u_rip[${RIPPLES}];
varying float v_h;
varying float v_a;
varying float v_e;

void main() {
  float inv = mix(1.0 / ${NEAR.toFixed(1)}, 1.0 / ${FAR.toFixed(1)}, a_uv.y);
  float z = 1.0 / inv;
  float x = a_uv.x * z * u_aspect / ${FOCAL.toFixed(2)} * 1.08;

  float t = u_time;
  float h = sin(x * 0.55 + t * 0.42) * 0.30
          + cos(z * 0.95 - t * 0.36) * 0.16
          + sin((x + z) * 0.31 - t * 0.21) * 0.12;
  float e = 0.0;
  for (int i = 0; i < ${RIPPLES}; i++) {
    vec4 r = u_rip[i];
    float age = t - r.z;
    if (r.w > 0.0 && age >= 0.0 && age < 4.0) {
      float d = distance(vec2(x, z), r.xy);
      float w = r.w * sin(d * 2.4 - age * 4.2) * exp(-d * 0.42) * exp(-age * 1.25);
      h += w;
      e += abs(w);
    }
  }
  v_h = h;
  v_e = e;
  v_a = smoothstep(${FAR.toFixed(1)}, 11.0, z) * smoothstep(${NEAR.toFixed(1)} - 0.05, 2.35, z);

  float sy = (h * 0.55 - u_camh) * ${FOCAL.toFixed(2)} / z + u_horizon;
  float sx = x * ${FOCAL.toFixed(2)} / (z * u_aspect);
  gl_Position = vec4(sx, sy, 0.0, 1.0);
  gl_PointSize = clamp(3.8 * u_dpr * (${NEAR.toFixed(1)} / z) + 0.6 * u_dpr, 1.0, 7.0 * u_dpr);
}`;

const FRAG = `
precision mediump float;
varying float v_h;
varying float v_a;
varying float v_e;
uniform vec3 u_up;
uniform vec3 u_down;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = dot(c, c);
  if (r > 0.25) discard;
  float soft = smoothstep(0.25, 0.02, r);
  float k = smoothstep(0.015, 0.28, abs(v_h));
  vec3 col = mix(vec3(0.20, 0.26, 0.25), v_h > 0.0 ? u_up : u_down, k);
  // ripples from the pointer glow a little brighter than the resting field
  float glow = clamp(v_e * 3.0, 0.0, 1.0);
  col = mix(col, vec3(0.92, 1.0, 0.97), glow * 0.35);
  float a = soft * v_a * (0.22 + 0.98 * k) * (1.0 + glow * 1.4);
  gl_FragColor = vec4(col * a, a);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

/**
 * `horizon` is where the far edge of the plane sits, in clip space (-1 bottom,
 * 1 top); the camera height follows so the nearest row always meets the
 * bottom edge. `rows` sets the depth resolution; keep row spacing on screen
 * close to the column spacing so the lattice reads as dots, not streaks.
 */
export function SpinField({ className = "", horizon = 0.3, rows = 56 }: { className?: string; horizon?: number; rows?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: "low-power" });
    if (!gl) return;

    let prog: WebGLProgram;
    try {
      prog = gl.createProgram()!;
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    } catch {
      return;
    }
    gl.useProgram(prog);

    const ROWS = rows;
    const uv = new Float32Array(COLS * ROWS * 2);
    for (let j = 0, k = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        uv[k++] = (i / (COLS - 1)) * 2 - 1;
        uv[k++] = j / (ROWS - 1);
      }
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    const aUv = gl.getAttribLocation(prog, "a_uv");
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uTime = u("u_time"), uAspect = u("u_aspect"), uDpr = u("u_dpr"), uRip = u("u_rip[0]");
    const camH = ((horizon + 1) * NEAR) / FOCAL;
    gl.uniform1f(u("u_horizon"), horizon);
    gl.uniform1f(u("u_camh"), camH);
    gl.uniform3f(u("u_up"), 63 / 255, 216 / 255, 192 / 255);
    gl.uniform3f(u("u_down"), 242 / 255, 162 / 255, 92 / 255);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);

    const ripples = new Float32Array(RIPPLES * 4);
    let nextRipple = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    let aspect = 1;
    const resize = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      aspect = w / h;
      gl.viewport(0, 0, w, h);
    };
    resize();

    const t0 = performance.now();
    const now = () => (performance.now() - t0) / 1000;
    const draw = (t: number) => {
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uTime, t);
      gl.uniform1f(uAspect, aspect);
      gl.uniform1f(uDpr, dpr);
      gl.uniform4fv(uRip, ripples);
      gl.drawArrays(gl.POINTS, 0, COLS * ROWS);
    };

    const still = prefersReducedMotion();
    let raf = 0;
    let onScreen = true;
    const loop = () => {
      raf = 0;
      if (!onScreen || document.hidden) return;
      draw(now());
      raf = requestAnimationFrame(loop);
    };
    const wake = () => { if (!still && !raf && onScreen && !document.hidden) raf = requestAnimationFrame(loop); };

    // Where on the plane is the pointer? Invert the projection for height 0.
    let lastSpawn = 0;
    const drop = (clientX: number, clientY: number, amp: number) => {
      const r = canvas.getBoundingClientRect();
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return;
      const sx = ((clientX - r.left) / r.width) * 2 - 1;
      const sy = 1 - ((clientY - r.top) / r.height) * 2;
      if (sy > horizon - 0.02) return;
      const z = (camH * FOCAL) / (horizon - sy);
      if (z > FAR) return;
      const x = (sx * z * aspect) / FOCAL;
      ripples.set([x, z, now(), amp], nextRipple * 4);
      nextRipple = (nextRipple + 1) % RIPPLES;
    };
    const onMove = (e: PointerEvent) => {
      if (still || e.pointerType === "touch") return;
      const t = performance.now();
      if (t - lastSpawn < 90) return;
      lastSpawn = t;
      drop(e.clientX, e.clientY, 0.16);
    };
    const onDown = (e: PointerEvent) => { if (!still) drop(e.clientX, e.clientY, 0.5); };

    const ro = new ResizeObserver(() => { resize(); if (still) draw(3); });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; wake(); });
    io.observe(canvas);
    const onVis = () => wake();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });

    if (still) draw(3);
    else wake();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    };
  }, [horizon, rows]);

  return <canvas ref={ref} className={`spin-field ${className}`} aria-hidden="true" />;
}
