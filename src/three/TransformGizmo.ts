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
 *   Rotation rings (always shown):
 *     Red   ring — rotate around world X axis (ring lies in YZ plane)
 *     Green ring — rotate around world Y axis (ring lies in XZ plane)
 *     Blue  ring — rotate around world Z axis (ring lies in XY plane)
 *
 *   Translation arrows (only for IK end effectors: hand.L/R, foot.L/R):
 *     Red   arrow — translate along world X axis
 *     Green arrow — translate along world Y axis
 *     Blue  arrow — translate along world Z axis
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
   */
  readonly group: THREE.Group

  /**
   * All raycasting targets. GizmoController passes these to `raycaster.intersectObjects`.
   * Each mesh has `userData.handleType: GizmoHandleType`.
   */
  readonly handles: THREE.Mesh[] = []

  // ---- Rotation ring meshes (always shown when attached) ----
  private ringX: THREE.Mesh
  private ringY: THREE.Mesh
  private ringZ: THREE.Mesh

  // ---- Translation arrow groups (shown only for IK end effectors) ----
  private arrowGroupX: THREE.Group
  private arrowGroupY: THREE.Group
  private arrowGroupZ: THREE.Group

  // ---- Per-ring materials (stored so we can swap to bright on drag) ----
  private matRingX: THREE.MeshBasicMaterial
  private matRingY: THREE.MeshBasicMaterial
  private matRingZ: THREE.MeshBasicMaterial
  private matArrowX: THREE.MeshBasicMaterial
  private matArrowY: THREE.MeshBasicMaterial
  private matArrowZ: THREE.MeshBasicMaterial

  /** The Three.js node the gizmo is attached to, or null if detached. */
  private attachedNode: THREE.Object3D | null = null

  private scene: THREE.Scene

  // Reusable vectors
  private _worldPos = new THREE.Vector3()
  private _camPos = new THREE.Vector3()

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.group = new THREE.Group()
    this.group.name = 'transformGizmo'
    this.group.visible = false
    // Render the gizmo group on top (materials also have depthTest: false)
    this.group.renderOrder = 10
    scene.add(this.group)

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
    const ringGeo = new THREE.TorusGeometry(1.0, 0.015, 6, 48)

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

    this.group.add(this.ringX, this.ringY, this.ringZ)
    this.handles.push(this.ringX, this.ringY, this.ringZ)

    // ---- Translation arrows ----
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

    this.group.add(this.arrowGroupX, this.arrowGroupY, this.arrowGroupZ)
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

    // Shaft: thin cylinder, starts at y=0.9 (ring radius) to y=1.55
    const shaftGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.65, 6)
    shaftGeo.translate(0, 0.9 + 0.65 / 2, 0) // place above the ring

    // Cone tip: at y=1.55 → 1.75
    const coneGeo = new THREE.ConeGeometry(0.04, 0.14, 6)
    coneGeo.translate(0, 0.9 + 0.65 + 0.1, 0) // 0.1 = half cone height

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
   * @param boneNode       The Three.js Object3D for the joint — gizmo tracks this position.
   * @param showTranslate  If true, translation arrows are shown (IK effectors).
   * @param showRotate     If true, rotation rings are shown. False for pure-IK tips (e.g. head).
   */
  attach(boneNode: THREE.Object3D, showTranslate: boolean, showRotate: boolean): void {
    this.attachedNode = boneNode
    this.group.visible = true

    // Show/hide rings and arrows based on per-bone config
    this.ringX.visible = showRotate
    this.ringY.visible = showRotate
    this.ringZ.visible = showRotate

    this.arrowGroupX.visible = showTranslate
    this.arrowGroupY.visible = showTranslate
    this.arrowGroupZ.visible = showTranslate

    // Sync raycasting targets to match visible handles
    this._syncHandles(showTranslate, showRotate)

    this.updateTransform()
  }

  /** Detach and hide the gizmo. */
  detach(): void {
    this.attachedNode = null
    this.group.visible = false
  }

  // --------------------------------------------------------------------------
  // Per-frame updates
  // --------------------------------------------------------------------------

  /**
   * Move the gizmo group to match the attached joint's current world position.
   * Must be called every frame during drag (the bone moves, the gizmo follows).
   */
  updateTransform(): void {
    if (!this.attachedNode) return
    this.attachedNode.getWorldPosition(this._worldPos)
    this.group.position.copy(this._worldPos)
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
   * Rebuild the raycasting handle list to match currently visible handles.
   * Called whenever attach() changes which handles are shown.
   */
  private _syncHandles(showTranslate: boolean, showRotate: boolean): void {
    this.handles.length = 0
    if (showRotate) {
      this.handles.push(this.ringX, this.ringY, this.ringZ)
    }
    if (showTranslate) {
      this.arrowGroupX.traverse((o) => { if (o instanceof THREE.Mesh) this.handles.push(o) })
      this.arrowGroupY.traverse((o) => { if (o instanceof THREE.Mesh) this.handles.push(o) })
      this.arrowGroupZ.traverse((o) => { if (o instanceof THREE.Mesh) this.handles.push(o) })
    }
  }
}
