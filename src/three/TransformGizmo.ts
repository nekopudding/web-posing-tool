/**
 * TransformGizmo.ts — Blender-style per-joint transform handles.
 *
 * ============================================================================
 * OVERVIEW
 * ============================================================================
 *
 * When a joint is selected, this gizmo floats at the joint's world position
 * and displays:
 *
 *   Rotation rings (shown when gizmoRotate is true):
 *     Red   ring — rotate around parent's local X axis
 *     Green ring — rotate around parent's local Y axis
 *     Blue  ring — rotate around parent's local Z axis
 *
 *   When a bone has rotateConstraintAxis set, only that one ring is shown.
 *   All rings are oriented in the parent bone's local space — they update
 *   every frame via updateTransform().
 *
 *   Translation arrows (only for IK end effectors: hand.L/R, foot.L/R):
 *     Red   arrow — translate along world X axis
 *     Green arrow — translate along world Y axis
 *     Blue  arrow — translate along world Z axis
 *
 * ============================================================================
 * LOCAL-SPACE RINGS
 * ============================================================================
 *
 * Rings live inside `rotateGroup`, a child of `group`. Each frame,
 * `rotateGroup.quaternion` is set to the attached bone's parent world
 * quaternion so the rings align with the bone's local coordinate axes.
 *
 * Translation arrows remain direct children of `group` (world-aligned).
 *
 * ============================================================================
 * SCREEN-SPACE SIZING
 * ============================================================================
 *
 * The gizmo is positioned in world space but must appear a consistent size
 * on screen regardless of camera distance. We scale the group each frame:
 *
 *   Perspective: scale = distance_to_camera * PERSPECTIVE_SCALE_FACTOR
 *   Orthographic: scale = camera.top * ORTHO_SCALE_FACTOR
 *
 * ============================================================================
 * HANDLE IDENTIFICATION
 * ============================================================================
 *
 * Each handle mesh has `userData.handleType: GizmoHandleType` set at creation.
 * GizmoController raycasts against `gizmo.handles` and reads this field to
 * determine which axis/operation was hit.
 *
 * ============================================================================
 * DEPTH RENDERING
 * ============================================================================
 *
 * All handle materials use `depthTest: false` and `renderOrder = 10` so they
 * always render on top of the skeleton geometry. This prevents the gizmo from
 * being hidden behind the model.
 */

import * as THREE from 'three'

// ---- Scale constants (tune these for feel) ----

/** Distance multiplier for perspective cameras. Higher = larger gizmo on screen. */
const PERSPECTIVE_SCALE_FACTOR = 0.18

/**
 * Fraction of the camera's vertical view half-height for ortho cameras.
 * camera.top = half the world-unit height visible; 0.35 gives a comfortable size.
 */
const ORTHO_SCALE_FACTOR = 0.35

// ---- Handle type ----

export type GizmoHandleType =
  | 'rotate-x'
  | 'rotate-y'
  | 'rotate-z'
  | 'translate-x'
  | 'translate-y'
  | 'translate-z'

// ---- Material helpers ----

/** Create a handle material: always-on-top, no depth test. */
function makeHandleMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.55,
  })
}

// ---- Axis colors ----
const COLOR_X = 0xdd3333 // red
const COLOR_Y = 0x33cc44 // green
const COLOR_Z = 0x3377ff // blue
const COLOR_X_BRIGHT = 0xff6666
const COLOR_Y_BRIGHT = 0x66ff88
const COLOR_Z_BRIGHT = 0x66aaff

// --------------------------------------------------------------------------
// TransformGizmo
// --------------------------------------------------------------------------

export class TransformGizmo {
  /**
   * Top-level group added to the scene.
   * Moved to the selected joint's world position each frame via `updateTransform`.
   * Quaternion stays identity — orientation is handled by rotateGroup.
   */
  readonly group: THREE.Group

  /**
   * Child group that holds rotation rings.
   * Its quaternion is set each frame to the attached bone's parent world quaternion,
   * so the rings align with the bone's local coordinate axes.
   */
  private rotateGroup: THREE.Group

  /**
   * All raycasting targets. GizmoController passes these to `raycaster.intersectObjects`.
   * Each mesh has `userData.handleType: GizmoHandleType`.
   * Rebuilt in _syncHandles() whenever visible handles change.
   */
  readonly handles: THREE.Mesh[] = []

  // ---- Rotation ring meshes (visible) ----
  private ringX: THREE.Mesh
  private ringY: THREE.Mesh
  private ringZ: THREE.Mesh

  // ---- Invisible hit-area meshes for rings (wider torus, opacity 0) ----
  // Raycasting targets — larger than the visual to give a more forgiving click area.
  private ringXHit: THREE.Mesh
  private ringYHit: THREE.Mesh
  private ringZHit: THREE.Mesh

  // ---- Translation arrow groups (shown only for IK end effectors) ----
  private arrowGroupX: THREE.Group
  private arrowGroupY: THREE.Group
  private arrowGroupZ: THREE.Group

  // ---- Invisible hit-area meshes for arrows (wider cylinder per arrow) ----
  private arrowXHit: THREE.Mesh
  private arrowYHit: THREE.Mesh
  private arrowZHit: THREE.Mesh

  // ---- Per-ring materials (stored so we can swap to bright on drag) ----
  private matRingX: THREE.MeshBasicMaterial
  private matRingY: THREE.MeshBasicMaterial
  private matRingZ: THREE.MeshBasicMaterial
  private matArrowX: THREE.MeshBasicMaterial
  private matArrowY: THREE.MeshBasicMaterial
  private matArrowZ: THREE.MeshBasicMaterial

  /** The Three.js node the gizmo is attached to, or null if detached. */
  private attachedNode: THREE.Object3D | null = null
  /** When false, attach() will not show the group and setGizmosVisible(false) hides it. */
  private _gizmosVisible = true

  private scene: THREE.Scene

  // Reusable vectors / quaternions
  private _worldPos = new THREE.Vector3()
  private _camPos = new THREE.Vector3()
  private _parentQ = new THREE.Quaternion()

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.group = new THREE.Group()
    this.group.name = 'transformGizmo'
    this.group.visible = false
    // Render the gizmo group on top (materials also have depthTest: false)
    this.group.renderOrder = 10
    scene.add(this.group)

    // ---- Sub-group for rotation rings (local-space oriented) ----
    this.rotateGroup = new THREE.Group()
    this.rotateGroup.name = 'rotateGroup'
    this.group.add(this.rotateGroup)

    // ---- Materials ----
    this.matRingX = makeHandleMaterial(COLOR_X)
    this.matRingY = makeHandleMaterial(COLOR_Y)
    this.matRingZ = makeHandleMaterial(COLOR_Z)
    this.matArrowX = makeHandleMaterial(COLOR_X)
    this.matArrowY = makeHandleMaterial(COLOR_Y)
    this.matArrowZ = makeHandleMaterial(COLOR_Z)

    // ---- Rotation rings ----
    // TorusGeometry(radius, tubeRadius, radialSegments, tubularSegments)
    // radialSegments=6 gives a hexagonal cross-section (performance).
    // tubularSegments=48 for a smooth circle.
    // Radius 0.65 keeps rings tight around the joint sphere.
    const ringGeo = new THREE.TorusGeometry(0.65, 0.012, 6, 48)

    this.ringX = new THREE.Mesh(ringGeo, this.matRingX)
    this.ringX.name = 'ring-x'
    this.ringX.userData.handleType = 'rotate-x' as GizmoHandleType
    // X ring lies in YZ plane → rotate torus 90° around Y
    this.ringX.rotation.y = Math.PI / 2
    this.ringX.renderOrder = 10

    this.ringY = new THREE.Mesh(ringGeo, this.matRingY)
    this.ringY.name = 'ring-y'
    this.ringY.userData.handleType = 'rotate-y' as GizmoHandleType
    // Y ring lies in XZ plane → rotate torus 90° around X
    this.ringY.rotation.x = Math.PI / 2
    this.ringY.renderOrder = 10

    this.ringZ = new THREE.Mesh(ringGeo, this.matRingZ)
    this.ringZ.name = 'ring-z'
    this.ringZ.userData.handleType = 'rotate-z' as GizmoHandleType
    // Z ring lies in XY plane — default Torus orientation, no rotation needed
    this.ringZ.renderOrder = 10

    // Rings are children of rotateGroup (local-space oriented), not group directly.
    this.rotateGroup.add(this.ringX, this.ringY, this.ringZ)

    // ---- Ring hit areas (invisible, wider torus — larger click target) ----
    // Same center/rotation as their visible counterparts; tube radius is ~6× thicker.
    // Three.js raycasts against geometry regardless of opacity, so these act as
    // a forgiving click zone without changing the visual appearance.
    const ringHitGeo = new THREE.TorusGeometry(0.65, 0.07, 4, 24)
    const hitMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    })

    this.ringXHit = new THREE.Mesh(ringHitGeo, hitMat)
    this.ringXHit.userData.handleType = 'rotate-x' as GizmoHandleType
    this.ringXHit.rotation.y = Math.PI / 2
    this.ringXHit.renderOrder = 10

    this.ringYHit = new THREE.Mesh(ringHitGeo, hitMat)
    this.ringYHit.userData.handleType = 'rotate-y' as GizmoHandleType
    this.ringYHit.rotation.x = Math.PI / 2
    this.ringYHit.renderOrder = 10

    this.ringZHit = new THREE.Mesh(ringHitGeo, hitMat)
    this.ringZHit.userData.handleType = 'rotate-z' as GizmoHandleType
    this.ringZHit.renderOrder = 10

    this.rotateGroup.add(this.ringXHit, this.ringYHit, this.ringZHit)

    // ---- Translation arrows (direct children of group — world-aligned) ----
    this.arrowGroupX = this._buildArrow('translate-x', this.matArrowX)
    this.arrowGroupY = this._buildArrow('translate-y', this.matArrowY)
    this.arrowGroupZ = this._buildArrow('translate-z', this.matArrowZ)

    // Orient each arrow group along its axis.
    // Arrow geometry points up (+Y) by default; we rotate to align with world axes.
    // X arrow: rotate -90° around Z so +Y → +X
    this.arrowGroupX.rotation.z = -Math.PI / 2
    // Y arrow: already points +Y — no rotation
    // Z arrow: rotate +90° around X so +Y → +Z
    this.arrowGroupZ.rotation.x = Math.PI / 2

    // Arrows go into the main group (not rotateGroup) so they stay world-aligned.
    this.group.add(this.arrowGroupX, this.arrowGroupY, this.arrowGroupZ)

    // ---- Arrow hit areas (invisible wider cylinder spanning shaft + cone) ----
    // Shaft runs from y=0.65 to y=1.07; cone tip at y=1.17.
    // Hit cylinder: y=0.65 → 1.17, height=0.52, center=0.91, radius=0.04.
    const arrowHitGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.52, 6)
    arrowHitGeo.translate(0, 0.91, 0)

    this.arrowXHit = new THREE.Mesh(arrowHitGeo, hitMat)
    this.arrowXHit.userData.handleType = 'translate-x' as GizmoHandleType
    this.arrowXHit.renderOrder = 10

    this.arrowYHit = new THREE.Mesh(arrowHitGeo, hitMat)
    this.arrowYHit.userData.handleType = 'translate-y' as GizmoHandleType
    this.arrowYHit.renderOrder = 10

    this.arrowZHit = new THREE.Mesh(arrowHitGeo, hitMat)
    this.arrowZHit.userData.handleType = 'translate-z' as GizmoHandleType
    this.arrowZHit.renderOrder = 10

    // Arrow hit meshes share the same parent groups as their visual counterparts
    // so they inherit the same orientation (X rotated -90° around Z, etc.).
    this.arrowGroupX.add(this.arrowXHit)
    this.arrowGroupY.add(this.arrowYHit)
    this.arrowGroupZ.add(this.arrowZHit)
  }

  // --------------------------------------------------------------------------
  // Arrow construction helper
  // --------------------------------------------------------------------------

  /**
   * Build a translation arrow: shaft (cylinder) + tip (cone), tagged with handleType.
   * The arrow points along +Y in its own local space; the caller rotates the group.
   */
  private _buildArrow(handleType: GizmoHandleType, mat: THREE.MeshBasicMaterial): THREE.Group {
    const group = new THREE.Group()
    group.name = `arrow-${handleType}`

    // Shaft: thin cylinder, starts just outside the ring radius (0.65) to 1.1
    const shaftGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.42, 6)
    shaftGeo.translate(0, 0.65 + 0.42 / 2, 0) // place above the ring

    // Cone tip: at top of shaft → +0.1
    const coneGeo = new THREE.ConeGeometry(0.03, 0.1, 6)
    coneGeo.translate(0, 0.65 + 0.42 + 0.05, 0) // 0.05 = half cone height

    const shaft = new THREE.Mesh(shaftGeo, mat)
    shaft.renderOrder = 10
    shaft.userData.handleType = handleType

    const cone = new THREE.Mesh(coneGeo, mat)
    cone.renderOrder = 10
    cone.userData.handleType = handleType

    group.add(shaft, cone)
    this.handles.push(shaft, cone)
    return group
  }

  // --------------------------------------------------------------------------
  // Attach / detach
  // --------------------------------------------------------------------------

  /**
   * Attach the gizmo to a joint node.
   * @param boneNode          The Three.js Object3D for the joint.
   * @param showTranslate     If true, translation arrows are shown (IK effectors).
   * @param showRotate        If true, rotation rings are shown.
   * @param constraintAxis    When set, only this one ring is shown (single-axis constraint).
   *                          The axis is in the parent bone's local space.
   */
  attach(
    boneNode: THREE.Object3D,
    showTranslate: boolean,
    showRotate: boolean,
    constraintAxis?: 'x' | 'y' | 'z',
  ): void {
    this.attachedNode = boneNode
    this.group.visible = this._gizmosVisible

    // Determine which rings to show.
    // With a single-axis constraint, hide all rings except the constrained one.
    if (showRotate && constraintAxis) {
      this.ringX.visible = constraintAxis === 'x'
      this.ringY.visible = constraintAxis === 'y'
      this.ringZ.visible = constraintAxis === 'z'
    } else {
      this.ringX.visible = showRotate
      this.ringY.visible = showRotate
      this.ringZ.visible = showRotate
    }

    this.arrowGroupX.visible = showTranslate
    this.arrowGroupY.visible = showTranslate
    this.arrowGroupZ.visible = showTranslate

    this._syncHandles()
    this.updateTransform()
  }

  /** Detach and hide the gizmo. */
  detach(): void {
    this.attachedNode = null
    this.group.visible = false
  }

  /** Show or hide the gizmo group globally. When hidden, attach() won't re-show it. */
  setGizmosVisible(visible: boolean): void {
    this._gizmosVisible = visible
    // Only touch group.visible if attached; detach() already hides it.
    if (this.attachedNode) this.group.visible = visible
  }

  // --------------------------------------------------------------------------
  // Per-frame updates
  // --------------------------------------------------------------------------

  /**
   * Move the gizmo to the attached joint's current world position and orient
   * the rotation rings to the parent bone's local space.
   * Must be called every frame during drag (the bone moves, the gizmo follows).
   */
  updateTransform(): void {
    if (!this.attachedNode) return

    // Position: follow the joint in world space.
    this.attachedNode.getWorldPosition(this._worldPos)
    this.group.position.copy(this._worldPos)

    // Orientation: rotate rings to align with the parent bone's local axes.
    // This makes the X/Y/Z rings correspond to the bone's local coordinate space,
    // not the world axes. The group itself stays world-aligned (identity quaternion)
    // so the translation arrows (its direct children) remain world-space.
    if (this.attachedNode.parent) {
      this.attachedNode.parent.getWorldQuaternion(this._parentQ)
      this.rotateGroup.quaternion.copy(this._parentQ)
    } else {
      this.rotateGroup.quaternion.identity()
    }
  }

  /**
   * Scale the gizmo group to maintain a constant apparent screen size.
   * Call once per frame after `updateTransform`.
   */
  updateScale(camera: THREE.Camera): void {
    if (!this.attachedNode) return
    let scale: number
    if (camera instanceof THREE.OrthographicCamera) {
      // Ortho: camera.top = half of the visible world height — use as a size reference.
      scale = Math.abs(camera.top) * ORTHO_SCALE_FACTOR
    } else {
      // Perspective: scale proportional to depth so screen size stays constant.
      camera.getWorldPosition(this._camPos)
      const dist = this._camPos.distanceTo(this.group.position)
      scale = dist * PERSPECTIVE_SCALE_FACTOR
    }
    this.group.scale.setScalar(Math.max(scale, 0.05)) // clamp to avoid zero scale
  }

  // --------------------------------------------------------------------------
  // Local-axis query (for GizmoController drag math)
  // --------------------------------------------------------------------------

  /**
   * Returns the world-space unit vector for the given local rotation axis.
   *
   * Because `rotateGroup` is oriented to the parent bone's world quaternion,
   * the group's local X/Y/Z axes ARE the parent bone's local X/Y/Z axes in
   * world space. GizmoController calls this at drag-start to get the correct
   * world-space rotation axis instead of using hardcoded (1,0,0) etc.
   */
  getLocalAxis(axis: 'x' | 'y' | 'z'): THREE.Vector3 {
    const base =
      axis === 'x' ? new THREE.Vector3(1, 0, 0)
      : axis === 'y' ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1)
    return base.applyQuaternion(this.rotateGroup.quaternion)
  }

  // --------------------------------------------------------------------------
  // Active handle highlighting
  // --------------------------------------------------------------------------

  /**
   * Highlight the active drag axis handle with a brighter color.
   * Call on drag start; call with `null` on drag end.
   */
  setActiveHandle(handleType: GizmoHandleType | null): void {
    this.matRingX.color.setHex(handleType === 'rotate-x' ? COLOR_X_BRIGHT : COLOR_X)
    this.matRingY.color.setHex(handleType === 'rotate-y' ? COLOR_Y_BRIGHT : COLOR_Y)
    this.matRingZ.color.setHex(handleType === 'rotate-z' ? COLOR_Z_BRIGHT : COLOR_Z)
    this.matArrowX.color.setHex(handleType === 'translate-x' ? COLOR_X_BRIGHT : COLOR_X)
    this.matArrowY.color.setHex(handleType === 'translate-y' ? COLOR_Y_BRIGHT : COLOR_Y)
    this.matArrowZ.color.setHex(handleType === 'translate-z' ? COLOR_Z_BRIGHT : COLOR_Z)
  }

  // --------------------------------------------------------------------------
  // Handle identification (post-raycast)
  // --------------------------------------------------------------------------

  /**
   * Given a mesh returned by `raycaster.intersectObjects(gizmo.handles)`,
   * returns the GizmoHandleType stored in `userData`, or null.
   */
  identifyHandle(mesh: THREE.Object3D): GizmoHandleType | null {
    return (mesh.userData.handleType as GizmoHandleType) ?? null
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  dispose(): void {
    this.scene.remove(this.group)
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        ;(obj.material as THREE.Material).dispose()
      }
    })
    this.handles.length = 0
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Rebuild the raycasting handle list from currently visible rings and arrows.
   * Uses the invisible hit-area meshes (not the visual meshes) as raycast targets
   * so the clickable area is larger than the visible geometry.
   */
  private _syncHandles(): void {
    this.handles.length = 0
    // Rings: use hit-area meshes; visibility tracks the corresponding visible ring.
    if (this.ringX.visible) this.handles.push(this.ringXHit)
    if (this.ringY.visible) this.handles.push(this.ringYHit)
    if (this.ringZ.visible) this.handles.push(this.ringZHit)
    // Arrows: use the dedicated hit cylinder per arrow group.
    if (this.arrowGroupX.visible) this.handles.push(this.arrowXHit)
    if (this.arrowGroupY.visible) this.handles.push(this.arrowYHit)
    if (this.arrowGroupZ.visible) this.handles.push(this.arrowZHit)
  }
}
