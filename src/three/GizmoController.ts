/**
 * GizmoController.ts — Mouse/pointer drag interaction for IK posing.
 *
 * ============================================================================
 * OVERVIEW
 * ============================================================================
 *
 * GizmoController handles the full drag lifecycle:
 *   pointerdown → identify joint → start drag → pointerup → write to store
 *
 * It runs as a per-frame callback registered via SceneManager.addBeforeRenderCallback.
 * The actual position update happens in `update()` each frame during a drag.
 * The Zustand store is written only on pointerup (not every frame) to avoid
 * triggering React re-renders at 60fps.
 *
 * ============================================================================
 * DRAG PLANE GEOMETRY
 * ============================================================================
 *
 * When the user drags a joint sphere, we need to project the 2D mouse position
 * into 3D world space. We do this by intersecting the ray from the camera
 * through the mouse position with a plane.
 *
 * Which plane?
 *   - Camera-facing plane through the joint's world position.
 *   - The plane's normal = camera's forward direction (from camera to scene).
 *   - The plane passes through the joint's current world position.
 *
 * Why camera-facing?
 *   - The user drags in screen space; the camera-facing plane maps screen
 *     movement 1:1 to depth-correct world movement.
 *   - Alternative: world-axis planes (XY for hands, XZ for feet) are
 *     more predictable in some cases but confuse users when the camera is
 *     at an angle to those planes.
 *
 * Derivation:
 *   cameraDir = camera.getWorldDirection(v)   // normalized -Z in camera space
 *   plane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDir, jointWorldPos)
 *
 * To get the 3D target position each frame:
 *   raycaster.setFromCamera(normalizedMousePos, camera)
 *   raycaster.ray.intersectPlane(dragPlane, targetPos)
 *
 * ============================================================================
 * ORBITCONTROLS COORDINATION
 * ============================================================================
 *
 * Both OrbitControls and GizmoController want pointer events on the canvas.
 * Without coordination, a gizmo drag would simultaneously orbit the camera.
 *
 * Solution: on pointerdown, if a joint is hit, set `controls.enabled = false`
 * to freeze OrbitControls for the duration of the drag. Re-enable on pointerup.
 *
 * We use setPointerCapture(e.pointerId) to ensure pointermove/pointerup events
 * keep firing even if the mouse leaves the canvas element. This is the correct
 * cross-browser approach (vs. adding listeners to document).
 *
 * ============================================================================
 * CLICK VS DRAG DISTINCTION
 * ============================================================================
 *
 * A "click" (selecting a character/bone without dragging) is distinguished from
 * a "drag" by comparing the pointer's screen position at pointerdown vs pointerup.
 * If the movement is within CLICK_THRESHOLD pixels, it's treated as a click.
 * The `onBoneSelect` callback is called for clicks, `onPoseChange` for drags.
 */

import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { SceneManager } from './SceneManager'
import type { CharacterManager } from './CharacterManager'
import { IKSolver } from './IKSolver'
import { IK_CHAINS, findChainForEffector, type BoneName } from './IKChains'
import type { PoseState } from '../store/useSceneStore'

// Movement threshold in pixels below which a pointerdown+up is treated as a click.
const CLICK_THRESHOLD = 5

// --------------------------------------------------------------------------
// Drag state — only non-null during an active drag
// --------------------------------------------------------------------------

interface DragState {
  /** Which character is being dragged. */
  characterId: string
  /** The end effector bone being dragged (e.g. "hand.L"). */
  effectorBoneName: BoneName
  /** Reference to the CharacterManager for this character. */
  charMgr: CharacterManager
  /**
   * Working copy of joint world positions for the FABRIK solver.
   * These are mutated each frame during the drag.
   */
  joints: Array<{ position: THREE.Vector3; boneName: string }>
  /**
   * Fixed bone lengths for this chain, computed once at drag start.
   * Lengths don't change during a drag — bones are rigid.
   */
  boneLengths: number[]
  /**
   * Camera-facing plane through the joint's initial world position.
   * Used to project mouse movement into 3D world coordinates each frame.
   */
  dragPlane: THREE.Plane
  /** Pointer screen position at drag start — used for click detection. */
  startScreenPos: THREE.Vector2
  /** Last computed 3D target position — updated each frame in update(). */
  currentTarget: THREE.Vector3
  /** Pointer ID captured via setPointerCapture — needed for releasePointerCapture. */
  pointerId: number
}

// --------------------------------------------------------------------------
// GizmoController
// --------------------------------------------------------------------------

export class GizmoController {
  private canvas: HTMLCanvasElement
  private sceneManager: SceneManager
  private controls: OrbitControls
  private solver = new IKSolver()
  private raycaster = new THREE.Raycaster()

  /**
   * Normalized device coordinates [-1, 1] of the current pointer position.
   * Updated on every pointermove event.
   */
  private ndc = new THREE.Vector2()

  /** Current drag state, or null when not dragging. */
  private dragState: DragState | null = null

  /**
   * All registered character managers, keyed by characterId.
   * GizmoController raycasts against all joint meshes from all managers.
   */
  private characters: Map<string, CharacterManager> = new Map()

  /**
   * Called when a bone gizmo is dragged and released.
   * Receives the full updated pose for the character.
   */
  private onPoseChange: (characterId: string, pose: PoseState) => void

  /**
   * Called when a joint sphere is clicked (not dragged).
   * Used to select a character and highlight the bone.
   */
  private onBoneSelect: (characterId: string, boneName: BoneName) => void

  // Reusable THREE objects to avoid per-frame allocations
  private _targetPos = new THREE.Vector3()
  private _cameraDir = new THREE.Vector3()
  private _worldPos = new THREE.Vector3()

  constructor(
    canvas: HTMLCanvasElement,
    sceneManager: SceneManager,
    onPoseChange: (characterId: string, pose: PoseState) => void,
    onBoneSelect: (characterId: string, boneName: BoneName) => void
  ) {
    this.canvas = canvas
    this.sceneManager = sceneManager
    this.controls = sceneManager.controls
    this.onPoseChange = onPoseChange
    this.onBoneSelect = onBoneSelect

    // Bind event handlers so they can be removed on dispose
    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerUp = this._onPointerUp.bind(this)

    canvas.addEventListener('pointerdown', this._onPointerDown)
    canvas.addEventListener('pointermove', this._onPointerMove)
    canvas.addEventListener('pointerup', this._onPointerUp)

    // Register the per-frame update with SceneManager
    sceneManager.addBeforeRenderCallback(this.update.bind(this))
  }

  // --------------------------------------------------------------------------
  // Character registration
  // --------------------------------------------------------------------------

  registerCharacter(mgr: CharacterManager): void {
    this.characters.set(mgr.characterId, mgr)
  }

  unregisterCharacter(id: string): void {
    this.characters.delete(id)
  }

  // --------------------------------------------------------------------------
  // Per-frame update — runs inside the render loop
  // --------------------------------------------------------------------------

  /**
   * Called every frame by SceneManager before render.
   * If a drag is active, computes the 3D target position from the current mouse
   * NDC, runs the FABRIK solver, and applies the result to the Three.js rig.
   * The Zustand store is NOT written here — only on pointerup.
   */
  update(): void {
    if (!this.dragState) return

    const { joints, boneLengths, dragPlane, charMgr } = this.dragState

    // Project mouse NDC through the drag plane to get the 3D target position.
    this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)
    const hit = this.raycaster.ray.intersectPlane(dragPlane, this._targetPos)
    if (!hit) return // ray is parallel to the plane — very rare edge case

    this.dragState.currentTarget.copy(this._targetPos)

    // Run FABRIK solve — mutates joint positions in place.
    this.solver.solve(joints, this._targetPos, boneLengths)

    // Get the chain's Object3D nodes and apply the solved positions as local quaternions.
    const chain = IK_CHAINS.find((c) =>
      c.bones[c.bones.length - 1] === this.dragState!.effectorBoneName
    )
    if (!chain) return

    const objects = charMgr.getChainObjects(chain.bones)
    if (!objects) return

    this.solver.applyToObjects(joints, objects)
  }

  // --------------------------------------------------------------------------
  // Pointer event handlers
  // --------------------------------------------------------------------------

  private _onPointerDown(e: PointerEvent): void {
    // Only respond to left mouse button or single touch
    if (e.button !== 0 && e.pointerType === 'mouse') return

    this._updateNDC(e)

    // Collect all joint sphere meshes from all characters
    const allJoints: THREE.Mesh[] = []
    for (const mgr of this.characters.values()) {
      allJoints.push(...mgr.jointMeshes)
    }
    if (allJoints.length === 0) return

    // Raycast against all joint spheres
    this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)
    const hits = this.raycaster.intersectObjects(allJoints, false)
    if (hits.length === 0) return

    // Found a hit — identify the bone and character
    const hitObj = hits[0].object
    const boneName = hitObj.userData.boneName as BoneName
    const characterId = hitObj.userData.characterId as string
    const charMgr = this.characters.get(characterId)
    if (!charMgr || !boneName) return

    // Prevent OrbitControls from orbiting during a gizmo drag
    this.controls.enabled = false
    this.canvas.setPointerCapture(e.pointerId)

    // Find the IK chain for this bone (it may not be an IK effector — e.g. spine)
    const chainDef = findChainForEffector(boneName)

    if (chainDef) {
      // ---- Start an IK drag ----
      const objects = charMgr.getChainObjects(chainDef.bones)
      if (!objects) {
        this.controls.enabled = true
        return
      }

      // Snapshot current joint world positions and bone lengths
      const joints = this.solver.extractJoints(objects, chainDef.bones)
      const boneLengths = this.solver.computeBoneLengths(objects)

      // Build the camera-facing drag plane at the effector's world position
      hitObj.getWorldPosition(this._worldPos)
      const dragPlane = this._buildDragPlane(this._worldPos)

      this.dragState = {
        characterId,
        effectorBoneName: boneName,
        charMgr,
        joints,
        boneLengths,
        dragPlane,
        startScreenPos: new THREE.Vector2(e.clientX, e.clientY),
        currentTarget: this._worldPos.clone(),
        pointerId: e.pointerId,
      }
    } else {
      // ---- Non-IK bone: treat immediately as a selection click ----
      this.controls.enabled = true
      this.canvas.releasePointerCapture(e.pointerId)
      this.onBoneSelect(characterId, boneName)
    }
  }

  private _onPointerMove(e: PointerEvent): void {
    this._updateNDC(e)
    // update() reads this.ndc each frame, so no further action needed here.
  }

  private _onPointerUp(e: PointerEvent): void {
    if (!this.dragState) return
    if (e.pointerId !== this.dragState.pointerId) return

    const { startScreenPos, characterId, charMgr, effectorBoneName } = this.dragState
    const moved = new THREE.Vector2(e.clientX, e.clientY).distanceTo(startScreenPos)

    if (moved < CLICK_THRESHOLD) {
      // Treated as a click — select the character/bone
      this.onBoneSelect(characterId, effectorBoneName)
    } else {
      // Write the final solved pose to the Zustand store
      const finalPose = charMgr.extractPoseState()
      this.onPoseChange(characterId, finalPose)
    }

    this.canvas.releasePointerCapture(e.pointerId)
    this.controls.enabled = true
    this.dragState = null
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Build a camera-facing plane passing through `point`.
   * The plane's normal is the camera's forward direction.
   * Ray-plane intersection then maps 2D mouse movement to 3D world movement
   * at the depth of the joint, which feels natural and preserves perspective.
   */
  private _buildDragPlane(point: THREE.Vector3): THREE.Plane {
    this.sceneManager.camera.getWorldDirection(this._cameraDir)
    return new THREE.Plane().setFromNormalAndCoplanarPoint(this._cameraDir, point)
  }

  /**
   * Convert a PointerEvent's client coordinates to normalized device coordinates.
   * NDC x ∈ [-1, 1] left to right; y ∈ [-1, 1] bottom to top (flipped from screen y).
   */
  private _updateNDC(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    this.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this._onPointerDown)
    this.canvas.removeEventListener('pointermove', this._onPointerMove)
    this.canvas.removeEventListener('pointerup', this._onPointerUp)
    this.characters.clear()
  }
}
