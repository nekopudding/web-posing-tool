/**
 * GizmoController.ts — Mouse/pointer drag interaction for IK posing and transform gizmo.
 *
 * ============================================================================
 * DRAG MODES
 * ============================================================================
 *
 * 'ik-free'
 *   Drag a joint sphere (IK end effector: hand or foot) in the camera-facing plane.
 *   FABRIK IK solves the limb each frame. This is the original drag behaviour.
 *
 * 'rotate-x/y/z'
 *   Drag a rotation ring on the transform gizmo. Computes the angle swept
 *   around the ring's world axis and applies it as a local quaternion rotation.
 *   Works for any joint (FK rotation).
 *
 * 'translate-x/y/z'
 *   Drag a translation arrow on the transform gizmo. Projects the mouse ray
 *   onto the axis and moves the IK target along that axis. Available only
 *   for IK end effectors.
 *
 * ============================================================================
 * ROTATION MATH
 * ============================================================================
 *
 * On drag start, we record:
 *   - rotAxis: the world-space unit axis (e.g. (1,0,0) for X)
 *   - rotPlane: a THREE.Plane with normal=rotAxis, through the joint position
 *   - rotStartDir: the direction from joint center to the first ray-plane hit
 *   - rotBaseQuat: the bone's local quaternion at drag start
 *
 * Each frame:
 *   1. Intersect camera ray with rotPlane → currentHit
 *   2. currentDir = normalize(currentHit - jointCenter) projected to plane
 *   3. angle = atan2( (startDir × currentDir) · rotAxis, startDir · currentDir )
 *      This gives the signed angle from startDir to currentDir around rotAxis.
 *   4. Build world-space rotation: qWorld = Quaternion.setFromAxisAngle(rotAxis, angle)
 *   5. Convert to local space:
 *        parentWorldQ = parent bone's world quaternion
 *        localDelta = parentWorldQ.invert() * qWorld * parentWorldQ
 *   6. Apply: boneNode.quaternion = localDelta * rotBaseQuat
 *      (localDelta applied to base, NOT incremental, avoids drift)
 *
 * ============================================================================
 * TRANSLATION MATH
 * ============================================================================
 *
 * For axis-constrained translation, we project the mouse ray onto a plane
 * that contains the drag axis and faces roughly toward the camera
 * (normal = normalize(cameraDir - dot(cameraDir, transAxis) * transAxis)).
 * Then project the hit onto the axis line to get the 1D parameter t.
 * Move the IK target by (t - startT) along the axis.
 *
 * ============================================================================
 * ORBITCONTROLS COORDINATION
 * ============================================================================
 *
 * `controls.enabled = false` on pointerdown if any handle is hit.
 * Re-enabled on pointerup. setPointerCapture keeps events alive outside canvas.
 *
 * ============================================================================
 * CLICK VS DRAG DISTINCTION
 * ============================================================================
 *
 * If the pointer moves less than CLICK_THRESHOLD pixels between down and up,
 * it is treated as a click (selects the character/bone). Pose is not written
 * to the store on a pure click.
 */

import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { SceneManager } from './SceneManager'
import type { CharacterManager } from './CharacterManager'
import { IKSolver, type IKJoint } from './IKSolver'
import { IK_CHAINS, findChainForEffector, type BoneName } from './IKChains'
import { TransformGizmo, type GizmoHandleType } from './TransformGizmo'
import { useSceneStore, type PoseState } from '../store/useSceneStore'

/** Movement threshold in pixels below which a pointerdown+up is a click. */
const CLICK_THRESHOLD = 5


// --------------------------------------------------------------------------
// DragState — only non-null during an active drag
// --------------------------------------------------------------------------

/**
 * What kind of drag is in progress. Each mode requires a different subset
 * of fields in DragState and a different update function.
 */
type DragMode =
  | 'ik-free'       // camera-plane IK drag (original behaviour)
  | 'rotate-x' | 'rotate-y' | 'rotate-z'
  | 'translate-x' | 'translate-y' | 'translate-z'

interface DragState {
  mode: DragMode
  characterId: string
  /** The joint bone name that was interacted with (used for selection highlight). */
  effectorBoneName: BoneName
  charMgr: CharacterManager
  pointerId: number
  startScreenPos: THREE.Vector2

  // ---- IK-free fields (mode === 'ik-free') ----
  joints?: IKJoint[]
  boneLengths?: number[]
  /** Camera-facing plane through the joint world position. */
  dragPlane?: THREE.Plane
  currentTarget?: THREE.Vector3

  // ---- Rotation fields (mode === 'rotate-*') ----
  /** World-space unit rotation axis. */
  rotAxis?: THREE.Vector3
  /** Plane with normal = rotAxis, passing through the joint. */
  rotPlane?: THREE.Plane
  /** Direction from joint center to first hit point (in the rotation plane). */
  rotStartDir?: THREE.Vector3
  /** Bone's local quaternion snapshot at drag start. */
  rotBaseQuat?: THREE.Quaternion
  /** The bone node being rotated. */
  rotBoneNode?: THREE.Object3D
  /** World position of the joint at drag start (for angle computation). */
  rotJointPos?: THREE.Vector3

  // ---- Translation fields (mode === 'translate-*') ----
  /** World-space unit translation axis. */
  transAxis?: THREE.Vector3
  /** Projection of the start-hit along transAxis. */
  transStartT?: number
  /** IK target position at drag start. */
  transBaseTarget?: THREE.Vector3
  /** IK chain joints at drag start (for solving each frame). */
  transJoints?: IKJoint[]
  transChainBones?: BoneName[]
  transBoneLengths?: number[]
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

  /** The transform gizmo — shows handles around the selected joint. */
  readonly transformGizmo: TransformGizmo

  /** Current pointer NDC position [-1,1]. Updated on every pointermove. */
  private ndc = new THREE.Vector2()

  /** Current drag state, or null when not dragging. */
  private dragState: DragState | null = null

  /** All registered character managers, keyed by characterId. */
  private characters: Map<string, CharacterManager> = new Map()

  /**
   * Called on drag end with the full updated pose for the character.
   */
  private onPoseChange: (characterId: string, pose: PoseState) => void

  /**
   * Called when a joint sphere is clicked (not dragged) or touched.
   * Used to select the character and highlight the bone.
   */
  private onBoneSelect: (characterId: string, boneName: BoneName) => void

  // Reusable THREE objects — avoid per-frame GC pressure
  private _targetPos = new THREE.Vector3()
  private _cameraDir = new THREE.Vector3()
  private _worldPos = new THREE.Vector3()
  private _hitPoint = new THREE.Vector3()
  private _tempVec = new THREE.Vector3()
  private _parentWorldQ = new THREE.Quaternion()

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

    this.transformGizmo = new TransformGizmo(sceneManager.scene)

    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerUp = this._onPointerUp.bind(this)

    canvas.addEventListener('pointerdown', this._onPointerDown)
    canvas.addEventListener('pointermove', this._onPointerMove)
    canvas.addEventListener('pointerup', this._onPointerUp)

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
  // Per-frame update
  // --------------------------------------------------------------------------

  /**
   * Called every frame by SceneManager before render.
   * Gizmo position/scale is updated unconditionally; drag solve is conditional.
   */
  update(): void {
    // Always keep the gizmo glued to the attached joint (the bone moves during drag).
    this.transformGizmo.updateTransform()
    this.transformGizmo.updateScale(this.sceneManager.camera)

    if (!this.dragState) return

    switch (this.dragState.mode) {
      case 'ik-free':
        this._updateIKFreeDrag()
        break
      case 'rotate-x':
      case 'rotate-y':
      case 'rotate-z':
        this._updateRotateDrag()
        break
      case 'translate-x':
      case 'translate-y':
      case 'translate-z':
        this._updateTranslateDrag()
        break
    }
  }

  // --------------------------------------------------------------------------
  // Drag update helpers
  // --------------------------------------------------------------------------

  /**
   * IK-free drag: project mouse to camera-facing plane, FABRIK solve.
   * (Original drag behaviour for hand/foot joints.)
   */
  private _updateIKFreeDrag(): void {
    const ds = this.dragState!
    const { joints, boneLengths, dragPlane, charMgr } = ds
    if (!joints || !boneLengths || !dragPlane) return

    this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)
    const hit = this.raycaster.ray.intersectPlane(dragPlane, this._targetPos)
    if (!hit) return

    ds.currentTarget!.copy(this._targetPos)
    this.solver.solve(joints, this._targetPos, boneLengths)

    const chain = IK_CHAINS.find(
      (c) => c.bones[c.bones.length - 1] === ds.effectorBoneName
    )
    if (!chain) return
    const objects = charMgr.getChainObjects(chain.bones)
    if (!objects) return
    this.solver.applyToObjects(joints, objects)
  }

  /**
   * Rotation ring drag: compute angle swept since drag start, apply as FK rotation.
   *
   * Uses a fixed-base approach: `boneQuat = localDelta * rotBaseQuat`
   * where `localDelta` is derived from the current world-space rotation delta.
   * This avoids quaternion drift from incremental multiplication each frame.
   */
  private _updateRotateDrag(): void {
    const ds = this.dragState!
    const { rotAxis, rotPlane, rotStartDir, rotBaseQuat, rotBoneNode, rotJointPos } = ds
    if (!rotAxis || !rotPlane || !rotStartDir || !rotBaseQuat || !rotBoneNode || !rotJointPos) return

    this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)
    const hit = this.raycaster.ray.intersectPlane(rotPlane, this._hitPoint)
    if (!hit) return

    // Direction from joint center to current hit, projected to the rotation plane.
    this._tempVec.subVectors(this._hitPoint, rotJointPos)
    // Remove component along the axis (project onto plane).
    const proj = this._tempVec.dot(rotAxis)
    this._tempVec.addScaledVector(rotAxis, -proj)
    if (this._tempVec.lengthSq() < 1e-8) return // degenerate: hit exactly on axis
    this._tempVec.normalize() // currentDir

    // Signed angle from startDir to currentDir around rotAxis.
    // angle = atan2( (startDir × currentDir) · rotAxis, startDir · currentDir )
    const cross = new THREE.Vector3().crossVectors(rotStartDir, this._tempVec)
    const sinAngle = cross.dot(rotAxis)
    const cosAngle = rotStartDir.dot(this._tempVec)
    const angle = Math.atan2(sinAngle, cosAngle)

    // Build world-space rotation delta.
    const qWorld = new THREE.Quaternion().setFromAxisAngle(rotAxis, angle)

    // Convert to the bone's local space:
    //   localDelta = parentWorldQ.inverse * qWorld * parentWorldQ
    // This transforms the world-space rotation into a parent-relative one.
    this._parentWorldQ.identity()
    if (rotBoneNode.parent) {
      rotBoneNode.parent.getWorldQuaternion(this._parentWorldQ)
    }
    const pInv = this._parentWorldQ.clone().invert()
    const localDelta = pInv.multiply(qWorld).multiply(this._parentWorldQ)

    // Apply from base (not incremental) to avoid float drift.
    rotBoneNode.quaternion.copy(localDelta).multiply(rotBaseQuat)
    rotBoneNode.updateMatrixWorld(true)
  }

  /**
   * Translation arrow drag: constrain movement to one world axis, IK solve.
   *
   * We need a 2D drag plane that contains the axis and is roughly perpendicular
   * to the camera → use a plane whose normal = component of cameraDir perpendicular
   * to the drag axis. This makes the drag feel natural from any view angle.
   */
  private _updateTranslateDrag(): void {
    const ds = this.dragState!
    const { transAxis, transStartT, transBaseTarget, transJoints, transChainBones, transBoneLengths, charMgr } = ds
    if (
      !transAxis || transStartT === undefined || !transBaseTarget ||
      !transJoints || !transChainBones || !transBoneLengths
    ) return

    this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)

    // Build a plane containing the drag axis that faces the camera.
    // Normal = cameraDir minus its component along transAxis (axis-facing plane).
    this.sceneManager.camera.getWorldDirection(this._cameraDir)
    const axisComponent = this._cameraDir.dot(transAxis)
    this._tempVec.copy(this._cameraDir).addScaledVector(transAxis, -axisComponent).normalize()
    if (this._tempVec.lengthSq() < 1e-6) {
      // Camera is looking almost exactly along the axis — use fallback plane.
      this._tempVec.set(0, 1, 0).addScaledVector(transAxis, -transAxis.y).normalize()
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this._tempVec, transBaseTarget)

    const hit = this.raycaster.ray.intersectPlane(plane, this._hitPoint)
    if (!hit) return

    // Project hit onto the axis line through transBaseTarget to get t.
    const t = this._hitPoint.clone().sub(transBaseTarget).dot(transAxis)

    // New IK target = base + axis * (t - startT)
    this._targetPos.copy(transBaseTarget).addScaledVector(transAxis, t - transStartT)

    this.solver.solve(transJoints, this._targetPos, transBoneLengths)
    const objects = charMgr.getChainObjects(transChainBones)
    if (!objects) return
    this.solver.applyToObjects(transJoints, objects)
  }

  // --------------------------------------------------------------------------
  // Pointer event handlers
  // --------------------------------------------------------------------------

  private _onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    this._updateNDC(e)

    // ---- 1. Check gizmo handles FIRST (higher priority than joint spheres) ----
    if (this.transformGizmo.group.visible) {
      this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)
      const gizmoHits = this.raycaster.intersectObjects(this.transformGizmo.handles, false)
      if (gizmoHits.length > 0) {
        const handleType = this.transformGizmo.identifyHandle(gizmoHits[0].object)
        if (handleType) {
          this._startGizmoDrag(e, handleType)
          return
        }
      }
    }

    // ---- 2. Check joint spheres ----
    const allJoints: THREE.Mesh[] = []
    for (const mgr of this.characters.values()) {
      allJoints.push(...(mgr.jointMeshes as THREE.Mesh[]))
    }
    if (allJoints.length === 0) return

    this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)
    const hits = this.raycaster.intersectObjects(allJoints, false)
    if (hits.length === 0) return

    const hitObj = hits[0].object
    const boneName = hitObj.userData.boneName as BoneName
    const characterId = hitObj.userData.characterId as string
    const charMgr = this.characters.get(characterId)
    if (!charMgr || !boneName) return

    // Immediately highlight the joint — even if this turns into a drag, the
    // visual feedback should appear right on press, not only on release.
    this.onBoneSelect(characterId, boneName)

    this.controls.enabled = false
    this.canvas.setPointerCapture(e.pointerId)

    const chainDef = findChainForEffector(boneName)
    if (chainDef) {
      // ---- IK-free drag ----
      const objects = charMgr.getChainObjects(chainDef.bones)
      if (!objects) { this.controls.enabled = true; return }

      const joints = this.solver.extractJoints(objects, chainDef.bones)
      const boneLengths = this.solver.computeBoneLengths(objects)
      hitObj.getWorldPosition(this._worldPos)

      this.dragState = {
        mode: 'ik-free',
        characterId,
        effectorBoneName: boneName,
        charMgr,
        pointerId: e.pointerId,
        startScreenPos: new THREE.Vector2(e.clientX, e.clientY),
        joints,
        boneLengths,
        dragPlane: this._buildCameraPlane(this._worldPos),
        currentTarget: this._worldPos.clone(),
      }
    } else {
      // ---- Sphere drag on non-IK joint: just leave as click (no drag pose) ----
      // The bone select was already called above. Release pointer capture since
      // we won't be doing a drag.
      this.controls.enabled = true
      this.canvas.releasePointerCapture(e.pointerId)
    }
  }

  /**
   * Start a gizmo handle drag (rotation ring or translation arrow).
   * Caller has already confirmed the handle hit.
   */
  private _startGizmoDrag(e: PointerEvent, handleType: GizmoHandleType): void {
    // The gizmo is attached to a specific bone — find it via the current store selection.
    const { activeCharacterId, selectedBoneName } = useSceneStore.getState()
    if (!activeCharacterId || !selectedBoneName) return

    const charMgr = this.characters.get(activeCharacterId)
    if (!charMgr) return

    const boneNode = charMgr.getBoneNode(selectedBoneName as BoneName)
    if (!boneNode) return

    this.controls.enabled = false
    this.canvas.setPointerCapture(e.pointerId)
    this.transformGizmo.setActiveHandle(handleType)

    // World position of the joint
    boneNode.getWorldPosition(this._worldPos)
    const jointPos = this._worldPos.clone()

    // Determine the axis vector from the handle type
    const axisMap: Record<string, THREE.Vector3> = {
      'rotate-x': new THREE.Vector3(1, 0, 0),
      'rotate-y': new THREE.Vector3(0, 1, 0),
      'rotate-z': new THREE.Vector3(0, 0, 1),
      'translate-x': new THREE.Vector3(1, 0, 0),
      'translate-y': new THREE.Vector3(0, 1, 0),
      'translate-z': new THREE.Vector3(0, 0, 1),
    }
    const axis = axisMap[handleType]

    const mode = handleType as DragMode

    if (mode.startsWith('rotate')) {
      // ---- Start rotation drag ----
      const rotPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, jointPos)

      // Find where the mouse ray hits the rotation plane to get the start direction.
      this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)
      const startHit = new THREE.Vector3()
      const didHit = this.raycaster.ray.intersectPlane(rotPlane, startHit)
      if (!didHit) { this.controls.enabled = true; return }

      const startDir = startHit.clone().sub(jointPos)
      const proj = startDir.dot(axis)
      startDir.addScaledVector(axis, -proj).normalize()

      this.dragState = {
        mode,
        characterId: activeCharacterId,
        effectorBoneName: selectedBoneName as BoneName,
        charMgr,
        pointerId: e.pointerId,
        startScreenPos: new THREE.Vector2(e.clientX, e.clientY),
        rotAxis: axis,
        rotPlane,
        rotStartDir: startDir,
        rotBaseQuat: boneNode.quaternion.clone(),
        rotBoneNode: boneNode,
        rotJointPos: jointPos,
      }
    } else {
      // ---- Start translation drag ----
      const chainDef = findChainForEffector(selectedBoneName as BoneName)
      if (!chainDef) { this.controls.enabled = true; return }

      const objects = charMgr.getChainObjects(chainDef.bones)
      if (!objects) { this.controls.enabled = true; return }

      const joints = this.solver.extractJoints(objects, chainDef.bones)
      const boneLengths = this.solver.computeBoneLengths(objects)

      // For start T: build the axis plane and get start hit
      this.sceneManager.camera.getWorldDirection(this._cameraDir)
      const axisComp = this._cameraDir.dot(axis)
      const planeNormal = this._cameraDir.clone().addScaledVector(axis, -axisComp).normalize()
      const startPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, jointPos)
      this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)
      const startHit = new THREE.Vector3()
      this.raycaster.ray.intersectPlane(startPlane, startHit)
      const startT = startHit.clone().sub(jointPos).dot(axis)

      this.dragState = {
        mode,
        characterId: activeCharacterId,
        effectorBoneName: selectedBoneName as BoneName,
        charMgr,
        pointerId: e.pointerId,
        startScreenPos: new THREE.Vector2(e.clientX, e.clientY),
        transAxis: axis,
        transStartT: startT,
        transBaseTarget: jointPos.clone(),
        transJoints: joints,
        transChainBones: chainDef.bones,
        transBoneLengths: boneLengths,
      }
    }
  }

  private _onPointerMove(e: PointerEvent): void {
    this._updateNDC(e)
    // update() reads this.ndc each frame; no further action needed here.
  }

  private _onPointerUp(e: PointerEvent): void {
    if (!this.dragState) return
    if (e.pointerId !== this.dragState.pointerId) return

    const { startScreenPos, characterId, charMgr } = this.dragState
    const moved = new THREE.Vector2(e.clientX, e.clientY).distanceTo(startScreenPos)

    if (moved >= CLICK_THRESHOLD) {
      // Real drag — write final pose to store
      const finalPose = charMgr.extractPoseState()
      this.onPoseChange(characterId, finalPose)
    }
    // If it was a click (moved < threshold): onBoneSelect was already called on pointerdown.

    this.transformGizmo.setActiveHandle(null)
    this.canvas.releasePointerCapture(e.pointerId)
    this.controls.enabled = true
    this.dragState = null
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Build a camera-facing plane through `point`.
   * Used for IK-free drag to map 2D mouse movement to 3D world coordinates
   * at the depth of the joint.
   */
  private _buildCameraPlane(point: THREE.Vector3): THREE.Plane {
    this.sceneManager.camera.getWorldDirection(this._cameraDir)
    return new THREE.Plane().setFromNormalAndCoplanarPoint(this._cameraDir, point)
  }

  /**
   * Convert a PointerEvent's client coordinates to normalized device coordinates.
   * NDC x ∈ [-1, 1] left to right; y ∈ [-1, 1] bottom to top.
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
    this.transformGizmo.dispose()
    this.characters.clear()
  }
}
