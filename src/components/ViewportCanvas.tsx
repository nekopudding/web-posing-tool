/**
 * ViewportCanvas.tsx — React component that owns the Three.js lifecycle.
 *
 * Responsibilities:
 *  1. Mount the <canvas> element and pass it to SceneManager.
 *  2. Create CharacterManager / GizmoController / GridOverlay instances.
 *  3. Wire Zustand store → Three.js via subscriptions (not React renders).
 *  4. Observe canvas container size changes and notify SceneManager.
 *  5. Clean up all Three.js resources on unmount.
 *
 * ============================================================================
 * ZUSTAND → THREE.JS SYNC PATTERN
 * ============================================================================
 *
 * Problem: pose updates happen at 60fps during a drag. If we used React
 * useEffect with `characters` as a dependency, every pose change would
 * trigger React reconciliation — that's expensive and causes jank.
 *
 * Solution: use Zustand's `store.subscribe(selector, callback)` API.
 * This calls the callback synchronously when the selected slice changes,
 * completely outside of React's scheduler. Three.js objects are mutated
 * directly. React's useEffect is only used for low-frequency changes like
 * adding/removing characters, toggling the grid, or changing camera preset.
 *
 * ============================================================================
 * SPLIT SUBSCRIPTIONS — POSE RESET FIX
 * ============================================================================
 *
 * Previously a single subscription watched `state.characters`. Any store
 * write (updateMorph, updateLayer) creates a new characters array, which
 * fired the subscription and called applyPoseState() — visually reverting
 * an in-progress drag to the last committed pose.
 *
 * Fix: split into 4 targeted subscriptions with reference-equality guards.
 * `updateMorph` spreads { ...char, morphWeights: ... } but leaves `char.pose`
 * at the same object reference. So the pose subscription's equalityFn sees
 * no change and does not fire. Pose is only re-applied when it actually changes.
 *
 * ============================================================================
 * TRANSFORM GIZMO WIRING
 * ============================================================================
 *
 * The transform gizmo (rotation rings + translation arrows) is owned by
 * GizmoController. It needs to show/hide when `selectedBoneName` changes.
 * We wire this via a Zustand subscription that reads `activeCharacterId`
 * and `selectedBoneName` together, finds the bone node, and calls
 * `gizmo.attach()` or `gizmo.detach()`.
 */

import { useEffect, useRef } from 'react'
import { useSceneStore } from '../store/useSceneStore'
import { SceneManager } from '../three/SceneManager'
import { CharacterManager } from '../three/CharacterManager'
import { GizmoController } from '../three/GizmoController'
import { GridOverlay } from '../three/GridOverlay'
import { ExportHelper } from '../three/ExportHelper'
import type { BoneName } from '../three/IKChains'
import { RIG_CONFIG } from '../three/IKChains'
import type { PoseState } from '../store/useSceneStore'
import styles from '../styles/ViewportCanvas.module.css'

// Expose ExportHelper as a module-level singleton for use by ViewportPanel
export const exportHelper = new ExportHelper()

/**
 * Bones that show translation arrows on the transform gizmo (gizmoTranslate: true).
 * Derived from rig-config.json — no code change needed when adding new IK effectors.
 */
const GIZMO_TRANSLATE_SET = new Set<string>(
  Object.entries(RIG_CONFIG.bones)
    .filter(([, cfg]) => cfg.gizmoTranslate)
    .map(([name]) => name)
)

/**
 * Bones that show rotation rings on the transform gizmo (gizmoRotate: true).
 * Derived from rig-config.json.
 */
const GIZMO_ROTATE_SET = new Set<string>(
  Object.entries(RIG_CONFIG.bones)
    .filter(([, cfg]) => cfg.gizmoRotate)
    .map(([name]) => name)
)

export function ViewportCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Three.js objects — held in refs so they don't trigger re-renders
  const sceneRef = useRef<SceneManager | null>(null)
  const gizmoRef = useRef<GizmoController | null>(null)
  const gridRef = useRef<GridOverlay | null>(null)
  const charManagersRef = useRef<Map<string, CharacterManager>>(new Map())

  // ---- Initialize Three.js once on mount ----
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    // ---- Create Three.js scene ----
    const scene = new SceneManager(canvas)
    sceneRef.current = scene

    // ---- Grid overlay ----
    const grid = new GridOverlay(scene.scene)
    grid.setVisible(useSceneStore.getState().viewport.gridEnabled)
    gridRef.current = grid

    // ---- Gizmo controller ----
    const handlePoseChange = (characterId: string, pose: PoseState) => {
      // Single atomic store update instead of N per-bone calls.
      // pushHistory was already called by GizmoController._onPointerUp before this.
      useSceneStore.getState().setBulkPose(characterId, pose)
    }

    const handleBoneSelect = (characterId: string, boneName: BoneName) => {
      const { selectCharacter, selectBone } = useSceneStore.getState()
      selectCharacter(characterId)
      selectBone(boneName)
    }

    const gizmo = new GizmoController(canvas, scene, handlePoseChange, handleBoneSelect)
    gizmoRef.current = gizmo

    // ---- Populate initial characters from the store ----
    const initialChars = useSceneStore.getState().characters
    for (const char of initialChars) {
      const mgr = new CharacterManager(char.id, scene.scene)
      mgr.setWorldPosition(char.worldPosition)
      mgr.setWorldRotation(char.worldRotation)
      charManagersRef.current.set(char.id, mgr)
      gizmo.registerCharacter(mgr)
    }

    // ========================================================================
    // Zustand subscriptions
    // ========================================================================

    // 1. Character list changes (add / remove) — low frequency
    const unsubCharList = useSceneStore.subscribe(
      (state) => state.characters.map((c) => c.id),
      (newIds, prevIds) => {
        const added = newIds.filter((id) => !prevIds.includes(id))
        const removed = prevIds.filter((id) => !newIds.includes(id))

        for (const id of added) {
          const char = useSceneStore.getState().characters.find((c) => c.id === id)
          if (!char) continue
          const mgr = new CharacterManager(id, scene.scene)
          mgr.setWorldPosition(char.worldPosition)
          mgr.setWorldRotation(char.worldRotation)
          charManagersRef.current.set(id, mgr)
          gizmo.registerCharacter(mgr)
        }

        for (const id of removed) {
          const mgr = charManagersRef.current.get(id)
          mgr?.dispose()
          charManagersRef.current.delete(id)
          gizmo.unregisterCharacter(id)
        }
      }
    )

    // 2a. Pose — only fires when a character's pose object reference changes.
    //     updateMorph/updateLayer spread { ...char, morphWeights/layerVisibility: ... }
    //     which creates a new Character object but keeps char.pose at the same reference.
    //     The equalityFn sees the pose refs are unchanged → subscription does NOT fire.
    //     This prevents the pose from being reset when sliders/checkboxes are adjusted.
    const unsubPose = useSceneStore.subscribe(
      (s) => s.characters.map((c) => c.pose),
      () => {
        for (const char of useSceneStore.getState().characters) {
          charManagersRef.current.get(char.id)?.applyPoseState(char.pose)
        }
      },
      {
        equalityFn: (a: PoseState[], b: PoseState[]) =>
          a.length === b.length && a.every((p, i) => p === b[i]),
      }
    )

    // 2b. Morph weights — fires only when morphWeights reference changes.
    const unsubMorph = useSceneStore.subscribe(
      (s) => s.characters.map((c) => c.morphWeights),
      () => {
        for (const char of useSceneStore.getState().characters) {
          charManagersRef.current.get(char.id)?.applyMorphWeights(char.morphWeights)
        }
      },
      {
        equalityFn: (a, b) => a.length === b.length && a.every((m, i) => m === b[i]),
      }
    )

    // 2c. Layer visibility — fires only when layerVisibility reference changes.
    const unsubLayer = useSceneStore.subscribe(
      (s) => s.characters.map((c) => c.layerVisibility),
      () => {
        for (const char of useSceneStore.getState().characters) {
          charManagersRef.current.get(char.id)?.setLayerVisibility(char.layerVisibility)
        }
      },
      {
        equalityFn: (a, b) => a.length === b.length && a.every((l, i) => l === b[i]),
      }
    )

    // 2d. World transforms — fires only when position/rotation reference changes.
    const unsubTransform = useSceneStore.subscribe(
      (s) => s.characters.map((c) => ({ wp: c.worldPosition, wr: c.worldRotation })),
      () => {
        for (const char of useSceneStore.getState().characters) {
          const mgr = charManagersRef.current.get(char.id)
          mgr?.setWorldPosition(char.worldPosition)
          mgr?.setWorldRotation(char.worldRotation)
        }
      },
      {
        equalityFn: (a, b) =>
          a.length === b.length && a.every((t, i) => t.wp === b[i].wp && t.wr === b[i].wr),
      }
    )

    // 3. Active character + selected bone — drives joint highlight and gizmo visibility.
    const unsubActive = useSceneStore.subscribe(
      (s) => ({ activeId: s.activeCharacterId, bone: s.selectedBoneName }),
      ({ activeId, bone }) => {
        for (const [id, mgr] of charManagersRef.current) {
          mgr.setActive(id === activeId)
          mgr.setSelectedBone(id === activeId ? bone : null)
        }

        // Update transform gizmo: attach to the selected bone, or detach.
        if (activeId && bone) {
          const mgr = charManagersRef.current.get(activeId)
          const boneNode = mgr?.getBoneNode(bone as BoneName)
          if (boneNode) {
            const showTranslate = GIZMO_TRANSLATE_SET.has(bone)
            const showRotate = GIZMO_ROTATE_SET.has(bone)
            gizmo.transformGizmo.attach(boneNode, showTranslate, showRotate)
          }
        } else {
          gizmo.transformGizmo.detach()
        }
      },
      {
        equalityFn: (a, b) => a.activeId === b.activeId && a.bone === b.bone,
      }
    )

    // 4. Grid visibility
    const unsubGrid = useSceneStore.subscribe(
      (state) => state.viewport.gridEnabled,
      (enabled) => grid.setVisible(enabled)
    )

    // 5. Outline thickness
    const unsubOutline = useSceneStore.subscribe(
      (state) => state.viewport.outlineThickness,
      (thickness) => {
        for (const mgr of charManagersRef.current.values()) {
          mgr.setOutlineThickness(thickness)
        }
      }
    )

    // 6. Background color
    const unsubBg = useSceneStore.subscribe(
      (state) => state.viewport.backgroundColor,
      (color) => {
        const bg = scene.scene.background
        if (bg && 'isColor' in bg) (bg as import('three').Color).set(color)
      }
    )

    // 7. Camera FOV
    const unsubFov = useSceneStore.subscribe(
      (state) => state.camera.fov,
      (fov) => {
        const cam = scene.camera
        if ('fov' in cam) {
          cam.fov = fov
          cam.updateProjectionMatrix()
        }
      }
    )

    // 8. Camera preset
    const unsubPreset = useSceneStore.subscribe(
      (state) => state.camera.preset,
      (preset) => scene.setCameraPreset(preset)
    )

    // ---- Keyboard shortcuts (undo/redo) ----
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when the user is typing in an input or textarea.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const { undo, redo } = useSceneStore.getState()
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault()
        undo()
      } else if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'y' || (e.shiftKey && e.key === 'z'))
      ) {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    // ---- ResizeObserver ----
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      scene.handleResize(Math.round(width), Math.round(height))
    })
    resizeObserver.observe(container)

    // ---- Cleanup on unmount ----
    return () => {
      unsubCharList()
      unsubPose()
      unsubMorph()
      unsubLayer()
      unsubTransform()
      unsubActive()
      unsubGrid()
      unsubOutline()
      unsubBg()
      unsubFov()
      unsubPreset()
      window.removeEventListener('keydown', handleKeyDown)
      resizeObserver.disconnect()

      gizmo.dispose()

      for (const mgr of charManagersRef.current.values()) {
        mgr.dispose()
      }
      charManagersRef.current.clear()

      grid.dispose(scene.scene)
      scene.dispose()
    }
  }, []) // Empty deps — runs once on mount, cleans up on unmount.

  return (
    <div ref={containerRef} className={styles.container}>
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  )
}
