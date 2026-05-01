/**
 * IKChains.ts — Canonical bone name registry and IK chain definitions.
 *
 * This file is intentionally free of Three.js imports so it can be safely
 * imported by both the Zustand store (which must not import Three.js) and
 * by IKSolver / CharacterManager. Importing Three.js here would create
 * a circular dependency risk and also bloat the store bundle.
 *
 * Bone naming convention (matches Blender Rigify custom names for Phase 4):
 *   - Suffix ".L" = character's left side (screen right in front view)
 *   - Suffix ".R" = character's right side (screen left in front view)
 *   - No suffix = center-line bones
 *
 * Hierarchy:
 *   root
 *   └── hips
 *       ├── spine
 *       │   └── chest
 *       │       ├── neck
 *       │       │   └── head
 *       │       ├── shoulder.L / shoulder.R
 *       │           └── upper_arm.L / upper_arm.R
 *       │               └── forearm.L / forearm.R
 *       │                   └── hand.L / hand.R   ← IK end effector
 *       └── upper_leg.L / upper_leg.R
 *           └── lower_leg.L / lower_leg.R
 *               └── foot.L / foot.R              ← IK end effector
 *                   └── toe.L / toe.R
 *
 * IK chains and per-bone capabilities are defined in src/config/rig-config.json.
 * Edit that file to change which bones have IK, rotation gizmos, or translation gizmos.
 */

import rigConfigJson from '../config/rig-config.json'
import type { RigConfig } from '../config/RigConfig'

/** Typed reference to the loaded rig config. Used by GizmoController and ViewportCanvas. */
export const RIG_CONFIG: RigConfig = rigConfigJson as RigConfig

// ---------------------------------------------------------------------------
// Bone name registry
// ---------------------------------------------------------------------------

/**
 * All valid bone names in the rig.
 * Used to initialize PoseState with identity quaternions for every bone.
 * `as const` preserves the literal types so BoneName is a union, not `string`.
 */
export const BONE_NAMES = [
  'root',
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulder.L',
  'upper_arm.L',
  'forearm.L',
  'hand.L',
  'shoulder.R',
  'upper_arm.R',
  'forearm.R',
  'hand.R',
  'upper_leg.L',
  'lower_leg.L',
  'foot.L',
  'toe.L',
  'upper_leg.R',
  'lower_leg.R',
  'foot.R',
  'toe.R',
] as const

/** Union type of all valid bone name strings. */
export type BoneName = (typeof BONE_NAMES)[number]

// ---------------------------------------------------------------------------
// IK chain definitions
// ---------------------------------------------------------------------------

export interface IKChainDef {
  /** Human-readable chain identifier (e.g. "arm.L"). */
  name: string
  /**
   * Ordered list of bones from root to end effector (tip).
   * The FABRIK solver iterates this list in both directions.
   * bones[0] is treated as the chain root (pinned during backward pass).
   * bones[bones.length - 1] is the end effector (the draggable gizmo).
   */
  bones: BoneName[]
}

/**
 * IK chains derived from rig-config.json.
 * Previously hardcoded — now driven by the config file for easy extensibility.
 */
export const IK_CHAINS: IKChainDef[] = RIG_CONFIG.ikChains.map((c) => ({
  name: c.name,
  bones: c.bones as BoneName[],
}))

/**
 * Returns the IK chain that contains a given bone as its end effector,
 * or undefined if the bone is not an IK effector.
 * Used by GizmoController to determine which chain to solve when a joint is dragged.
 */
export function findChainForEffector(boneName: BoneName): IKChainDef | undefined {
  return IK_CHAINS.find(
    (chain) => chain.bones[chain.bones.length - 1] === boneName
  )
}

/**
 * Returns the IK chain with the given name, or undefined.
 * Used by GizmoController when looking up a chain from a BoneConfig.chain reference.
 */
export function findChainByName(name: string): IKChainDef | undefined {
  return IK_CHAINS.find((chain) => chain.name === name)
}

// ---------------------------------------------------------------------------
// Default bone lengths for the placeholder rig (world units)
// ---------------------------------------------------------------------------

/**
 * Approximate bone lengths used to build the box placeholder rig.
 * These are measured in Three.js world units where 1 unit ≈ 1 meter.
 * Bones not listed here (like 'root') have no visible segment — they're
 * just pivot points in the hierarchy.
 *
 * Phase 4: when a real GLTF model is loaded, bone lengths are derived from
 * the actual vertex positions in the mesh instead.
 */
export const BONE_LENGTHS: Partial<Record<BoneName, number>> = {
  spine:       0.30,
  chest:       0.30,
  neck:        0.12,
  head:        0.25,
  'shoulder.L':    0.15,
  'upper_arm.L':   0.28,
  'forearm.L':     0.25,
  'hand.L':        0.12,
  'shoulder.R':    0.15,
  'upper_arm.R':   0.28,
  'forearm.R':     0.25,
  'hand.R':        0.12,
  'upper_leg.L':   0.42,
  'lower_leg.L':   0.38,
  'foot.L':        0.18,
  'toe.L':         0.08,
  'upper_leg.R':   0.42,
  'lower_leg.R':   0.38,
  'foot.R':        0.18,
  'toe.R':         0.08,
}
