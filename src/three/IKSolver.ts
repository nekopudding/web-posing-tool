/**
 * IKSolver.ts — FABRIK Inverse Kinematics solver.
 *
 * ============================================================================
 * THEORY: FABRIK (Forward And Backward Reaching Inverse Kinematics)
 * ============================================================================
 *
 * FABRIK is a geometric IK algorithm that works on a chain of joints connected
 * by rigid segments (bones of fixed length). It solves the chain so that the
 * tip (end effector) reaches a target position, while keeping bones connected
 * and respecting their lengths.
 *
 * Why FABRIK vs CCD (Cyclic Coordinate Descent)?
 *  - FABRIK is purely positional (vector arithmetic), no angle computation needed.
 *  - Converges faster in practice for short chains (2–4 bones).
 *  - Produces more natural-looking poses; CCD tends toward wrist flips.
 *
 * Why FABRIK vs analytical two-bone IK?
 *  - FABRIK generalizes to N bones — the same code handles arm (4 bones) and
 *    leg (3 bones) chains without special cases.
 *  - Analytical IK requires explicit elbow/knee angle derivation (law of cosines)
 *    and breaks at singularities (fully extended/compressed limb).
 *
 * ============================================================================
 * ALGORITHM
 * ============================================================================
 *
 * Input:
 *   joints[]    — world-space positions of N joints (J[0] = root, J[N-1] = tip)
 *   lengths[]   — bone lengths, where lengths[i] = distance between J[i] and J[i+1]
 *   target      — world-space position the tip should reach
 *
 * One iteration:
 *
 *   FORWARD PASS (tip → root):
 *     Move J[N-1] onto target.
 *     For i = N-2 down to 0:
 *       Direction d = normalize(J[i] - J[i+1])     ← point from new J[i+1] toward old J[i]
 *       J[i] = J[i+1] + d * lengths[i]              ← reposition J[i] at correct length from J[i+1]
 *     Now the tip is at the target, but the root has moved.
 *
 *   BACKWARD PASS (root → tip):
 *     Restore J[0] to its original world position (the root is pinned).
 *     For i = 1 to N-1:
 *       Direction d = normalize(J[i] - J[i-1])     ← point from new J[i-1] toward old J[i]
 *       J[i] = J[i-1] + d * lengths[i-1]           ← reposition J[i] at correct length from J[i-1]
 *     Now the root is pinned and the chain is reconnected, but the tip may have
 *     drifted slightly from the target.
 *
 * Repeat for `maxIterations` or until the tip is within `tolerance` of the target.
 * For short chains (≤ 4 bones), convergence typically happens in 2–5 iterations.
 *
 * ============================================================================
 * WORLD-SPACE → LOCAL QUATERNION CONVERSION
 * ============================================================================
 *
 * After FABRIK runs, we have updated world-space joint positions. We need to
 * convert those back into local bone rotations so Three.js can render the rig.
 *
 * For each bone i (connecting joint[i] to joint[i+1]):
 *   1. Compute the desired bone axis in world space:
 *        worldAxis = normalize(joint[i+1].position - joint[i].position)
 *   2. Compute the reference axis (the bone's "rest" direction in local space,
 *      typically +Y for bones that point upward in T-pose):
 *        restAxis = (0, 1, 0)
 *   3. The rotation that takes restAxis to worldAxis is:
 *        localQ = Quaternion.setFromUnitVectors(restAxis, worldAxis)
 *   4. If the bone has a parent, we need the rotation in parent-local space:
 *        parentWorldQ = parent.getWorldQuaternion()
 *        localQ = parentWorldQ.invert() * localQ
 *
 * This is implemented in `applyToObject3D`.
 */

import * as THREE from 'three'
import type { IKChainDef } from './IKChains'

// ---------------------------------------------------------------------------
// IKJoint — working state for one joint in a FABRIK solve
// ---------------------------------------------------------------------------

export interface IKJoint {
  /** Current world-space position. Mutated in place during the solve. */
  position: THREE.Vector3
  /** Bone name — used to look up the corresponding Three.js Object3D. */
  boneName: string
}

// Reusable temporaries — allocated once and reused across solve calls to
// avoid per-frame garbage collection pressure.
const _dir = new THREE.Vector3()
const _tip = new THREE.Vector3()

// ---------------------------------------------------------------------------
// IKSolver
// ---------------------------------------------------------------------------

export class IKSolver {
  /** Maximum solve iterations per frame. 10 converges well for ≤4-bone chains. */
  private maxIterations = 10
  /**
   * Distance tolerance (world units) — stop iterating when the tip is this
   * close to the target. 0.001 = 1 mm at 1 unit = 1 meter scale.
   */
  private tolerance = 0.001

  /**
   * Solve the IK chain so that `joints[last]` reaches `target`.
   *
   * @param joints      Array of IKJoint objects; positions are mutated in place.
   * @param target      Desired world-space position of the end effector.
   * @param boneLengths Array of lengths where boneLengths[i] = distance between
   *                    joints[i] and joints[i+1]. Length = joints.length - 1.
   * @returns true if the tip converged within `tolerance` of the target.
   */
  solve(joints: IKJoint[], target: THREE.Vector3, boneLengths: number[]): boolean {
    const n = joints.length
    if (n < 2) return true // Nothing to solve for a single joint.

    // Check reachability: if the target is farther than the total chain length,
    // stretch the chain straight toward the target (best we can do).
    const totalLength = boneLengths.reduce((a, b) => a + b, 0)
    const rootToTarget = joints[0].position.distanceTo(target)
    const isReachable = rootToTarget <= totalLength

    // Save the root position — it must be restored each backward pass.
    const rootPos = joints[0].position.clone()

    for (let iter = 0; iter < this.maxIterations; iter++) {
      // Check convergence: is the tip already close enough?
      const tipDist = joints[n - 1].position.distanceTo(target)
      if (tipDist < this.tolerance) return true

      // ---- FORWARD PASS: tip → root ----------------------------------------
      // Move the tip to the target first, then propagate up the chain.
      joints[n - 1].position.copy(target)

      for (let i = n - 2; i >= 0; i--) {
        // Direction from the new position of joints[i+1] toward the old joints[i].
        // We want joints[i] to remain `boneLengths[i]` away from joints[i+1].
        _dir.subVectors(joints[i].position, joints[i + 1].position)
        if (_dir.lengthSq() > 0) _dir.normalize()
        else _dir.set(0, 1, 0) // fallback direction if joints are coincident

        joints[i].position.copy(joints[i + 1].position).addScaledVector(_dir, boneLengths[i])
      }

      // ---- BACKWARD PASS: root → tip ----------------------------------------
      // Restore the root and propagate down the chain.
      joints[0].position.copy(isReachable ? rootPos : joints[0].position)

      // When the target is unreachable, align the whole chain toward the target.
      if (!isReachable) {
        _dir.subVectors(target, joints[0].position)
        if (_dir.lengthSq() > 0) _dir.normalize()
        else _dir.set(0, -1, 0)
        for (let i = 1; i < n; i++) {
          joints[i].position.copy(joints[i - 1].position).addScaledVector(_dir, boneLengths[i - 1])
        }
        return false // Can't converge if unreachable
      }

      joints[0].position.copy(rootPos) // re-pin root

      for (let i = 1; i < n; i++) {
        // Direction from new joints[i-1] toward the old joints[i].
        _dir.subVectors(joints[i].position, joints[i - 1].position)
        if (_dir.lengthSq() > 0) _dir.normalize()
        else _dir.set(0, -1, 0)

        joints[i].position.copy(joints[i - 1].position).addScaledVector(_dir, boneLengths[i - 1])
      }
    }

    return joints[n - 1].position.distanceTo(target) < this.tolerance
  }

  /**
   * Build an IKJoint array by extracting current world positions from
   * a list of Three.js Object3D nodes.
   *
   * Call this once at the start of a drag to snapshot the chain state.
   *
   * @param objects  Ordered list of Object3D nodes (root → effector).
   * @param boneNames Matching bone names for each object (same order).
   */
  extractJoints(objects: THREE.Object3D[], boneNames: string[]): IKJoint[] {
    return objects.map((obj, i) => ({
      position: obj.getWorldPosition(new THREE.Vector3()),
      boneName: boneNames[i],
    }))
  }

  /**
   * Apply solved joint world positions back to Three.js Object3D nodes as
   * local rotations.
   *
   * ---- Conversion: world positions → local quaternions ----
   *
   * For each bone segment (between joints[i] and joints[i+1]):
   *   1. Compute worldAxis = normalize(joint[i+1] - joint[i])
   *      This is the direction the bone should point in world space after the solve.
   *   2. The bone's rest axis in its own local space is +Y (convention: bones
   *      are modeled pointing up along their local Y axis in the placeholder rig).
   *   3. Compute a quaternion that rotates +Y onto worldAxis:
   *        q_world = Quaternion.setFromUnitVectors(UP, worldAxis)
   *   4. Convert to parent-local space by applying the inverse of the parent's
   *      world quaternion:
   *        q_local = inverse(parent_world_q) * q_world
   *   5. Assign q_local to the bone's .quaternion, then call updateMatrixWorld
   *      so subsequent bones see the updated transforms.
   *
   * Note: we update `objects[i]`, not `objects[i+1]`, because Object3D[i]
   * is the *parent* pivot that controls the direction of the bone segment
   * extending from joint[i] to joint[i+1].
   *
   * @param joints  Solved IKJoint positions (output of `solve`).
   * @param objects Ordered Three.js Object3D array matching the joints.
   */
  applyToObjects(joints: IKJoint[], objects: THREE.Object3D[]): void {
    const n = joints.length

    // Temp quaternions — reused across iterations
    const worldQ = new THREE.Quaternion()
    const parentWorldQ = new THREE.Quaternion()
    const invParentWorldQ = new THREE.Quaternion()
    const localQ = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0) // bones point along +Y in rest pose

    for (let i = 0; i < n - 1; i++) {
      const boneObj = objects[i]

      // Direction this bone segment should point in world space
      _tip.subVectors(joints[i + 1].position, joints[i].position)
      if (_tip.lengthSq() === 0) continue // degenerate: skip
      _tip.normalize()

      // World-space quaternion: rotate +Y to point in `_tip` direction
      worldQ.setFromUnitVectors(up, _tip)

      // Convert to local space: local = inverse(parentWorld) * world
      if (boneObj.parent) {
        boneObj.parent.getWorldQuaternion(parentWorldQ)
        invParentWorldQ.copy(parentWorldQ).invert()
        localQ.multiplyQuaternions(invParentWorldQ, worldQ)
      } else {
        localQ.copy(worldQ)
      }

      boneObj.quaternion.copy(localQ)
      // Force the matrix to update immediately so the next bone in the
      // chain reads the correct parent transform.
      boneObj.updateMatrixWorld(true)
    }
  }

  /**
   * Compute bone lengths from an array of Object3D world positions.
   * Used to build the boneLengths array from the current rig state at drag-start,
   * ensuring the solver preserves the actual lengths of the rig in use.
   */
  computeBoneLengths(objects: THREE.Object3D[]): number[] {
    const lengths: number[] = []
    const posA = new THREE.Vector3()
    const posB = new THREE.Vector3()
    for (let i = 0; i < objects.length - 1; i++) {
      objects[i].getWorldPosition(posA)
      objects[i + 1].getWorldPosition(posB)
      lengths.push(posA.distanceTo(posB))
    }
    return lengths
  }

  /**
   * Build IK chains mapped to Three.js objects from a bone name → Object3D map.
   * Returns null if any bone in the chain is missing from the map (warns to console).
   */
  buildChainObjects(
    chainDef: IKChainDef,
    boneMap: Map<string, THREE.Object3D>
  ): THREE.Object3D[] | null {
    const objects: THREE.Object3D[] = []
    for (const boneName of chainDef.bones) {
      const obj = boneMap.get(boneName)
      if (!obj) {
        console.warn(`[IKSolver] Bone "${boneName}" not found in rig — chain "${chainDef.name}" disabled.`)
        return null
      }
      objects.push(obj)
    }
    return objects
  }
}
