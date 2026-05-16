/**
 * ConstraintSystem.ts — Joint angle constraints for the FABRIK IK solver.
 *
 * Prevents elbows and knees from hyperextending by clamping the bend angle
 * at hinge joints after each FABRIK backward pass.
 *
 * ============================================================================
 * ALGORITHM: SIGNED-ANGLE HINGE CONSTRAINT
 * ============================================================================
 *
 * Input per constrained joint at index i:
 *   inVec  = normalize(joints[i]   - joints[i-1])   // incoming bone direction
 *   outVec = normalize(joints[i+1] - joints[i])     // outgoing bone direction
 *   hingeNormal = bend-plane normal captured once at drag start
 *
 * 1. Project outVec into the hinge plane to eliminate numeric drift:
 *      outInPlane = normalize(outVec - dot(outVec, hingeNormal) * hingeNormal)
 *
 * 2. Compute a reference bend direction in the plane (perpendicular to inVec):
 *      perpBend = normalize(hingeNormal × inVec)
 *    A positive perpBend component in outInPlane means the joint is bending
 *    in the anatomically valid direction.
 *
 * 3. Signed angle via atan2 — positive = valid bend, negative = hyperextension:
 *      signedAngle = atan2(dot(perpBend, outInPlane), dot(inVec, outInPlane))
 *
 * 4. Clamp to [0, maxAngleDeg]:
 *    - signedAngle < 0 → hyperextension → clamped to 0 (straight)
 *    - signedAngle > maxAngleDeg → over-folded → clamped to maxAngleDeg
 *    - in range → no correction needed
 *
 * 5. Reconstruct outVec from the clamped angle using inVec + perpBend as a 2D basis:
 *      newOutVec = inVec * cos(clampedAngle) + perpBend * sin(clampedAngle)
 *      joints[i+1].position = joints[i].position + newOutVec * boneLengths[i]
 *
 * The next FABRIK forward pass restores bone lengths, so no manual re-cascade needed.
 *
 * ============================================================================
 * HINGE PLANE TRACKING
 * ============================================================================
 *
 * Captured once at drag start from the three-point angle at the hinge joint.
 * Persists for the entire drag so the elbow/knee doesn't flip bend planes when
 * the limb passes through a nearly-straight (degenerate cross-product) pose.
 * Camera-right is used as a fallback when the cross product is too small.
 */

import * as THREE from 'three'
import type { IKJoint } from './IKSolver'
import type { JointConstraint, RigConfig } from '../config/RigConfig'

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const DEG2RAD = Math.PI / 180

// Reusable module-level temps — allocated once, never per-frame.
const _inVec = new THREE.Vector3()
const _outVec = new THREE.Vector3()
const _outInPlane = new THREE.Vector3()
const _perpBend = new THREE.Vector3()
const _newOut = new THREE.Vector3()

// --------------------------------------------------------------------------
// ConstraintSystem
// --------------------------------------------------------------------------

export class ConstraintSystem {
  /**
   * Per-chain hinge constraints, keyed by chain name (e.g. "arm.L").
   * Built from rig-config.json at construction time.
   */
  private chainConstraints: Map<string, JointConstraint[]> = new Map()

  /**
   * Hinge-plane normals captured at drag start (per chain).
   * Cleared automatically when clearHingePlane() is called on drag end.
   * Persist across FABRIK iterations within the same drag so the elbow/knee
   * doesn't flip planes during a solve.
   */
  private hingePlanes: Map<string, THREE.Vector3> = new Map()

  constructor(config: RigConfig) {
    for (const chain of config.ikChains) {
      if (chain.constraints && chain.constraints.length > 0) {
        this.chainConstraints.set(chain.name, chain.constraints)
      }
    }
  }

  // --------------------------------------------------------------------------
  // Hinge plane capture
  // --------------------------------------------------------------------------

  /**
   * Capture the current bend-plane normal for a chain at drag start.
   * The normal is used as the rotation axis for angle clamping throughout
   * the drag, preventing elbows/knees from flipping planes when the chain
   * passes through a fully-extended (degenerate) configuration.
   *
   * @param chainName  IK chain name (e.g. "arm.L").
   * @param joints     Joint positions at drag start (world space).
   * @param camera     Active camera — used as fallback when chain is nearly straight.
   */
  captureHingePlane(chainName: string, joints: IKJoint[], camera: THREE.Camera): void {
    const constraints = this.chainConstraints.get(chainName)
    if (!constraints) return

    for (const constraint of constraints) {
      if (constraint.type !== 'hinge') continue
      const i = constraint.jointIndex
      if (i < 1 || i >= joints.length - 1) continue

      _inVec.subVectors(joints[i].position, joints[i - 1].position)
      if (_inVec.lengthSq() < 1e-10) continue
      _inVec.normalize()

      _outVec.subVectors(joints[i + 1].position, joints[i].position)
      if (_outVec.lengthSq() < 1e-10) continue
      _outVec.normalize()

      const normal = new THREE.Vector3().crossVectors(_inVec, _outVec)

      if (normal.lengthSq() < 1e-8) {
        // Chain is nearly straight — cross product is degenerate.
        // Use camera right (world space) as the bend plane normal.
        const camDir = new THREE.Vector3()
        camera.getWorldDirection(camDir)
        normal.crossVectors(camDir, _inVec)
        if (normal.lengthSq() < 1e-8) {
          normal.set(1, 0, 0) // ultimate fallback
        }
      }

      this.hingePlanes.set(chainName, normal.normalize())
      break // Only one hinge constraint per chain supported.
    }
  }

  /** Clear the stored hinge plane for a chain (called on drag end). */
  clearHingePlane(chainName: string): void {
    this.hingePlanes.delete(chainName)
  }

  // --------------------------------------------------------------------------
  // Angle constraint (called as onAfterBackwardPass callback in IKSolver.solve)
  // --------------------------------------------------------------------------

  /**
   * Clamp the angle at each constrained hinge joint using a signed-angle approach.
   * Called after each FABRIK backward pass.
   *
   * Made public so GizmoController can create a bound reference once at drag start
   * and pass it to IKSolver.solve as the onAfterBackwardPass callback.
   */
  applyHingeConstraints(joints: IKJoint[], boneLengths: number[], chainName: string): void {
    const constraints = this.chainConstraints.get(chainName)
    if (!constraints) return

    const hingeNormal = this.hingePlanes.get(chainName)
    if (!hingeNormal) return // No plane captured → skip constraint this frame.

    for (const constraint of constraints) {
      if (constraint.type !== 'hinge') continue
      const i = constraint.jointIndex
      // i must be an interior joint (has both a predecessor and a successor).
      if (i < 1 || i >= joints.length - 1) continue

      const prev = joints[i - 1].position
      const hinge = joints[i].position
      const next = joints[i + 1].position

      _inVec.subVectors(hinge, prev)
      if (_inVec.lengthSq() < 1e-10) continue
      _inVec.normalize()

      _outVec.subVectors(next, hinge)
      if (_outVec.lengthSq() < 1e-10) continue
      _outVec.normalize()

      // Project outVec into the hinge plane to remove out-of-plane numeric drift.
      // outInPlane = outVec - dot(outVec, hingeNormal) * hingeNormal
      _outInPlane.copy(_outVec).addScaledVector(hingeNormal, -_outVec.dot(hingeNormal))
      if (_outInPlane.lengthSq() < 1e-6) continue // outVec nearly parallel to hingeNormal — skip
      _outInPlane.normalize()

      // perpBend = direction of valid anatomical bend (perpendicular to inVec in hinge plane).
      // positive perpBend component in outInPlane → joint is bending the right way.
      _perpBend.crossVectors(hingeNormal, _inVec)
      if (_perpBend.lengthSq() < 1e-10) continue
      _perpBend.normalize()

      // Signed angle: positive = valid bend, negative = hyperextension.
      const cosA = Math.max(-1, Math.min(1, _inVec.dot(_outInPlane)))
      const sinA = _perpBend.dot(_outInPlane)
      const signedAngle = Math.atan2(sinA, cosA)

      const maxRad = constraint.maxAngleDeg * DEG2RAD
      const clampedAngle = Math.max(0, Math.min(maxRad, signedAngle))

      // Skip if no correction needed (fast path).
      if (Math.abs(signedAngle - clampedAngle) < 1e-5) continue

      // Reconstruct newOutVec from the clamped angle using inVec + perpBend as 2D basis.
      _newOut.copy(_inVec).multiplyScalar(Math.cos(clampedAngle))
        .addScaledVector(_perpBend, Math.sin(clampedAngle))

      // Reposition joints[i+1] along the corrected direction.
      // boneLengths[i] = distance between joints[i] and joints[i+1].
      joints[i + 1].position.copy(hinge).addScaledVector(_newOut, boneLengths[i])
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  dispose(): void {
    this.hingePlanes.clear()
  }
}
