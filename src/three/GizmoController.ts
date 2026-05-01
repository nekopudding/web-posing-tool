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
import { IK_CHAINS, RIG_CONFIG, findChainByName, type BoneName } from './IKChains'
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
  | 'ik-free'       // camera-plane IK drag on end effector (hand, foot, head, chest)
  | 'ik-inner'      // camera-plane drag on inner bone (elbow, knee); ancestors move, child orientation locked
  | 'world-translate' // drag hips → translate character worldPosition
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

  // ---- IK-inner fields (mode === 'ik-inner') ----
  // joints/boneLengths/dragPlane/currentTarget are reused from IK-free fields.
  /** Sub-chain bone names (chain root → dragged bone, dropping the original effector). */
  innerChainBones?: BoneName[]
  /** The Object3D for the dragged inner bone (e.g. forearm.L or lower_leg.L). */
  innerDraggedObj?: THREE.Object3D
  /**
   * World quaternion of the dragged bone captured at drag start.
   * Restored each frame so the bone (and its children) keep their world orientation
   * even as their parent bones rotate to move the elbow/knee to the target.
   */
  savedDraggedWorldQ?: THREE.Quaternion

  // ---- World-translate fields (mode === 'world-translate') ----
  /** Character's worldPosition at drag start. */
  worldTransStartPos?: THREE.Vector3
  /** Camera-facing plane at the hips world position. Used to map 2D drag to 3D. */
  worldTransDragPlane?: THREE.Plane
  /** First ray-plane intersection at drag start (delta origin). */
  worldTransDragStart?: THREE.Vector3

  // ---- Feet-lock fields (used during ik-free when footLock is true in config) ----
  /** Saved world positions of foot.L and foot.R at drag start. */
  savedFootPosL?: THREE.Vector3
  savedFootPosR?: THREE.Vector3

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
      case 'ik-inner':
        this._updateIKInnerDrag()
        break
      case 'world-translate':
        this._updateWorldTranslateDrag()
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
   * Works for all IK end effectors: hands, feet, head, chest.
   * When the bone config has footLock=true and the chain can't converge,
   * falls through to _solveFullBodyCascade to bend the spine and re-pin feet.
   */
  private _updateIKFreeDrag(): void {
    const ds = this.dragState!
    const { joints, boneLengths, dragPlane, charMgr } = ds
    if (!joints || !boneLengths || !dragPlane) return

    this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)
    const hit = this.raycaster.ray.intersectPlane(dragPlane, this._targetPos)
    if (!hit) return

    ds.currentTarget!.copy(this._targetPos)
    const converged = this.solver.solve(joints, this._targetPos, boneLengths)

    // Look up chain from config (works for all effectors including head, chest)
    const boneConfig = RIG_CONFIG.bones[ds.effectorBoneName]
    const chainName = boneConfig?.chain
    const chain = chainName ? findChainByName(chainName) : IK_CHAINS.find(
      (c) => c.bones[c.bones.length - 1] === ds.effectorBoneName
    )
    if (!chain) return
    const objects = charMgr.getChainObjects(chain.bones)
    if (!objects) return
    this.solver.applyToObjects(joints, objects)

    // Full-body cascade: when the arm/chest chain can't reach, bend the spine
    // and re-pin feet at their pre-drag world positions.
    if (!converged && ds.savedFootPosL && ds.savedFootPosR) {
      this._solveFullBodyCascade(ds, this._targetPos)
    }
  }

  /**
   * Inner-bone drag: FABRIK on a sub-chain (root → dragged bone), preserving
   * the dragged bone's world orientation so its children don't change direction.
   * Used for elbow (forearm.L/R) and knee (lower_leg.L/R) posing.
   */
  private _updateIKInnerDrag(): void {
    const ds = this.dragState!
    const { joints, boneLengths, dragPlane, charMgr, innerChainBones, innerDraggedObj, savedDraggedWorldQ } = ds
    if (!joints || !boneLengths || !dragPlane || !innerChainBones || !innerDraggedObj || !savedDraggedWorldQ) return

    this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)
    const hit = this.raycaster.ray.intersectPlane(dragPlane, this._targetPos)
    if (!hit) return

    ds.currentTarget!.copy(this._targetPos)
    this.solver.solve(joints, this._targetPos, boneLengths)

    const objects = charMgr.getChainObjects(innerChainBones)
    if (!objects) return

    // applyToObjects writes rotations on objects[0..n-2], leaving the last
    // object (the dragged bone) untouched by the solve — but its world
    // quaternion has changed because its parent moved. Restore it.
    this.solver.applyToObjects(joints, objects)

    if (innerDraggedObj.parent) {
      innerDraggedObj.parent.getWorldQuaternion(this._parentWorldQ)
      const newLocal = this._parentWorldQ.clone().invert().multiply(savedDraggedWorldQ)
      innerDraggedObj.quaternion.copy(newLocal)
      innerDraggedObj.updateMatrixWorld(true)
    }
  }

  /**
   * World-translate drag: move the entire character in 3D space by dragging the hips sphere.
   * Only updates the Three.js group position live; store commit happens on pointerup.
   */
  private _updateWorldTranslateDrag(): void {
    const ds = this.dragState!
    const { worldTransStartPos, worldTransDragPlane, worldTransDragStart, charMgr } = ds
    if (!worldTransStartPos || !worldTransDragPlane || !worldTransDragStart) return

    this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)
    const hit = this.raycaster.ray.intersectPlane(worldTransDragPlane, this._hitPoint)
    if (!hit) return

    // delta from where the drag started (in world space, on the camera-facing plane)
    this._tempVec.subVectors(this._hitPoint, worldTransDragStart)
    const newPos = worldTransStartPos.clone().add(this._tempVec)
    charMgr.setWorldPosition({ x: newPos.x, y: newPos.y, z: newPos.z })
  }

  /**
   * Full-body cascading IK when the primary chain can't reach the target.
   * Solves a longer spine+arm chain so the torso bends toward the target,
   * then re-pins both feet by re-solving the leg chains.
   *
   * Extended chain map (spine prepended to existing arm/head chains):
   *   hand.L/R → ['hips','spine','chest','shoulder.X','upper_arm.X','forearm.X','hand.X']
   *   chest    → ['hips','spine','chest'] (already the normal chain, already applied)
   *   head     → ['hips','spine','chest','neck','head']
   */
  private _solveFullBodyCascade(ds: DragState, target: THREE.Vector3): void {
    const { charMgr, savedFootPosL, savedFootPosR, effectorBoneName } = ds
    if (!savedFootPosL || !savedFootPosR) return

    const extendedBoneMap: Partial<Record<BoneName, BoneName[]>> = {
      'hand.L': ['hips', 'spine', 'chest', 'shoulder.L', 'upper_arm.L', 'forearm.L', 'hand.L'],
      'hand.R': ['hips', 'spine', 'chest', 'shoulder.R', 'upper_arm.R', 'forearm.R', 'hand.R'],
      'head':   ['hips', 'spine', 'chest', 'neck', 'head'],
      // chest already handled by its own spine_chain solve — skip
    }

    const extBones = extendedBoneMap[effectorBoneName]
    if (!extBones) return

    const extObjects = charMgr.getChainObjects(extBones)
    if (!extObjects) return

    // Re-extract world positions AFTER the primary arm solve (bones already moved).
    const extJoints = this.solver.extractJoints(extObjects, extBones)
    const extLengths = this.solver.computeBoneLengths(extObjects)
    this.solver.solve(extJoints, target, extLengths)
    this.solver.applyToObjects(extJoints, extObjects)

    // Re-pin feet: hips moved, so upper_leg world positions changed.
    // Re-extract leg chain from current object world positions and solve toward saved foot.
    for (const side of ['L', 'R'] as const) {
      const savedFootPos = side === 'L' ? savedFootPosL : savedFootPosR
      const legBones: BoneName[] = [`upper_leg.${side}`, `lower_leg.${side}`, `foot.${side}`]
      const legObjects = charMgr.getChainObjects(legBones)
      if (!legObjects) continue
      const legJoints = this.solver.extractJoints(legObjects, legBones)
      const legLengths = this.solver.computeBoneLengths(legObjects)
      this.solver.solve(legJoints, savedFootPos, legLengths)
      this.solver.applyToObjects(legJoints, legObjects)
    }
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

    // Look up what this bone can do from the rig config.
    const boneConfig = RIG_CONFIG.bones[boneName]
    if (!boneConfig?.sphereDrag) {
      // No sphere drag defined → click only. Release capture since no drag will follow.
      this.controls.enabled = true
      this.canvas.releasePointerCapture(e.pointerId)
      return
    }

    this.controls.enabled = false

    switch (boneConfig.sphereDrag) {
      case 'ik':
        this._startIKFreeDrag(e, boneName, charMgr, characterId, hitObj, boneConfig.footLock ?? false)
        break
      case 'ik-inner':
        this._startIKInnerDrag(e, boneName, charMgr, characterId, hitObj, boneConfig.chain!)
        break
      case 'translate':
        this._startWorldTranslateDrag(e, boneName, charMgr, characterId)
        break
    }
  }

  // --------------------------------------------------------------------------
  // Drag start helpers (called from _onPointerDown)
  // --------------------------------------------------------------------------

  /** Start an IK-free drag for an end effector (hand, foot, head, chest). */
  private _startIKFreeDrag(
    e: PointerEvent,
    boneName: BoneName,
    charMgr: CharacterManager,
    characterId: string,
    hitObj: THREE.Object3D,
    footLock: boolean,
  ): void {
    const boneConfig = RIG_CONFIG.bones[boneName]
    const chain = boneConfig?.chain ? findChainByName(boneConfig.chain) : IK_CHAINS.find(
      (c) => c.bones[c.bones.length - 1] === boneName
    )
    if (!chain) { this.controls.enabled = true; this.canvas.releasePointerCapture(e.pointerId); return }

    const objects = charMgr.getChainObjects(chain.bones)
    if (!objects) { this.controls.enabled = true; this.canvas.releasePointerCapture(e.pointerId); return }

    const joints = this.solver.extractJoints(objects, chain.bones)
    const boneLengths = this.solver.computeBoneLengths(objects)
    hitObj.getWorldPosition(this._worldPos)

    // Snapshot foot positions for cascading IK foot-lock if configured.
    let savedFootPosL: THREE.Vector3 | undefined
    let savedFootPosR: THREE.Vector3 | undefined
    if (footLock) {
      const footL = charMgr.getBoneNode('foot.L')
      const footR = charMgr.getBoneNode('foot.R')
      if (footL) savedFootPosL = footL.getWorldPosition(new THREE.Vector3())
      if (footR) savedFootPosR = footR.getWorldPosition(new THREE.Vector3())
    }

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
      savedFootPosL,
      savedFootPosR,
    }
  }

  /** Start an IK-inner drag for an inner bone (elbow, knee). */
  private _startIKInnerDrag(
    e: PointerEvent,
    boneName: BoneName,
    charMgr: CharacterManager,
    characterId: string,
    hitObj: THREE.Object3D,
    chainName: string,
  ): void {
    const chain = findChainByName(chainName)
    if (!chain) { this.controls.enabled = true; this.canvas.releasePointerCapture(e.pointerId); return }

    // Sub-chain = everything up to and including this bone (drop the final effector).
    // e.g. for forearm.L in arm.L: sub = [shoulder.L, upper_arm.L, forearm.L]
    const boneIdx = chain.bones.indexOf(boneName)
    if (boneIdx < 1) { this.controls.enabled = true; this.canvas.releasePointerCapture(e.pointerId); return }
    const subChainBones = chain.bones.slice(0, boneIdx + 1) as BoneName[]

    const objects = charMgr.getChainObjects(subChainBones)
    if (!objects) { this.controls.enabled = true; this.canvas.releasePointerCapture(e.pointerId); return }

    const joints = this.solver.extractJoints(objects, subChainBones)
    const boneLengths = this.solver.computeBoneLengths(objects)
    hitObj.getWorldPosition(this._worldPos)

    // Snapshot the dragged bone's world quaternion so we can restore it each frame.
    const draggedObj = objects[objects.length - 1]
    const savedDraggedWorldQ = draggedObj.getWorldQuaternion(new THREE.Quaternion())

    this.dragState = {
      mode: 'ik-inner',
      characterId,
      effectorBoneName: boneName,
      charMgr,
      pointerId: e.pointerId,
      startScreenPos: new THREE.Vector2(e.clientX, e.clientY),
      joints,
      boneLengths,
      dragPlane: this._buildCameraPlane(this._worldPos),
      currentTarget: this._worldPos.clone(),
      innerChainBones: subChainBones,
      innerDraggedObj: draggedObj,
      savedDraggedWorldQ,
    }
  }

  /** Start a world-translate drag for the hips bone. */
  private _startWorldTranslateDrag(
    e: PointerEvent,
    boneName: BoneName,
    charMgr: CharacterManager,
    characterId: string,
  ): void {
    const boneNode = charMgr.getBoneNode(boneName)
    if (!boneNode) { this.controls.enabled = true; this.canvas.releasePointerCapture(e.pointerId); return }

    boneNode.getWorldPosition(this._worldPos)
    const dragPlane = this._buildCameraPlane(this._worldPos)

    // Capture where the ray first hits the drag plane (delta origin).
    this.raycaster.setFromCamera(this.ndc, this.sceneManager.camera)
    const dragStart = new THREE.Vector3()
    this.raycaster.ray.intersectPlane(dragPlane, dragStart)

    const char = useSceneStore.getState().characters.find((c) => c.id === characterId)
    const wp = char?.worldPosition ?? { x: 0, y: 0, z: 0 }

    this.dragState = {
      mode: 'world-translate',
      characterId,
      effectorBoneName: boneName,
      charMgr,
      pointerId: e.pointerId,
      startScreenPos: new THREE.Vector2(e.clientX, e.clientY),
      worldTransStartPos: new THREE.Vector3(wp.x, wp.y, wp.z),
      worldTransDragPlane: dragPlane,
      worldTransDragStart: dragStart,
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
      // Look up the chain via config (works for all IK effectors including head/chest).
      const cfg = RIG_CONFIG.bones[selectedBoneName]
      const chainDef = cfg?.chain ? findChainByName(cfg.chain) : undefined
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

    const { startScreenPos, characterId, charMgr, mode } = this.dragState
    const moved = new THREE.Vector2(e.clientX, e.clientY).distanceTo(startScreenPos)

    if (moved >= CLICK_THRESHOLD) {
      // Push history BEFORE committing. At this point the Zustand store still holds
      // the pre-drag pose — GizmoController only mutates Three.js during drag.
      useSceneStore.getState().pushHistory()

      if (mode === 'world-translate') {
        // Commit the live-updated group position to the store.
        const pos = charMgr.group.position
        useSceneStore.getState().setWorldPosition(characterId, {
          x: pos.x, y: pos.y, z: pos.z,
        })
      } else {
        // Pose drag (ik-free, ik-inner, rotate-*, translate-*) — write final pose.
        const finalPose = charMgr.extractPoseState()
        this.onPoseChange(characterId, finalPose)
      }
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
