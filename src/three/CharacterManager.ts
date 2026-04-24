/**
 * CharacterManager.ts — Builds and manages a single character's 3D rig.
 *
 * ============================================================================
 * PLACEHOLDER RIG ARCHITECTURE
 * ============================================================================
 *
 * In Phase 1–3 (no real GLTF model), each character is represented as a
 * hierarchy of Three.js Object3D nodes connected by BoxGeometry "bone" segments
 * and SphereGeometry "joint" markers.
 *
 * Each joint node in the hierarchy:
 *   1. Sits at the anatomical joint position in its parent's local space.
 *   2. Has a child BoxGeometry mesh representing the bone segment extending
 *      from this joint toward its child joint.
 *   3. Has a child SphereGeometry mesh at origin (the joint's own position) —
 *      this is the draggable gizmo handle. `userData.boneName` is set on this
 *      sphere for raycasting lookups in GizmoController.
 *
 * Hierarchy in Three.js (indented = parent → child):
 *
 *   charGroup (THREE.Group, world position = character worldPosition)
 *     └─ rigRoot (Object3D at y=0)
 *          └─ hipsNode
 *               ├─ hips_bone (BoxGeometry pointing +Y)
 *               ├─ hips_gizmo (SphereGeometry at joint origin)
 *               ├─ spineNode
 *               │    ├─ spine_bone
 *               │    ├─ spine_gizmo
 *               │    └─ chestNode
 *               │         ├─ ...
 *               ├─ shoulder.L_Node
 *               │    ├─ ...
 *               └─ upper_leg.L_Node
 *                    ├─ ...
 *
 * Why Object3D nodes rather than THREE.Bone/THREE.Skeleton?
 *   Simpler to build and debug for the placeholder. Three.js Skeleton/SkinnedMesh
 *   is needed only for skinned meshes (Phase 4). Using plain Object3Ds means
 *   the IK solver's `applyToObjects` can write quaternions directly without
 *   needing a Skeleton reference.
 *
 * ============================================================================
 * BONE GEOMETRY OFFSET STRATEGY
 * ============================================================================
 *
 * A BoxGeometry of height `boneLength` is centered by default at (0,0,0),
 * meaning it extends from y=-boneLength/2 to y=+boneLength/2.
 *
 * We want the bone to START at the joint origin and extend TOWARD the child
 * joint. So we translate the geometry up by boneLength/2 along Y, making the
 * bottom of the box sit at y=0 (the joint pivot) and the top at y=boneLength.
 *
 * This is done by calling `geometry.translate(0, boneLength/2, 0)` once at
 * creation time (baked into the geometry, not a mesh position offset), so the
 * Object3D pivot remains exactly at the joint center.
 */

import * as THREE from 'three'
import { BONE_LENGTHS, type BoneName } from './IKChains'
import { createOutlineMaterial, setOutlineThickness } from './OutlineMaterial'
import type { PoseState, MorphWeights, LayerVisibility, SerializedQuaternion } from '../store/useSceneStore'

// --------------------------------------------------------------------------
// Shared geometry cache
// --------------------------------------------------------------------------

// All characters share the same joint sphere geometry (read-only).
const JOINT_GEO = new THREE.SphereGeometry(0.055, 8, 6)

// Bone segment geometry is per-bone (different heights) but shared across
// characters via a cache keyed by boneLength.
const boneMeshGeoCache = new Map<number, THREE.BoxGeometry>()

function getBoneMeshGeo(boneLength: number): THREE.BoxGeometry {
  const key = Math.round(boneLength * 1000) // cache key at mm precision
  if (!boneMeshGeoCache.has(key)) {
    const geo = new THREE.BoxGeometry(0.07, boneLength, 0.07)
    // Translate so the box starts at y=0 (joint pivot) and ends at y=boneLength.
    // This keeps the Object3D pivot at the joint center for correct IK application.
    geo.translate(0, boneLength / 2, 0)
    boneMeshGeoCache.set(key, geo)
  }
  return boneMeshGeoCache.get(key)!
}

// --------------------------------------------------------------------------
// Materials — shared across all characters, colors differ per instance
// --------------------------------------------------------------------------

const JOINT_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x88aaff,
  emissive: 0x222244,
  roughness: 0.6,
  metalness: 0.1,
})
const ACTIVE_JOINT_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xff8844,
  emissive: 0x441100,
  roughness: 0.4,
  metalness: 0.2,
})
const BONE_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x6688cc,
  roughness: 0.7,
  metalness: 0.0,
})
/**
 * Applied to the single joint sphere that is currently selected (clicked or dragged).
 * Bright yellow so it stands out against both the blue inactive and orange active materials.
 */
const SELECTED_JOINT_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xffee44,
  emissive: 0x886600,
  roughness: 0.2,
  metalness: 0.3,
})

// --------------------------------------------------------------------------
// CharacterManager
// --------------------------------------------------------------------------

export class CharacterManager {
  readonly characterId: string

  /**
   * Top-level group added to the scene.
   * Move this group to position/rotate the whole character.
   */
  readonly group: THREE.Group

  /**
   * Map from bone name → the Object3D pivot node for that joint.
   * Used by GizmoController to find the Three.js object for a given bone name,
   * and by IKSolver.buildChainObjects to assemble the chain object list.
   */
  readonly boneNodeMap: Map<BoneName, THREE.Object3D> = new Map()

  /**
   * All joint sphere meshes — passed to GizmoController for raycasting.
   * Each sphere has `userData.boneName` set to its BoneName string and
   * `userData.characterId` set to this character's ID.
   */
  readonly jointMeshes: THREE.Mesh[] = []

  /**
   * All outline ShaderMaterial instances — updated when outline thickness changes.
   */
  private outlineMaterials: THREE.ShaderMaterial[] = []

  private scene: THREE.Scene
  /** Whether this character is the active (selected) one in the roster. */
  private _isActive = false
  /** The bone name of the currently selected joint sphere, or null. */
  private _selectedBone: string | null = null

  constructor(characterId: string, scene: THREE.Scene) {
    this.characterId = characterId
    this.scene = scene
    this.group = new THREE.Group()
    this.group.name = `character_${characterId}`
    scene.add(this.group)
    this.buildPlaceholderRig()
  }

  // --------------------------------------------------------------------------
  // Rig construction
  // --------------------------------------------------------------------------

  /**
   * Build the full placeholder skeleton as a nested Object3D hierarchy.
   * Call once after construction. Rebuilding destroys and recreates the rig.
   */
  buildPlaceholderRig(): void {
    // Clear any existing rig
    while (this.group.children.length > 0) {
      this.group.remove(this.group.children[0])
    }
    this.boneNodeMap.clear()
    this.jointMeshes.length = 0
    this.outlineMaterials.length = 0

    // The root Object3D acts as the rig root at y=0
    const rigRoot = new THREE.Object3D()
    rigRoot.name = 'rigRoot'
    this.group.add(rigRoot)

    // Create root node (invisible, just a pivot)
    const rootNode = this.createJointNode('root', 0)
    rigRoot.add(rootNode)
    this.boneNodeMap.set('root', rootNode)

    // ---- Hips ----
    // Hips are centered at y=0.9 (approximately mid-torso height for 1.7m figure)
    const hipsNode = this.createJointNode('hips', BONE_LENGTHS['spine'] ?? 0.3)
    hipsNode.position.set(0, 0.9, 0)
    rootNode.add(hipsNode)
    this.boneNodeMap.set('hips', hipsNode)

    // ---- Spine chain: hips → spine → chest ----
    const spineNode = this.createJointNode('spine', BONE_LENGTHS['chest'] ?? 0.3)
    spineNode.position.set(0, BONE_LENGTHS['spine'] ?? 0.3, 0)
    hipsNode.add(spineNode)
    this.boneNodeMap.set('spine', spineNode)

    const chestNode = this.createJointNode('chest', 0)
    chestNode.position.set(0, BONE_LENGTHS['chest'] ?? 0.3, 0)
    spineNode.add(chestNode)
    this.boneNodeMap.set('chest', chestNode)

    // ---- Neck and head ----
    const neckNode = this.createJointNode('neck', BONE_LENGTHS['head'] ?? 0.25)
    neckNode.position.set(0, BONE_LENGTHS['neck'] ?? 0.12, 0)
    chestNode.add(neckNode)
    this.boneNodeMap.set('neck', neckNode)

    const headNode = this.createJointNode('head', 0)
    headNode.position.set(0, BONE_LENGTHS['head'] ?? 0.25, 0)
    neckNode.add(headNode)
    // Add a rough "skull" box for the head
    const skullGeo = new THREE.BoxGeometry(0.22, 0.24, 0.20)
    skullGeo.translate(0, 0.12, 0)
    const skullMesh = new THREE.Mesh(skullGeo, BONE_MATERIAL)
    const skullOutline = new THREE.Mesh(skullGeo, createOutlineMaterial())
    this.outlineMaterials.push(skullOutline.material as THREE.ShaderMaterial)
    headNode.add(skullMesh)
    headNode.add(skullOutline)
    this.boneNodeMap.set('head', headNode)

    // ---- Arms (left and right) ----
    for (const side of ['L', 'R'] as const) {
      const sx = side === 'L' ? -1 : 1
      const shoulderName = `shoulder.${side}` as BoneName
      const upperArmName = `upper_arm.${side}` as BoneName
      const forearmName = `forearm.${side}` as BoneName
      const handName = `hand.${side}` as BoneName

      // Shoulder — positioned at chest height, offset sideways
      const shoulderNode = this.createJointNode(shoulderName, BONE_LENGTHS[shoulderName] ?? 0.15)
      shoulderNode.position.set(sx * 0.12, 0, 0)
      chestNode.add(shoulderNode)
      this.boneNodeMap.set(shoulderName, shoulderNode)

      // Upper arm — hangs down-outward from shoulder
      const upperArmNode = this.createJointNode(upperArmName, BONE_LENGTHS[upperArmName] ?? 0.28)
      upperArmNode.position.set(sx * (BONE_LENGTHS[shoulderName] ?? 0.15), 0, 0)
      // Rotate to point down-outward: -90° around Z for L side, +90° for R side
      upperArmNode.rotation.z = sx * -Math.PI / 2
      shoulderNode.add(upperArmNode)
      this.boneNodeMap.set(upperArmName, upperArmNode)

      // Forearm — continues from upper arm
      const forearmNode = this.createJointNode(forearmName, BONE_LENGTHS[forearmName] ?? 0.25)
      forearmNode.position.set(0, BONE_LENGTHS[upperArmName] ?? 0.28, 0)
      upperArmNode.add(forearmNode)
      this.boneNodeMap.set(forearmName, forearmNode)

      // Hand — end effector
      const handNode = this.createJointNode(handName, 0)
      handNode.position.set(0, BONE_LENGTHS[forearmName] ?? 0.25, 0)
      forearmNode.add(handNode)
      this.boneNodeMap.set(handName, handNode)
    }

    // ---- Legs (left and right) ----
    for (const side of ['L', 'R'] as const) {
      const sx = side === 'L' ? -1 : 1
      const upperLegName = `upper_leg.${side}` as BoneName
      const lowerLegName = `lower_leg.${side}` as BoneName
      const footName = `foot.${side}` as BoneName
      const toeName = `toe.${side}` as BoneName

      // Upper leg — hangs down from hips
      const upperLegNode = this.createJointNode(upperLegName, BONE_LENGTHS[upperLegName] ?? 0.42)
      upperLegNode.position.set(sx * 0.11, 0, 0)
      // Rotate to point straight down: 180° around Z so +Y points to -Y (down)
      upperLegNode.rotation.z = Math.PI
      hipsNode.add(upperLegNode)
      this.boneNodeMap.set(upperLegName, upperLegNode)

      // Lower leg
      const lowerLegNode = this.createJointNode(lowerLegName, BONE_LENGTHS[lowerLegName] ?? 0.38)
      lowerLegNode.position.set(0, BONE_LENGTHS[upperLegName] ?? 0.42, 0)
      upperLegNode.add(lowerLegNode)
      this.boneNodeMap.set(lowerLegName, lowerLegNode)

      // Foot — IK end effector
      const footNode = this.createJointNode(footName, BONE_LENGTHS[footName] ?? 0.18)
      footNode.position.set(0, BONE_LENGTHS[lowerLegName] ?? 0.38, 0)
      lowerLegNode.add(footNode)
      this.boneNodeMap.set(footName, footNode)

      // Toe
      const toeNode = this.createJointNode(toeName, 0)
      // Toes extend forward (+Z) from foot, so rotate the node -90° around X
      toeNode.position.set(0, BONE_LENGTHS[footName] ?? 0.18, 0)
      footNode.add(toeNode)
      this.boneNodeMap.set(toeName, toeNode)
    }
  }

  /**
   * Create a joint node with a sphere gizmo and (optionally) a bone segment box.
   *
   * @param boneName  Name of this joint — stored in sphere userData for raycasting.
   * @param segmentLength  Length of the bone box segment extending from this joint.
   *                       Pass 0 to skip the segment (leaf joints like hands/feet
   *                       use a box only to show the wrist/ankle volume, added
   *                       separately, or just have the sphere).
   */
  private createJointNode(boneName: BoneName, segmentLength: number): THREE.Object3D {
    const node = new THREE.Object3D()
    node.name = `joint_${boneName}`

    // ---- Joint sphere (gizmo) ----
    const sphere = new THREE.Mesh(JOINT_GEO, JOINT_MATERIAL.clone())
    sphere.name = `gizmo_${boneName}`
    sphere.userData.boneName = boneName
    sphere.userData.characterId = this.characterId
    // Render gizmos on top of geometry so they're visible through bone boxes.
    sphere.renderOrder = 2
    node.add(sphere)
    this.jointMeshes.push(sphere)

    // ---- Bone segment box (if length > 0) ----
    if (segmentLength > 0.001) {
      const geo = getBoneMeshGeo(segmentLength)
      const boneMesh = new THREE.Mesh(geo, BONE_MATERIAL.clone())
      boneMesh.name = `segment_${boneName}`
      node.add(boneMesh)

      // Outline mesh (inverted hull) — same geometry, BackSide material
      const outlineMat = createOutlineMaterial(0x000000, 0.012)
      const outlineMesh = new THREE.Mesh(geo, outlineMat)
      outlineMesh.name = `outline_${boneName}`
      outlineMesh.renderOrder = 1 // draw before fill so fill occludes outline at self-intersections
      node.add(outlineMesh)
      this.outlineMaterials.push(outlineMat)
    }

    return node
  }

  // --------------------------------------------------------------------------
  // Pose application
  // --------------------------------------------------------------------------

  /**
   * Apply a PoseState (from the Zustand store) to the Three.js rig.
   * Called by the Zustand subscription in ViewportCanvas — NOT from React renders.
   *
   * @param pose  Map of boneName → SerializedQuaternion {x,y,z,w}
   */
  applyPoseState(pose: PoseState): void {
    for (const [boneName, q] of Object.entries(pose)) {
      const node = this.boneNodeMap.get(boneName as BoneName)
      if (!node) continue
      node.quaternion.set(q.x, q.y, q.z, q.w)
    }
  }

  /**
   * Extract the current rig rotation into a PoseState object suitable for
   * storing in Zustand. Called by GizmoController on pointerup.
   */
  extractPoseState(): PoseState {
    const pose: PoseState = {}
    for (const [boneName, node] of this.boneNodeMap) {
      const q = node.quaternion
      const entry: SerializedQuaternion = { x: q.x, y: q.y, z: q.z, w: q.w }
      pose[boneName] = entry
    }
    return pose
  }

  // --------------------------------------------------------------------------
  // World transform
  // --------------------------------------------------------------------------

  setWorldPosition(pos: { x: number; y: number; z: number }): void {
    this.group.position.set(pos.x, pos.y, pos.z)
  }

  setWorldRotation(radians: number): void {
    this.group.rotation.y = radians
  }

  // --------------------------------------------------------------------------
  // Visual state
  // --------------------------------------------------------------------------

  /**
   * Highlight the active character's joint spheres using the accent material.
   * Pass `true` when this character is selected, `false` otherwise.
   * Preserves the per-bone selected highlight set by `setSelectedBone`.
   */
  setActive(active: boolean): void {
    this._isActive = active
    // Re-apply all materials, respecting the per-bone selection state.
    this._refreshJointMaterials()
  }

  /**
   * Highlight a specific joint sphere as "selected" (bright yellow).
   * All other spheres use the character-level active/inactive material.
   * Pass `null` to clear the selection highlight.
   */
  setSelectedBone(boneName: string | null): void {
    this._selectedBone = boneName
    this._refreshJointMaterials()
  }

  /** Internal: re-assign materials to all joint spheres based on current state. */
  private _refreshJointMaterials(): void {
    for (const sphere of this.jointMeshes) {
      const name = sphere.userData.boneName as string
      if (name === this._selectedBone) {
        sphere.material = SELECTED_JOINT_MATERIAL
      } else {
        sphere.material = this._isActive ? ACTIVE_JOINT_MATERIAL : JOINT_MATERIAL
      }
    }
  }

  /**
   * Update outline thickness on all outline materials for this character.
   * Called when the ViewportPanel slider changes.
   */
  setOutlineThickness(thickness: number): void {
    for (const mat of this.outlineMaterials) {
      setOutlineThickness(mat, thickness)
    }
  }

  /**
   * Toggle layer visibility.
   * Phase 1–3: toggles the whole rig group visible flag for 'skin' layer;
   * other layers are no-ops until Phase 4 adds separate mesh objects.
   */
  setLayerVisibility(vis: LayerVisibility): void {
    this.group.visible = vis.skin || vis.muscle || vis.bone
  }

  /**
   * Apply morph weights (body type sliders).
   * Phase 1–3 stub — the placeholder rig doesn't have morph targets.
   * Phase 4 will drive `mesh.morphTargetInfluences[index] = value` here.
   */
  applyMorphWeights(_weights: MorphWeights): void {
    // TODO Phase 4: drive GLTF morph targets
  }

  // --------------------------------------------------------------------------
  // Gizmo query helpers
  // --------------------------------------------------------------------------

  /**
   * Get the Object3D node for a given bone name.
   * Returns undefined if the bone doesn't exist in this rig.
   */
  getBoneNode(boneName: BoneName): THREE.Object3D | undefined {
    return this.boneNodeMap.get(boneName)
  }

  /**
   * Get the IK chain Object3D array for a named chain.
   * Convenience wrapper used by GizmoController to build the solver input.
   * Returns null if any bone in the chain is missing.
   */
  getChainObjects(chainBones: BoneName[]): THREE.Object3D[] | null {
    const objects: THREE.Object3D[] = []
    for (const bone of chainBones) {
      const obj = this.boneNodeMap.get(bone)
      if (!obj) return null
      objects.push(obj)
    }
    return objects
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  /**
   * Remove this character's group from the scene and dispose GPU resources.
   */
  dispose(): void {
    this.scene.remove(this.group)
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose())
        } else {
          obj.material.dispose()
        }
      }
    })
    this.boneNodeMap.clear()
    this.jointMeshes.length = 0
    this.outlineMaterials.length = 0
  }
}
