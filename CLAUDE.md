# Pose Reference Tool — CLAUDE.md

Architecture reference for future Claude Code sessions. Read this before making changes.

---

## What This Is

A browser-based 3D pose reference tool for artists. Users drag joint spheres on a humanoid
skeleton to pose characters; designed for clean outline rendering with no dynamic lighting.
No backend — fully client-side.

**Tech stack:** React 18 + TypeScript, Vite 5, Three.js r184, Zustand 5, CSS Modules, pnpm.

## Coding Style
- Write comments on complex function designs, ambiguous properties.

---

## Project Structure

```
src/
├── store/
│   └── useSceneStore.ts      ← Zustand store — ALL scene state lives here
├── three/
│   ├── IKChains.ts           ← Bone names, chain defs, bone lengths (NO Three.js imports)
│   ├── IKSolver.ts           ← FABRIK IK algorithm
│   ├── OutlineMaterial.ts    ← Inverted hull outline ShaderMaterial
│   ├── GridOverlay.ts        ← Three.js GridHelper + AxesHelper wrapper
│   ├── SceneManager.ts       ← Scene, camera, renderer, render loop
│   ├── CharacterManager.ts   ← Per-character rig, geometry, bone node hierarchy
│   ├── GizmoController.ts    ← Pointer drag → IK → pose update
│   └── ExportHelper.ts       ← PNG export, pose JSON export/import (Phase 5)
├── components/
│   ├── ViewportCanvas.tsx    ← Canvas mount + Three.js lifecycle + Zustand subscriptions
│   └── panels/
│       ├── CharacterRoster.tsx
│       ├── BodyTypePanel.tsx
│       ├── LayerPanel.tsx
│       ├── CameraPanel.tsx
│       └── ViewportPanel.tsx
└── styles/
    ├── App.module.css
    ├── ViewportCanvas.module.css
    ├── Panel.module.css          ← Shared panel/control styles
    └── CharacterRoster.module.css
```

---

## Key Architecture Decisions

### 1. Zustand Store as Single Source of Truth

All serializable scene state lives in `useSceneStore`. **No Three.js objects** ever enter
the store — only plain JS values (numbers, strings, `{x,y,z,w}` quaternions).

The store uses `subscribeWithSelector` middleware (Zustand 5). Without it,
`store.subscribe(selector, listener)` is not available — only `store.subscribe(listener)`.

### 2. Zustand → Three.js Sync: Subscriptions, Not useEffect

Pose updates during drag happen at 60fps. Using React `useEffect` for them would trigger
React reconciliation on every frame — unacceptable jank.

Instead, `ViewportCanvas.tsx` registers Zustand subscriptions with `store.subscribe()`:
- High-frequency (pose, morph): Zustand subscription → CharacterManager method (no React)
- Low-frequency (grid toggle, camera preset): React `useEffect` is fine here

See `ViewportCanvas.tsx` for the full subscription list.

### 3. CharacterManager — Placeholder Rig Structure

Phase 1–3 uses `THREE.Object3D` nodes (not `THREE.Bone`/`THREE.Skeleton`).
Each joint node has:
- A `SphereGeometry` mesh at origin with `userData.boneName` and `userData.characterId`
  (raycasting target for GizmoController)
- A `BoxGeometry` mesh offset up by `boneLength/2` (bone segment visual)
- A companion outline mesh with `OutlineMaterial` (BackSide, same geometry)

Phase 4 (GLTF model): replace `buildPlaceholderRig()` with `loadGLTF(url)` which
populates `boneNodeMap` from the GLTF's skeleton bones instead.

### 4. IK Solver (FABRIK)

`IKSolver.solve()` operates on world-space `{position: THREE.Vector3}[]` arrays.
The algorithm:
1. Forward pass: pull tip to target, propagate root-ward at fixed lengths
2. Backward pass: re-pin root, push tip-ward at fixed lengths
3. Repeat until convergence (typically 2–5 iterations for 3–4 bone chains)

After solving, `applyToObjects()` converts world positions back to local quaternions:
- Compute the desired bone direction in world space
- `quaternion.setFromUnitVectors(UP_AXIS, boneWorldDir)` gives the world-space rotation
- De-compose to local space: `localQ = inverse(parentWorldQ) * worldQ`

**Bones point along their local +Y axis in the placeholder rig** (geometry offset strategy:
BoxGeometry is translated by `boneLength/2` along Y so the box starts at the pivot).
The IK solver's rest axis must match: `new THREE.Vector3(0, 1, 0)`.

### 5. GizmoController — Drag Interaction

`GizmoController` uses the Pointer Events API (not mouse events) for:
- `setPointerCapture` — events keep firing even when mouse leaves canvas
- Works with both mouse and touch

OrbitControls conflict: `controls.enabled = false` on drag start, re-enabled on pointerup.

Drag plane: camera-facing `THREE.Plane` through the joint's world position. This maps
2D mouse movement to 3D world movement at the correct depth.

Store writes happen on `pointerup` only (not per-frame) to avoid Zustand churn at 60fps.

### 6. Outline Material

Inverted hull technique: render the mesh a second time with `BackSide` and vertices
expanded along normals by `outlineThickness`. No post-processing needed.

`createOutlineMaterial()` returns a `ShaderMaterial`. Call `setOutlineThickness(mat, v)`
to update the uniform when the slider changes.

### 7. SceneManager

Not a singleton — instantiated in `ViewportCanvas.tsx` via `useRef`. This allows
proper cleanup on React unmount.

`addBeforeRenderCallback(fn)` returns an unsubscribe function. GizmoController registers
its `update()` method here so it runs every frame.

`renderer.preserveDrawingBuffer = true` is required for `canvas.toBlob()` (PNG export).

---

## Bone Naming Convention

See `src/three/IKChains.ts` for the full list. Summary:
- Center-line bones: `root`, `hips`, `spine`, `chest`, `neck`, `head`
- Left side: `shoulder.L`, `upper_arm.L`, `forearm.L`, `hand.L`, `upper_leg.L`, ...
- Right side: same with `.R` suffix
- `.L` = character's left (screen right in front view); `.R` = character's right

IK chains (arms and legs only; spine/head remain FK-only):
- `arm.L`: `[shoulder.L, upper_arm.L, forearm.L, hand.L]`
- `arm.R`: `[shoulder.R, upper_arm.R, forearm.R, hand.R]`
- `leg.L`: `[upper_leg.L, lower_leg.L, foot.L]`
- `leg.R`: `[upper_leg.R, lower_leg.R, foot.R]`

---

## Phase Status

- [x] Phase 1 — Scaffold + placeholder rig (box skeleton, orbitable)
- [x] Phase 2 — FABRIK IK + inverted hull outline + gizmo drag
- [x] Phase 3 — All UI panels + Zustand store wired
- [ ] Blender — bone rename, shape keys, layer meshes, GLB export → `public/models/humanoid.glb`
- [ ] Phase 4 — GLTF loaded, `CharacterManager.loadGLTF()`, morph targets
- [ ] Phase 5 — Export, mirror pose, pose save/load, character rename

---

## Common Gotchas

**Canvas zero-size on init**: `ResizeObserver` fires asynchronously. `SceneManager` calls
`handleResize(clientWidth || 800, clientHeight || 600)` in the constructor as a fallback.
Don't rely solely on the observer for the initial size.

**Zustand 5 subscribe without selector**: `store.subscribe(fn)` gives the full state.
For `store.subscribe(selector, fn)`, the `subscribeWithSelector` middleware is required.

**Three.js OrthographicCamera switch**: changing camera preset replaces `this.camera` and
calls `controls.object = newCamera`. The render loop reads `scene.camera` which is the
same reference — update both. See `SceneManager.setCameraPreset()`.

**CSS min-width: 0 on flex child**: required on `.viewportArea` to prevent the flex item
from overflowing when the sidebar is present. Without it, flexbox defaults `min-width: auto`
(content size) and the canvas won't shrink.

**GLTF SkeletonUtils.clone**: when loading Phase 4, use `SkeletonUtils.clone(gltf.scene)`
(from `three/examples/jsm/utils/SkeletonUtils.js`) to deep-clone the skeleton for each
character. A plain `gltf.scene.clone()` does NOT clone the skeleton — all characters
share one skeleton and moving one moves all.

---

## Running the App

```bash
pnpm dev        # dev server at http://localhost:5173
pnpm build      # production build to dist/
pnpm preview    # preview the production build
```
