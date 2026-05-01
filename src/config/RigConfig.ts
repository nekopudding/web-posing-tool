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
   * Show translation arrows (X/Y/Z) on the transform gizmo when this bone is selected.
   * Arrows trigger axis-constrained IK solve, so only useful when sphereDrag is 'ik'.
   */
  gizmoTranslate: boolean
}

export interface IKChainConfig {
  /** Unique identifier used by BoneConfig.chain to reference this chain. */
  name: string
  /**
   * Ordered list of bone names from root to end effector (tip).
   * FABRIK pins bones[0] and drives bones[last] toward the target.
   */
  bones: string[]
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
