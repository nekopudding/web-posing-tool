# IK / FK Internals — Deep Reference

This document is a complete technical reference for how posing works in this tool:
the data flow, the math behind each operation, the known bugs and their root causes,
and a survey of external libraries (spoiler: all are unmaintained — stick with custom FABRIK).

---

## Table of Contents

1. [Architecture overview — data flow](#1-architecture-overview--data-flow)
2. [FK posing (rotation rings)](#2-fk-posing-rotation-rings)
3. [IK posing — FABRIK algorithm](#3-ik-posing--fabrik-algorithm)
4. [World-position → local quaternion conversion (applyToObjects)](#4-world-position--local-quaternion-conversion-applytoobjects)
5. [Rest-pose delta system (FBX support)](#5-rest-pose-delta-system-fbx-support)
6. [Drag modes — what happens on each pointer event](#6-drag-modes--what-happens-on-each-pointer-event)
7. [Full-body cascade IK](#7-full-body-cascade-ik)
8. [Known bugs and root causes](#8-known-bugs-and-root-causes)
9. [External IK library landscape](#9-external-ik-library-landscape)
10. [Recommended fixes](#10-recommended-fixes)

---

## 1. Architecture overview — data flow

```
User drags joint sphere
        │
        ▼
GizmoController._onPointerDown / _onPointerMove
  - raycasts against jointMeshes (sphere gizmos)
  - reads bone config from RIG_CONFIG (rig-config.json)
  - builds DragState
        │
        ▼ (every frame, via SceneManager.addBeforeRenderCallback)
GizmoController.update()
  - calls appropriate _update*Drag() method
  - runs IKSolver.solve() (for IK modes)
  - runs IKSolver.applyToObjects() → writes quaternions onto THREE.Object3D nodes
  - Three.js re-renders with updated bone transforms
        │
        ▼ (on pointerup only)
charMgr.extractPoseState()
  - reads bone.quaternion from every node in boneNodeMap
  - converts to rest-pose deltas (restQ⁻¹ × boneQ)
  - returns plain { boneName: {x,y,z,w} } object
        │
        ▼
useSceneStore.setPose(characterId, pose)
  - Zustand store write (triggers subscriptions)
        │
        ▼
ViewportCanvas subscription → charMgr.applyPoseState(pose)
  - converts store deltas back to absolute quaternions (restQ × storeQ)
  - writes onto bone nodes (redundant after a drag, because bones are
    already in the right state, but important for undo/redo replay)
```

**Key invariant:** Three.js objects are the source of truth *during* a drag.
The Zustand store is only written on `pointerup`. React never touches Three.js
at 60fps — all hot-path code goes through direct Object3D manipulation.

---

## 2. FK posing (rotation rings)

**File:** `GizmoController._updateRotateDrag()`

When the user drags a rotation ring on the transform gizmo:

### Inputs captured at drag start
- `rotAxis` — world-space unit axis (X, Y, or Z depending on which ring)
- `rotPlane` — `THREE.Plane` with `normal = rotAxis`, passing through the joint's world position
- `rotStartDir` — direction from joint center to the first ray-plane intersection, projected onto the rotation plane
- `rotBaseQuat` — snapshot of `boneNode.quaternion` at drag start

### Each frame
1. Intersect camera ray with `rotPlane` → `currentHit`
2. Compute `currentDir = normalize(currentHit - jointCenter)`, projected onto the plane (remove component along `rotAxis`)
3. Compute signed angle:
   ```
   cross = rotStartDir × currentDir
   sinAngle = cross · rotAxis        (positive = rotation in axis direction)
   cosAngle = rotStartDir · currentDir
   angle = atan2(sinAngle, cosAngle)
   ```
4. Build world-space rotation delta: `qWorld = Quaternion.setFromAxisAngle(rotAxis, angle)`
5. Convert to bone-local space:
   ```
   parentWorldQ = boneNode.parent.getWorldQuaternion()
   pInv = parentWorldQ.inverse()
   localDelta = pInv * qWorld * parentWorldQ
   ```
6. Apply from base (NOT incremental — avoids float drift):
   ```
   boneNode.quaternion = localDelta * rotBaseQuat
   ```

### Why "from base" matters
If you apply incremental deltas each frame (`q *= smallDelta`), floating-point rounding
accumulates over hundreds of frames. By always computing from the base quaternion captured
at drag start, the pose is mathematically identical regardless of how many frames the
drag spans.

---

## 3. IK posing — FABRIK algorithm

**Files:** `IKSolver.ts`, `GizmoController._updateIKFreeDrag()`

### What FABRIK solves

Given:
- A chain of N joints connected by rigid segments (fixed bone lengths)
- A target world position for the last joint (end effector)

Find: joint positions such that the end effector is at the target and all bone lengths are preserved.

### Algorithm (one iteration)

```
FORWARD PASS — tip → root:
  joints[N-1].position = target               // snap tip to target
  for i = N-2 downto 0:
    dir = normalize(joints[i].pos - joints[i+1].pos)   // toward old position
    joints[i].pos = joints[i+1].pos + dir * boneLengths[i]

BACKWARD PASS — root → tip:
  joints[0].position = rootPos    // restore pinned root
  for i = 1 to N-1:
    dir = normalize(joints[i].pos - joints[i-1].pos)   // away from root
    joints[i].pos = joints[i-1].pos + dir * boneLengths[i-1]
```

Repeat until `|joints[N-1] - target| < tolerance` (typically 2–5 iterations for ≤4-bone chains).

### Reachability check
If `|target - root| > totalChainLength`, the target is unreachable.
The chain stretches straight toward the target (best possible result).
`solve()` returns `false` in this case.

### Per-frame execution during drag

```
_updateIKFreeDrag():
  1. raycast camera ray against dragPlane → 3D target position
  2. Refresh ds.joints[] from actual Object3D world positions
     (critical: previous-frame cascade may have moved the shoulder)
  3. Check armReachable = (distance from chain root to target) <= totalChainLength
  4. If reachable:
       solver.solve(joints, target, boneLengths)
       solver.applyToObjects(joints, objects)
  5. If not reachable AND footLock is configured:
       _solveFullBodyCascade()
```

---

## 4. World-position → local quaternion conversion (applyToObjects)

**File:** `IKSolver.applyToObjects()`

After FABRIK runs, `joints[i].position` holds the desired world-space position of each
joint. We must convert this back to local quaternions on each `THREE.Object3D` bone node.

### Per-bone procedure (for bone `i`, connecting `joints[i]` to `joints[i+1]`)

```
Step 1 — desired world-space bone direction:
  _tip = normalize(joints[i+1].position - joints[i].position)

Step 2 — rest direction (constant; the direction from boneObj's pivot to childObj's
         pivot in boneObj's LOCAL parent space, at rest):
  restDir = normalize(setFromMatrixPosition(childObj.matrix))
  // childObj.matrix translation component = childObj.position = constant bone offset
  // This does NOT change when the bone is rotated; it's always the rest direction.

Step 3 — convert desired world direction to parent-local space:
  parentWorldQ = boneObj.parent.getWorldQuaternion()
  invParentWorldQ = parentWorldQ.inverse()
  localAxis = normalize(_tip rotated by invParentWorldQ)
  // localAxis = desired bone direction expressed in parent-local space

Step 4 — compute swing delta to go from current direction to desired direction:
  currentDir = normalize(restDir rotated by boneObj.quaternion)
  // currentDir = where the bone currently points in parent-local space
  swingQ = Quaternion.setFromUnitVectors(currentDir, localAxis)
  boneObj.quaternion = swingQ * boneObj.quaternion
  // This rotates the current bone direction onto the desired direction
  // while PRESERVING any existing twist rotation in the bone.

Step 5 — update matrices immediately so the next bone in the chain sees the result:
  boneObj.updateMatrix()
  boneObj.updateMatrixWorld(true)
```

### Why swing-delta instead of setFromUnitVectors directly?

`setFromUnitVectors(restDir, localAxis)` gives the *minimal* rotation from the rest
pose to the target direction. For the placeholder rig (identity rest poses) this is fine.
For Mixamo GLB bones that have non-identity rest rotations baked in, replacing the full
quaternion would discard the rest twist, producing visually wrong elbow/knee orientations.

The swing-delta approach (`swingQ * currentQ`) only changes the SWING component (the
rotation that points the bone toward the target) while keeping the existing TWIST component.

### Mathematical correctness proof

We want `newQ.apply(restDir) = localAxis` in parent-local space.
```
newQ = swingQ * oldQ
newQ.apply(restDir) = (swingQ * oldQ).apply(restDir)
                    = swingQ.apply(oldQ.apply(restDir))
                    = swingQ.apply(currentDir)    // currentDir = oldQ.apply(restDir)
                    = localAxis                    // swingQ = fromUnitVectors(currentDir, localAxis)
```
QED. The formula is mathematically correct.

---

## 5. Rest-pose delta system

**Files:** `CharacterManager._restPose`, `applyPoseState()`, `extractPoseState()`

### Why rest-pose deltas exist

Mixamo GLB bones have non-identity T-pose quaternions baked in by the Blender exporter.
If the Zustand store held ABSOLUTE quaternions, the serialized pose values would be
model-specific and non-transferable. By storing DELTAS relative to each bone's rest pose,
poses can in principle be applied across different rigs (same delta = same pose change).

### Capture (at GLB load time)
```
for each bone in boneNodeMap:
  _restPose[boneName] = bone.quaternion.clone()
  // GLTFLoader gives correct quaternion directly — no decompose() needed
```

### Apply (store → Three.js)
```
applyPoseState(storeQ):
  for each bone:
    restQ = _restPose[boneName]
    bone.quaternion = restQ * storeQ[boneName]
    // result = T-pose orientation + pose delta on top
```

### Extract (Three.js → store, on pointerup)
```
extractPoseState():
  for each bone:
    restQ = _restPose[boneName]
    storeQ = restQ.inverse() * bone.quaternion
    // storeQ is the delta relative to T-pose
```

### Important: IKSolver bypasses applyPoseState

During drag, `IKSolver.applyToObjects()` writes directly to `bone.quaternion`.
It does NOT use the rest-pose system. This means:
- The Three.js bone.quaternion during drag = ABSOLUTE (rest + delta combined)
- `extractPoseState()` on pointerup correctly extracts the delta by dividing out restQ

This is intentional — computing rest-pose deltas on every solve frame would be
unnecessary computation when the store isn't being written.

---

## 6. Drag modes — what happens on each pointer event

```
pointerdown:
  1. Raycast transform gizmo handles (higher priority)
     → if hit: _startGizmoDrag() for rotate-x/y/z or translate-x/y/z
  2. Raycast joint spheres
     → read boneConfig.sphereDrag from rig-config.json
     → 'ik':        _startIKFreeDrag()    (hand, foot, head, chest)
     → 'ik-inner':  _startIKInnerDrag()   (forearm/elbow, lower_leg/knee)
     → 'translate': _startWorldTranslateDrag()  (hips)
  3. setPointerCapture so drag continues outside canvas
  4. controls.enabled = false (disable OrbitControls while dragging)

pointermove:
  → update this.ndc (normalized device coordinates)
  → update() runs each frame from SceneManager callback (not from here)

pointerup:
  → if moved < CLICK_THRESHOLD: treat as click (bone already selected on down)
  → if moved >= CLICK_THRESHOLD:
      store.pushHistory()
      if world-translate: store.setWorldPosition()
      else: store.setPose(charMgr.extractPoseState())
  → controls.enabled = true
  → dragState = null
```

### IK-inner drag (elbow/knee)

This is a special mode for dragging an intermediate joint (not the end effector).
The goal: move the elbow/knee without changing where the hand/foot points.

```
Snapshot: savedDraggedWorldQ = forearm.L.getWorldQuaternion()

Each frame:
  1. FABRIK solve on sub-chain [shoulder.L, upper_arm.L, forearm.L]
     (the sub-chain ends at the dragged bone, not the hand)
  2. applyToObjects → writes shoulder.L and upper_arm.L rotations
  3. Restore forearm.L's world orientation:
     newLocalQ = parentWorldQ.inverse() * savedDraggedWorldQ
     forearm.L.quaternion = newLocalQ
```

This keeps the wrist/hand orientation constant while the elbow moves.

---

## 7. Full-body cascade IK

**File:** `GizmoController._solveFullBodyCascade()`

When a hand is dragged beyond the arm's maximum reach, a full-body solve is triggered
if `footLock: true` is set for that bone in rig-config.json.

### What it does

1. Solve a LONGER chain that includes the spine:
   ```
   hand.L: [hips, spine, spine_upper, chest, shoulder.L, upper_arm.L, forearm.L, hand.L]
   ```
   This bends the whole torso toward the target.

2. Re-pin both feet by re-solving each leg chain toward the saved foot positions:
   ```
   leg.L chain → solve toward savedFootPosL (captured at drag start)
   leg.R chain → solve toward savedFootPosR
   ```

### When the cascade activates
- `armReachable == false` (target is farther than arm's total length from shoulder)
- `savedFootPosL` and `savedFootPosR` are both set (footLock was true for this bone)

### Known instability

See §8 for the full analysis of why this currently oscillates.

---

## 8. Known bugs and root causes

### Bug 1: IK oscillation on full-body cascade (ACTIVE BUG)

**Symptom:** When dragging a hand beyond reach, the arm/spine bounces between two poses
each frame instead of settling.

**Root cause — stale joint refresh:**

On each frame, `ds.joints[]` (the arm chain) is refreshed from actual Object3D world
positions. This ensures the root (shoulder) reflects any cascade movement from the
previous frame. However, the CASCADE also calls `applyToObjects` on the FULL chain
(including the arm bones). After the cascade, the arm bones have rotations set by the
8-bone solve (hips→hand), which may conflict with what FABRIK computed for the
4-bone arm sub-chain alone.

The tension: frame N cascades the arm to position A. Frame N+1 reads world positions
reflecting A, re-runs cascade, produces position B. Frame N+2 reads B, produces A
again. Alternating.

**Root cause — skipping primary solve vs. running it:**

When `!armReachable && savedFootPosL`, the primary 4-bone arm solve is SKIPPED
entirely, and only the cascade runs. But the cascade re-extracts world positions
AFTER this skip — meaning it starts from the previous frame's cascade result
(not a clean state). Over-correction then under-correction each frame = oscillation.

**Fix approach:** See §10.

---

### Bug 2: applyToObjects console.trace in applyPoseState (PERFORMANCE)

**File:** `CharacterManager.ts` line 542

```ts
applyPoseState(pose: PoseState): void {
  console.trace('[applyPoseState called]')
```

`console.trace` is expensive. This should be removed.

---

### Bug 3: new THREE.Quaternion() inside hot loop (PERFORMANCE)

**File:** `CharacterManager.applyPoseState()`

```ts
node.quaternion.copy(restQ).multiply(new THREE.Quaternion(q.x, q.y, q.z, q.w))
```

Allocates a new Quaternion object on every bone every time applyPoseState is called.
Should use a preallocated temporary.

---

### Bug 4: Orphaned debug logging in GizmoController

**File:** `GizmoController._updateIKFreeDrag()`

The first ~50 lines contain frame-by-frame console.log calls that fire every 30 frames
during ANY drag. These are leftover from debugging the cascade oscillation.
They should be removed before shipping.

---

## 9. External IK library landscape

**Summary: All existing npm IK libraries are abandoned or incompatible.
Custom FABRIK is the right approach for this project.**

| Library | Algorithm | npm | Last update | Verdict |
|---------|-----------|-----|-------------|---------|
| `three-ik` (jsantell/THREE.IK) | FABRIK | yes | 2018 (7 years) | Dead |
| `three-skeletor` | FABRIK | yes | 2019 (6 years) | Dead |
| `fullik` (lo-th) | FABRIK | no | sporadic | No npm, niche |
| `ikts` (goldst/IK.ts) | FABRIK | yes | ~2021 | No Three.js integration |
| `upf-gti/IK-threejs` | CCD/FABRIK/hybrid | no | academic | No npm, research only |
| `three/examples CCDIKSolver` | CCD | built-in | active | **Broken with Mixamo** — Mixamo bones have π-offset rest rotations that violate CCDIKSolver's [-π, π] constraint assumptions |

### What a library would give us

- Constraint systems (angle limits, hinge joints) — we'd need to write our own on top anyway
- Built-in convergence helpers — we already have these
- Visualization helpers — we already have joint spheres

### Why custom FABRIK is better for this project

1. Mixamo bones require custom handling (bone name remapping, rest-pose deltas)
   that no library provides. We'd need an adapter layer regardless.
2. All maintained libraries are either not on npm or require TypeScript rewiring.
3. CCDIKSolver (the only built-in Three.js option) is documented to fail on Mixamo rigs.
4. FABRIK is simple enough (~100 lines) that owning the code is lower risk than a
   dependency on an unmaintained package.

---

## 10. Recommended fixes

### Fix A — Remove cascade oscillation

The cascade oscillation comes from the cascade and the primary solve fighting over the
same bone state each frame. Two viable approaches:

**Approach 1 — Clamp target to max reach (simplest)**

Before calling `solve()`, clamp the target to the sphere of radius `totalArmLength`
centered at the chain root:
```ts
const rootPos = joints[0].position
const dist = rootPos.distanceTo(target)
if (dist > totalLength) {
  target = rootPos.clone().add(
    target.clone().sub(rootPos).normalize().multiplyScalar(totalLength * 0.99)
  )
}
```
This prevents the "unreachable" branch from ever triggering, eliminating the cascade
entirely. The arm stretches toward but never fully reaches the target. Simpler and more
stable for a pose-reference tool.

**Approach 2 — Stable cascade (correct)**

Move the cascade to be the ONLY solve path when the target is out of reach (don't
attempt the short arm solve first). On each frame:
1. Refresh ALL extended-chain joint positions from objects
2. Run FABRIK on the extended chain
3. Apply to objects
4. Re-pin feet

The current code attempts the primary solve THEN falls into the cascade, polluting
the Three.js state before the cascade reads it. Running only one solve path per frame
eliminates the oscillation.

---

### Fix B — Remove debug console.log/trace calls

Files to clean:
- `CharacterManager.applyPoseState()` — remove `console.trace`
- `GizmoController._updateIKFreeDrag()` — remove the `_debugFrame < 5` and `_debugFrame % 30` log blocks
- `IKSolver.applyToObjects()` — the `shouldLog` / `console.log` can be removed now that the swing-delta approach is verified

---

### Fix C — Preallocate temporaries in applyPoseState

```ts
// Class field:
private _poseApplyTempQ = new THREE.Quaternion()

applyPoseState(pose: PoseState): void {
  for (const [boneName, q] of Object.entries(pose)) {
    const node = this.boneNodeMap.get(boneName as BoneName)
    if (!node) continue
    const restQ = this._restPose.get(boneName as BoneName)
    this._poseApplyTempQ.set(q.x, q.y, q.z, q.w)
    if (restQ) {
      node.quaternion.copy(restQ).multiply(this._poseApplyTempQ)
    } else {
      node.quaternion.copy(this._poseApplyTempQ)
    }
  }
}
```

---

### Fix D — Add angle constraints for elbows and knees

Currently elbows can bend backward and knees can hyperextend. FABRIK itself doesn't
enforce joint limits — they must be applied as a post-process step after each
`applyToObjects` call.

For a hinge joint (knee bends forward only):
```ts
// After applyToObjects, clamp the knee quaternion:
const kneeNode = charMgr.getBoneNode('lower_leg.L')
const euler = new THREE.Euler().setFromQuaternion(kneeNode.quaternion, 'XYZ')
euler.x = Math.max(0, Math.min(Math.PI * 0.95, euler.x))  // 0–171°
kneeNode.quaternion.setFromEuler(euler)
```

This is approximate (Euler decomposition order matters) but sufficient for a
pose-reference tool. True anatomical constraints require per-bone constraint
definitions in rig-config.json.

---

## Appendix: Coordinate conventions

- **World space**: Y up, right-handed (standard Three.js)
- **Bone local space**: bones point along their local +Y axis in the placeholder rig.
  Geometry is offset by `boneLength/2` along +Y so the box sits from pivot to child.
- **Mixamo GLB bones**: local axes vary per bone. GLTFLoader gives correct
  `position`/`quaternion`/`scale` directly. `restDir = setFromMatrixPosition(childObj.matrix)`
  reads the child's local offset regardless of which axis the bone points along.
- **NDC**: `x ∈ [-1, 1]` left→right, `y ∈ [-1, 1]` bottom→top (standard clip space).
- **Drag plane**: camera-facing `THREE.Plane` through the joint's world position.
  Mouse movement in 2D maps to 3D movement at the joint's depth.
