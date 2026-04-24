/**
 * SceneManager.ts — Owns the Three.js scene graph and render loop.
 *
 * Design decisions:
 *  - Plain TypeScript class, NOT a React component or singleton.
 *    Instantiated once inside ViewportCanvas.tsx via `useRef`, cleaned up in
 *    the `useEffect` return function.
 *  - Deliberately has NO dependency on the Zustand store. It exposes a
 *    `addBeforeRenderCallback` hook so other modules (GizmoController) can
 *    inject per-frame logic without SceneManager needing to know about them.
 *  - Camera presets are handled here because the camera is owned here.
 *
 * Render loop:
 *   requestAnimationFrame → onBeforeRender callbacks → OrbitControls.update()
 *   → renderer.render(scene, camera)
 *
 * The loop runs continuously (no pause when idle) to keep gizmo drag feeling
 * responsive. For battery-sensitive targets this could be changed to
 * render-on-demand, but that complicates the drag interaction.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export class SceneManager {
  readonly scene: THREE.Scene
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls

  /** Active camera — may be replaced when switching camera presets. */
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera

  /**
   * Registered per-frame callbacks. Each returns a `() => void` unsubscribe
   * function. Add via `addBeforeRenderCallback`, remove via the returned fn.
   * Set used instead of Array for O(1) removal.
   */
  private beforeRenderCallbacks: Set<() => void> = new Set()
  private animFrameId = 0
  private canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas

    // ---- Scene ----
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#1a1a2e')

    // Ambient light — soft fill so the box rig is visible from all angles.
    // No directional light intentionally: the outline-only rendering style
    // looks best with flat shading. Phase 4 may add a subtle directional light
    // for the muscle mesh.
    const ambient = new THREE.AmbientLight(0xffffff, 0.8)
    this.scene.add(ambient)
    // Subtle directional light for depth cues on the placeholder meshes.
    const dir = new THREE.DirectionalLight(0xffffff, 0.4)
    dir.position.set(3, 6, 4)
    this.scene.add(dir)

    // ---- Camera ----
    // Default FOV 50° ≈ a 50mm lens on full frame. z=5 gives a comfortable
    // initial view of a ~1.7m tall character at origin.
    const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1)
    const perspCam = new THREE.PerspectiveCamera(50, aspect, 0.05, 200)
    perspCam.position.set(0, 1, 4)
    perspCam.lookAt(0, 0.8, 0) // look at roughly the character's chest
    this.camera = perspCam
    this.scene.add(this.camera)

    // ---- Renderer ----
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // Preserve the drawing buffer so canvas.toBlob() works for PNG export.
      preserveDrawingBuffer: true,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    // Call handleResize immediately — canvas may already have a real size,
    // and we need the renderer/camera aspect correct before the first frame.
    this.handleResize(canvas.clientWidth || 800, canvas.clientHeight || 600)

    // ---- OrbitControls ----
    // Damping creates a smooth deceleration feel. enabledDamping requires
    // controls.update() to be called in the render loop (see startLoop).
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.target.set(0, 0.8, 0) // orbit around chest height

    this.startLoop()
  }

  // --------------------------------------------------------------------------
  // Render loop
  // --------------------------------------------------------------------------

  private startLoop(): void {
    const tick = () => {
      this.animFrameId = requestAnimationFrame(tick)
      // Run all registered per-frame callbacks (e.g. GizmoController drag update)
      this.beforeRenderCallbacks.forEach((fn) => fn())
      this.controls.update() // required when enableDamping = true
      this.renderer.render(this.scene, this.camera)
    }
    this.animFrameId = requestAnimationFrame(tick)
  }

  /**
   * Register a callback to run once per frame, before the scene renders.
   * @returns Unsubscribe function — call it to remove the callback.
   */
  addBeforeRenderCallback(fn: () => void): () => void {
    this.beforeRenderCallbacks.add(fn)
    return () => this.beforeRenderCallbacks.delete(fn)
  }

  // --------------------------------------------------------------------------
  // Resize handling
  // --------------------------------------------------------------------------

  /**
   * Update camera aspect and renderer size when the canvas container resizes.
   * Called by a ResizeObserver in ViewportCanvas.tsx.
   * Also called immediately in the constructor as a fallback in case
   * ResizeObserver fires asynchronously after the first frame.
   */
  handleResize(width: number, height: number): void {
    if (width === 0 || height === 0) return
    this.renderer.setSize(width, height, false) // false = don't set CSS size
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
    } else if (this.camera instanceof THREE.OrthographicCamera) {
      // camera.top stores the world-unit half-height of the view (set in setCameraPreset).
      // On resize we keep the vertical extent fixed and scale horizontal to match the new aspect.
      const hw = this.camera.top * (width / height)
      this.camera.left = -hw
      this.camera.right = hw
      this.camera.updateProjectionMatrix()
    }
  }

  // --------------------------------------------------------------------------
  // Camera preset switching
  // --------------------------------------------------------------------------

  /**
   * Switch to a named camera preset.
   * 'perspective' restores the free-orbit PerspectiveCamera.
   * Ortho presets create an OrthographicCamera locked to a fixed axis and
   * disable orbit rotation (pan and zoom still work).
   */
  setCameraPreset(preset: string): void {
    const canvas = this.canvas
    const w = canvas.clientWidth || 800
    const h = canvas.clientHeight || 600

    this.controls.enableRotate = preset === 'perspective'

    if (preset === 'perspective') {
      const perspCam = new THREE.PerspectiveCamera(50, w / h, 0.05, 200)
      perspCam.position.set(0, 1, 4)
      perspCam.lookAt(0, 0.8, 0)
      this.scene.remove(this.camera)
      this.camera = perspCam
      this.scene.add(this.camera)
      this.controls.object = perspCam
      this.controls.target.set(0, 0.8, 0)
    } else {
      // Orthographic cameras are sized to show a 4-unit tall view.
      // The aspect ratio adjustment keeps objects from appearing squashed.
      const aspect = w / h
      const viewHeight = 3.5 // world units visible vertically
      const vw = viewHeight * aspect
      // top = +half, bottom = -half so the view is vertically centered on the camera target.
      // Previously bottom=0 put the camera center at the very bottom edge, cutting off the feet.
      const orthoCam = new THREE.OrthographicCamera(-vw, vw, viewHeight / 2, -viewHeight / 2, 0.05, 200)

      if (preset === 'ortho-front') {
        orthoCam.position.set(0, 0.8, 10)
        orthoCam.lookAt(0, 0.8, 0)
      } else if (preset === 'ortho-side') {
        orthoCam.position.set(10, 0.8, 0)
        orthoCam.lookAt(0, 0.8, 0)
      } else if (preset === 'ortho-top') {
        orthoCam.position.set(0, 10, 0)
        orthoCam.lookAt(0, 0, 0)
        orthoCam.up.set(0, 0, -1) // flip up vector so +Z points "up" in the top view
      }

      this.scene.remove(this.camera)
      this.camera = orthoCam
      this.scene.add(this.camera)
      this.controls.object = orthoCam
    }

    this.controls.update()
    this.handleResize(w, h)
  }

  /** Return the camera to its default perspective position and orientation. */
  resetCamera(): void {
    this.setCameraPreset('perspective')
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  /** Stop the render loop and release all GPU resources. */
  dispose(): void {
    cancelAnimationFrame(this.animFrameId)
    this.controls.dispose()
    this.renderer.dispose()
  }
}
