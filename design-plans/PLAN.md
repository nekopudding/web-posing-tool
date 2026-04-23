# Pose Reference Web App — Full Coding Plan & Architecture

## Overview

A browser-based 3D pose reference tool for artists. Users manually pose humanoid 3D models
using IK-driven drag controls, adjust body type via morph sliders, manage multi-character
scenes, and control camera/lens settings. Designed for clean outline-first rendering with
no dynamic lighting — pure silhouette and flat fill.

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | React 18 + TypeScript | Component model suits panel-heavy UI |
| Bundler | Vite | Fast HMR, native ESM |
| 3D engine | Three.js r160+ | WebGL, GLTF loader, morph targets, custom shaders |
| State | Zustand | Minimal boilerplate, works cleanly outside React for Three.js loops |
| Styling | CSS Modules | Scoped, no runtime overhead |
| GLTF model | Mixamo Y-Bot (Blender → GLTF) | Pre-rigged, clean topology, free |

No backend. Fully client-side.

---

## Project Structure

```
pose-ref/
├── public/
│   └── models/
│       └── humanoid.glb          # Final Blender export (added in Phase 4)
├── src/
│   ├── main.tsx                  # Vite entry
│   ├── App.tsx                   # Root layout — viewport + panels
│   ├── store/
│   │   └── useSceneStore.ts      # Zustand store — all scene state
│   ├── three/
│   │   ├── SceneManager.ts       # Three.js scene init, render loop, resize
│   │   ├── CharacterManager.ts   # Clone, remove, select characters
│   │   ├── IKSolver.ts           # FABRIK IK implementation
│   │   ├── IKChains.ts           # Chain definitions per character
│   │   ├── GizmoController.ts    # Raycasting, drag interaction on effectors
│   │   ├── OutlineMaterial.ts    # Inverted hull shader material
│   │   ├── GridOverlay.ts        # Perspective grid lines
│   │   └── ExportHelper.ts       # PNG / clipboard export
│   ├── components/
│   │   ├── ViewportCanvas.tsx    # <canvas> mount + SceneManager lifecycle
│   │   ├── panels/
│   │   │   ├── CharacterRoster.tsx   # Add / select / remove characters
│   │   │   ├── BodyTypePanel.tsx     # Morph target sliders
│   │   │   ├── LayerPanel.tsx        # Skin / muscle / bone toggles
│   │   │   ├── CameraPanel.tsx       # FOV, lens presets, orbit reset
│   │   │   └── ViewportPanel.tsx     # Grid toggle, outline width, export
│   └── styles/
│       └── *.module.css
├── PLAN.md                       # This file
└── BONES.md                      # Bone naming spec (see below)
```

---

## Bone Naming Convention

Defined before the IK solver so Blender export matches exactly.
Full spec lives in `BONES.md`. Summary:

```
Root
└── hips
    ├── spine
    │   └── chest
    │       └── neck
    │           └── head
    ├── shoulder.L / shoulder.R
    │   └── upper_arm.L / upper_arm.R
    │       └── forearm.L / forearm.R
    │           └── hand.L / hand.R          ← IK end effector
├── upper_leg.L / upper_leg.R
    └── lower_leg.L / lower_leg.R
        └── foot.L / foot.R                  ← IK end effector
            └── toe.L / toe.R
```

Suffix convention: `.L` = left side of character, `.R` = right side.
This maps directly to Blender's Rigify naming after applying the Rigify → custom name remap
described in `BONES.md`.

---

## Zustand Store — `useSceneStore.ts`

```ts
interface Character {
  id: string
  name: string
  pose: PoseState           // bone name → Quaternion
  morphWeights: MorphWeights
  layerVisibility: LayerVisibility
  worldPosition: Vector3
  worldRotation: number     // Y-axis rotation in radians
}

interface MorphWeights {
  build: number             // 0 = lean, 1 = heavy
  sex: number               // 0 = masculine, 1 = feminine
  weight: number            // 0 = low body fat, 1 = high
}

interface LayerVisibility {
  skin: boolean
  muscle: boolean
  bone: boolean
}

interface PoseState {
  [boneName: string]: { x: number; y: number; z: number; w: number }
}

interface SceneState {
  characters: Character[]
  activeCharacterId: string | null
  camera: CameraState
  viewport: ViewportState
  // actions
  addCharacter: () => void
  removeCharacter: (id: string) => void
  selectCharacter: (id: string) => void
  updatePose: (id: string, boneName: string, q: Quaternion) => void
  updateMorph: (id: string, key: keyof MorphWeights, value: number) => void
  updateLayer: (id: string, layer: keyof LayerVisibility, value: boolean) => void
  setWorldTransform: (id: string, pos: Vector3, rot: number) => void
}

interface CameraState {
  fov: number               // degrees, default 50
  lensPreset: '24mm' | '50mm' | '85mm' | 'fisheye'
  orbitTarget: Vector3
}

interface ViewportState {
  gridEnabled: boolean
  gridMode: '1point' | '2point'
  outlineThickness: number  // world units, 0.005–0.02
  backgroundColor: string
}
```

The Zustand store is the single source of truth. Three.js reads from it each frame (or on
change via subscriptions) and updates the scene. React panels read and write via hooks.

---

## Phase 1 — App Scaffold + Placeholder Rig

**Goal:** Running app with a poseable box skeleton, no real model needed.

### Tasks

1. `npm create vite@latest pose-ref -- --template react-ts`
2. Install: `three @types/three zustand`
3. `SceneManager.ts` — init scene, camera, WebGLRenderer, OrbitControls, render loop
4. `ViewportCanvas.tsx` — mount canvas, call SceneManager, handle resize
5. Placeholder rig — `BoxGeometry` segments connected by `Line` objects, positioned to
   roughly match the bone hierarchy. Each joint is a small sphere acting as a gizmo handle.
6. `App.tsx` — two-column layout: viewport (flex-grow) + right sidebar (320px fixed)
7. Basic `CharacterRoster.tsx` — hardcoded single character, "Add" button (wired in Phase 3)
8. OrbitControls working, camera orbits the placeholder

**Deliverable:** `npm run dev` shows a T-pose box figure you can orbit.

---

## Phase 2 — IK Solver + Outline + Drag Interaction

### IK Solver — FABRIK

FABRIK (Forward And Backward Reaching IK) is used for all limb chains.
Two-bone chains (arm: shoulder→hand, leg: hip→foot) are sufficient for v1.
Full FABRIK supports N-bone chains for future spine posing.

```
IKChain definition:
  bones: string[]       // ordered root → tip, from BONES.md names
  target: Vector3       // world-space position of end effector
  poleTarget?: Vector3  // optional hint for elbow/knee direction
  iterations: number    // default 10, converges fast for 2-bone chains
```

Chains per character:
- `arm.L`: `[shoulder.L, upper_arm.L, forearm.L, hand.L]`
- `arm.R`: `[shoulder.R, upper_arm.R, forearm.R, hand.R]`
- `leg.L`: `[upper_leg.L, lower_leg.L, foot.L]`
- `leg.R`: `[upper_leg.R, lower_leg.R, foot.R]`

Spine and head remain FK only in v1 — click-drag to rotate directly.

**FABRIK algorithm per frame:**
1. Forward pass: start from tip (effector), pull each bone toward target
2. Backward pass: start from root, push each bone back within bone length constraint
3. Repeat `iterations` times
4. Convert final bone world positions back to local quaternions for Three.js skeleton

### Inverted Hull Outline

`OutlineMaterial.ts` exports a `ShaderMaterial`:

```glsl
// vertex shader
uniform float outlineThickness;
void main() {
  vec3 pos = position + normal * outlineThickness;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
// fragment shader
uniform vec3 outlineColor;
void main() {
  gl_FragColor = vec4(outlineColor, 1.0);
}
```

Usage: for each character mesh, clone it, assign `OutlineMaterial`, set
`mesh.material.side = THREE.BackSide`. Both meshes share the same skeleton.
`outlineThickness` driven by `viewport.outlineThickness` in store.

### Gizmo Drag Interaction

`GizmoController.ts`:
- Raycasts against a layer containing only gizmo spheres (placed at IK effector positions)
- On pointer down: identify which effector on which character, begin drag
- On pointer move: unproject mouse to a plane perpendicular to camera, update
  `IKChain.target`, run FABRIK solve, update skeleton, sync quaternions to store
- On pointer up: end drag, final pose written to store

Gizmo spheres are `SphereGeometry(0.04)` with `MeshBasicMaterial`, rendered on top
via `renderOrder` and `depthTest: false` on the active character only.

**Deliverable:** Drag hands and feet to pose the placeholder figure. Outline renders around it.

---

## Phase 3 — UI Panels + Full State

### `CharacterRoster.tsx`
- Lists all characters with name + thumbnail (Three.js render-to-texture of each)
- "Add character" — clones base rig into scene, adds to store
- Click to select — highlights active character (outline color changes to accent)
- Delete button per character
- Max 6 characters (performance cap, configurable constant)

### `BodyTypePanel.tsx`
- Three sliders: Build (0–1), Sex (0–1), Weight (0–1)
- Labels: Build = "Lean ↔ Heavy", Sex = "Masc ↔ Femme", Weight = "Defined ↔ Soft"
- Writes to `character.morphWeights` in store
- Three.js side: `CharacterManager` subscribes to morph weight changes, calls
  `mesh.morphTargetInfluences[index] = value` on skin/muscle meshes

### `LayerPanel.tsx`
- Three toggle buttons: Skin / Muscle / Bone
- Writes to `character.layerVisibility`
- Three.js: sets `mesh.visible` on the corresponding mesh objects within the GLTF group

### `CameraPanel.tsx`
- FOV slider (10°–120°, default 50°)
- Lens presets — buttons: 24mm (74°), 50mm (47°), 85mm (29°), Fisheye (120°)
  Fisheye also applies a barrel distortion post-process shader (optional, flag to enable)
- "Reset camera" button — returns to default orbit position

### `ViewportPanel.tsx`
- Grid toggle (off / 1-point / 2-point)
- Outline thickness slider (0.005–0.025)
- Background color picker (white / light gray / dark gray / black)
- Export PNG button

### Layout — `App.tsx`

```
┌─────────────────────────────────┬──────────────┐
│                                 │ Character    │
│                                 │ roster       │
│         Three.js viewport       ├──────────────┤
│                                 │ Body type    │
│                                 ├──────────────┤
│                                 │ Layers       │
│                                 ├──────────────┤
│                                 │ Camera       │
│                                 ├──────────────┤
│                                 │ Viewport     │
└─────────────────────────────────┴──────────────┘
```

Right sidebar: 300px, scrollable. Viewport: fills remaining width, full height.

**Deliverable:** All panels wired. Multi-character scene working with placeholder rigs.

---

## Phase 4 — GLTF Integration

**Prerequisite:** `public/models/humanoid.glb` exported from Blender (see Blender
workflow below).

### Loading

```ts
const loader = new GLTFLoader()
loader.load('/models/humanoid.glb', (gltf) => {
  // gltf.scene contains:
  // - Armature object (SkinnedMesh with skeleton)
  // - "skin" mesh (SkinnedMesh, visible by default)
  // - "muscle" mesh (SkinnedMesh, hidden by default)
  // - "bone" mesh (SkinnedMesh, hidden by default)
  // - morphTargetDictionary on skin mesh: { build, sex, weight }
})
```

### Bone mapping

`CharacterManager.ts` traverses `gltf.scene` to find the `Skeleton`, maps bone names
from BONES.md to Three.js `Bone` objects, and passes the map to `IKChains.ts`.
If a bone name is missing, a console warning is emitted and that chain is disabled.

### Cloning for multi-character

Each additional character gets `SkeletonUtils.clone(gltf.scene)` — this correctly
deep-clones the skeleton so bone transforms are independent per character.

**Deliverable:** Real model renders in place of boxes. All posing, morphs, and layers work.

---

## Phase 5 — Polish + Export

- PNG export: `renderer.domElement.toBlob()` → download link
- Clipboard copy: `canvas.toBlob()` → `ClipboardItem` API
- Pose save/load: serialize `character.pose` (bone quaternions) to JSON, download/upload
- Mirror mode: reflect active character's pose across the X axis (swap .L/.R bones)
- Pose reset button: returns active character to T-pose
- Character rename (double-click name in roster)

---

## Blender Workflow (Model Preparation)

### Step 1 — Base mesh
1. Download Mixamo Y-Bot FBX from mixamo.com (free)
2. File → Import → FBX in Blender
3. Delete or replace the Y-Bot mesh geometry with a cleaner sculpt if desired,
   keeping the armature. Or use MakeHuman export (File → Import → MHX2) as an
   alternative with built-in body proportions.

### Step 2 — Rename bones to match BONES.md
The IK solver references bones by name. Mixamo uses names like `mixamorig:LeftArm`.
In Blender, select armature → Edit Mode → select each bone → rename in Item panel.
Target names are defined in `BONES.md`. A Blender Python script can batch-rename —
request this script separately.

### Step 3 — Skin weighting
If using Y-Bot, weights are already painted. If using a custom mesh:
1. Select mesh → Shift-select armature → Ctrl+P → With Automatic Weights
2. Refine in Weight Paint mode for hands, face, shoulders

### Step 4 — Shape keys (morph targets)
In Blender, shape keys are the equivalent of GLTF morph targets.
1. Select skin mesh → Object Data Properties → Shape Keys
2. Add a "Basis" key (the default T-pose mesh)
3. Add "build" key → sculpt/scale to heavier body proportions
4. Add "sex" key → sculpt to feminine proportions (narrower shoulders, wider hips)
5. Add "weight" key → sculpt to softer, higher body fat proportions
6. Repeat shape keys on the muscle mesh (muscle definition changes)
7. Bone mesh does not need shape keys (skeleton doesn't change proportions)

### Step 5 — Mesh layers
Ensure the scene has three separate mesh objects, all parented to the same armature:
- `skin` — outer body surface, always starts visible
- `muscle` — stylized muscle anatomy mesh, starts hidden
- `bone` — simplified skeleton mesh, starts hidden

All three must be `SkinnedMesh` type (have an Armature modifier applied).

### Step 6 — GLTF export
File → Export → glTF 2.0 (.glb)
Settings:
- Include: Selected Objects = off (export all)
- Transform: Y Up = on
- Geometry: Apply Modifiers = on, Uvs = on, Normals = on, Tangents = off
- Animation: Armature = on, Shape Keys = on, Skinning = on
- Compression: off for v1 (Draco adds complexity, enable later)

Output: `humanoid.glb` → place in `pose-ref/public/models/`

---

## Performance Notes

- Target 60fps at 1920×1080 with up to 6 characters
- FABRIK runs on the CPU each frame only for chains with active drag. Idle characters
  skip IK solve entirely.
- `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))` — cap at 2x
- Outline meshes share geometry with source meshes (no copy) — only material differs
- Morph target updates are O(vertices) — only trigger on slider change, not every frame
- `SkeletonUtils.clone` is called once at character creation, not per frame

---

## Key Dependencies (package.json)

```json
{
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "three": "^0.160.0",
    "zustand": "^4.5.0"
  },
  "devDependencies": {
    "@types/three": "^0.160.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.4.0",
    "vite": "^5.2.0"
  }
}
```

---

## Build Order Checklist

- [ ] Phase 1 — Scaffold + placeholder rig running (`npm run dev`)
- [ ] Phase 2 — FABRIK IK + inverted hull outline + gizmo drag
- [ ] Phase 3 — All UI panels + Zustand store wired
- [ ] Blender — bone rename, shape keys, layer meshes, GLB export
- [ ] Phase 4 — GLB loaded, bone map verified, multi-character cloning
- [ ] Phase 5 — Export, mirror, pose save/load, polish

---

## Future (Post-V1)

- MediaPipe sketch input with `numPoses` config (1–5 characters from one drawing)
- LLM prompt posing (bone angle JSON schema → natural language)
- Pose library with thumbnail previews
- Hand/finger posing (finger bone chains)
- Environment backgrounds (gradient, color, reference image)
- Draco compression for faster model load
- Mobile touch support for drag interaction
