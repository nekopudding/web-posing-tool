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
 * The subscribeWithSelector middleware (applied in useSceneStore) enables
 * the `subscribe(selector, listener)` overload. Without it, subscribe only
 * accepts a bare listener and sends the full state.
 *
 * Flow for a drag-based pose update:
 *   1. User drags joint sphere
 *   2. GizmoController.update() runs in the render loop → FABRIK → applyToObjects
 *      (Three.js updated directly, no store write yet)
 *   3. On pointerup: GizmoController calls onPoseChange(id, fullPose)
 *   4. onPoseChange calls store.updatePose for each changed bone
 *   5. Zustand subscription fires → CharacterManager.applyPoseState(pose)
 *   6. Next frame: render loop renders the updated rig
 *
 * Note: in step 2, Three.js is already updated — step 5 would be redundant
 * for that drag. But it ensures the store stays in sync for future operations
 * (e.g. if the user adds a second character, the first one's pose is preserved).
 */

import { useEffect, useRef } from 'react'
import { useSceneStore } from '../store/useSceneStore'
import { SceneManager } from '../three/SceneManager'
import { CharacterManager } from '../three/CharacterManager'
import { GizmoController } from '../three/GizmoController'
import { GridOverlay } from '../three/GridOverlay'
import { ExportHelper } from '../three/ExportHelper'
import type { BoneName } from '../three/IKChains'
import type { PoseState } from '../store/useSceneStore'
import styles from '../styles/ViewportCanvas.module.css'

// Expose ExportHelper as a module-level singleton for use by ViewportPanel
export const exportHelper = new ExportHelper()

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

    // ---- Gizmo controller (drag IK) ----
    const handlePoseChange = (characterId: string, pose: PoseState) => {
      // Write each changed bone's quaternion to the store.
      // We write the full pose (not just changed bones) to keep the store
      // fully in sync — the cost is O(bones) per drag-end, which is fine.
      const { updatePose } = useSceneStore.getState()
      for (const [boneName, q] of Object.entries(pose)) {
        updatePose(characterId, boneName, q)
      }
    }

    const handleBoneSelect = (characterId: string, _boneName: BoneName) => {
      // Select the character whose gizmo was clicked
      useSceneStore.getState().selectCharacter(characterId)
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

    // ---- Zustand subscriptions ----

    // 1. Character list changes (add / remove) — low frequency
    const unsubCharList = useSceneStore.subscribe(
      (state) => state.characters.map((c) => c.id),
      (newIds, prevIds) => {
        // Diff: find added and removed IDs
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

    // 2. Pose updates — high frequency (FABRIK drag writes here)
    //    We apply pose to Three.js objects directly, bypassing React.
    const unsubPose = useSceneStore.subscribe(
      (state) => state.characters,
      (chars) => {
        for (const char of chars) {
          const mgr = charManagersRef.current.get(char.id)
          if (!mgr) continue
          mgr.applyPoseState(char.pose)
          mgr.applyMorphWeights(char.morphWeights)
          mgr.setLayerVisibility(char.layerVisibility)
          mgr.setWorldPosition(char.worldPosition)
          mgr.setWorldRotation(char.worldRotation)
        }
      }
    )

    // 3. Active character highlight
    const unsubActive = useSceneStore.subscribe(
      (state) => state.activeCharacterId,
      (activeId) => {
        for (const [id, mgr] of charManagersRef.current) {
          mgr.setActive(id === activeId)
        }
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
      unsubActive()
      unsubGrid()
      unsubOutline()
      unsubBg()
      unsubFov()
      unsubPreset()
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
