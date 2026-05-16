/**
 * RigConfig.ts — TypeScript type definitions for rig-config.json.
 *
 * The JSON file is the single source of truth for:
 *   - IK chain definitions (which bones form which chain)
 *   - Per-bone interaction capabilities (sphere drag, gizmo rings, gizmo arrows)
 *
 * To add a new IK effector or change gizmo behavior, edit rig-config.json only.
 * No TypeScript changes needed.
 */

/** What happens when the user drags a bone's sphere directly in the viewport. */
export type SphereDragMode =
  /** FABRIK IK on the named chain; this bone is the end effector (tip). */
  | 'ik'
  /**
   * FABRIK on a sub-chain from the chain root up to (and including) this bone.
   * The dragged bone becomes the IK target; its children's world orientation is preserved.
   * Used for elbow/knee posing.
   */
  | 'ik-inner'
  /** Translate the whole character in world space (worldPosition). Used for hips. */
  | 'translate'

export interface BoneConfig {
  /**
   * Sphere-drag behavior when the user drags this bone's sphere.
   * Absent or undefined = click-only (no drag pose change from sphere drag).
   */
  sphereDrag?: SphereDragMode

  /**
   * IK chain name. Required when sphereDrag is 'ik' or 'ik-inner'.
   * Must match a name in the top-level `ikChains` array.
   */
  chain?: string

  /**
   * Foot-lock flag for cascading full-body IK.
   * When true: after this bone's IK solve potentially moves the spine/hips,
   * re-solve both leg chains to pin feet at their pre-drag world positions.
   * Only relevant for upper-body IK bones (hands, chest).
   */
  footLock?: boolean

  /**
   * Show rotation rings (X/Y/Z) on the transform gizmo when this bone is selected.
   * Set false for pure-IK tips where FK rotation is unhelpful (e.g. head).
   */
  gizmoRotate: boolean

  /**
   * Single-axis rotation constraint for the gizmo.
   * When set, only the ring for this axis is shown (instead of all three).
   * The axis is expressed in the parent bone's local space.
   * Use for anatomically constrained joints like elbows and knees.
   */
  rotateConstraintAxis?: 'x' | 'y' | 'z'

  /**
   * Show translation arrows (X/Y/Z) on the transform gizmo when this bone is selected.
   * Arrows trigger axis-constrained IK solve, so only useful when sphereDrag is 'ik'.
   */
  gizmoTranslate: boolean
}

/**
 * Angle constraint for a hinge joint in an IK chain.
 * Applied after each FABRIK backward pass to prevent hyperextension.
 *
 * `jointIndex` refers to the constrained joint's index in the chain's bones array.
 *
 * Angle convention (signed, via atan2):
 *   0°            = joint is straight (hyperextension boundary)
 *   positive      = joint bending in the valid direction
 *   negative      = hyperextension (joint bending the wrong way) — always clamped out
 *   maxAngleDeg   = maximum allowed bend (e.g. 170° prevents over-folding)
 */
export interface JointConstraint {
  type: 'hinge'
  /** Index of the constrained joint within the chain's bones array (1-based interior only). */
  jointIndex: number
  /** Maximum allowed bend angle in degrees. 0° is straight; negative angles are hyperextension. */
  maxAngleDeg: number
}

export interface IKChainConfig {
  /** Unique identifier used by BoneConfig.chain to reference this chain. */
  name: string
  /**
   * Ordered list of bone names from root to end effector (tip).
   * FABRIK pins bones[0] and drives bones[last] toward the target.
   */
  bones: string[]
  /**
   * Optional per-joint angle constraints for this chain.
   * Applied inside the FABRIK loop after each backward pass.
   */
  constraints?: JointConstraint[]
}

export interface RigConfig {
  /** Schema version — increment when the JSON structure changes. */
  version: string
  /** All IK chains available in this rig. */
  ikChains: IKChainConfig[]
  /**
   * Per-bone capabilities map.
   * Keys are bone names (matching BONE_NAMES in IKChains.ts).
   * Bones absent from this map: click selects them but no gizmo is shown.
   */
  bones: Record<string, BoneConfig>
}
