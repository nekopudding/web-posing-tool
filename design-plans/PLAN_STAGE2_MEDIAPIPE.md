# Stage 2 — ML Pose Detection (MediaPipe)

## Overview

Stage 2 adds computer vision-based pose input as an alternative to manual IK dragging.
The user draws a stick figure (or uploads a photo/sketch), MediaPipe detects body
landmarks, and those landmarks are mapped onto the selected character(s) in the scene.
Manual IK editing remains fully available after detection — CV output is a starting
point, not a locked pose.

This stage builds entirely on top of the Stage 1 codebase. No existing systems are
replaced — only new input pathways are added.

---

## Goals

- Let users rough-in a pose by drawing or uploading rather than dragging joints one by one
- Support multi-character detection from a single sketch (up to 5 figures)
- Keep CV as an optional accelerator — the user always retains full manual control
- Run entirely in the browser (no backend, no API calls for inference)

---

## Why MediaPipe Performs Poorly on Stick Figures

MediaPipe Pose (BlazePose) was trained on photographs of real people. It relies on
texture, clothing, skin tone, and shading cues that stick figures lack entirely.
Expected accuracy on rough sketches:

| Input type | Expected landmark accuracy |
|---|---|
| Photograph of real person | ~95% |
| Detailed figure drawing (shaded) | ~60–75% |
| Simple line drawing with limb thickness | ~40–60% |
| Minimal stick figure (lines only) | ~15–35% |

### Mitigation strategy

Rather than fight this limitation, Stage 2 uses a two-tier approach:

**Tier 1 — MediaPipe as rough estimator.** Run detection, accept whatever landmarks
come back, apply them as an approximate pose. The user corrects the result manually
using Stage 1's IK tools. Even a 40% accurate detection saves significant posing time
for common poses.

**Tier 2 — Custom sketch model (optional v2.1).** Fine-tune a lightweight keypoint
model (MoveNet Lightning or ViTPose-S) on a synthetic sketch dataset. This is a
significant ML effort and is flagged as a future upgrade, not a Stage 2 requirement.

---

## New Dependencies

```json
{
  "@mediapipe/tasks-vision": "^0.10.x"
}
```

MediaPipe Tasks Vision runs via WASM in the browser. No GPU required (though it uses
WebGPU delegate if available for ~3x speedup).

---

## Architecture Changes

### New files

```
src/
├── cv/
│   ├── PoseDetector.ts         # MediaPipe wrapper, config, inference
│   ├── LandmarkMapper.ts       # 2D landmarks → 3D bone angles
│   ├── SketchCanvas.tsx        # Drawing canvas component
│   └── DetectionOverlay.tsx    # Visualise detected landmarks on canvas
├── components/panels/
│   └── CVInputPanel.tsx        # Sketch input UI + detection controls
```

### Modified files

```
src/store/useSceneStore.ts      # Add CV input state, numPoses config
src/App.tsx                     # Add CV input panel to sidebar
```

---

## MediaPipe Configuration

```ts
// src/cv/PoseDetector.ts

import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

interface DetectorConfig {
  numPoses: number          // 1–5, user-configurable
  minPoseConfidence: number // default 0.5
  minTrackingConfidence: number // default 0.5
  delegate: 'CPU' | 'GPU'  // auto-detected
}

const DEFAULT_CONFIG: DetectorConfig = {
  numPoses: 1,
  minPoseConfidence: 0.5,
  minTrackingConfidence: 0.5,
  delegate: 'GPU',
}

export class PoseDetector {
  private landmarker: PoseLandmarker | null = null

  async init(config: DetectorConfig = DEFAULT_CONFIG) {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
    )
    this.landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
        delegate: config.delegate,
      },
      runningMode: 'IMAGE',
      numPoses: config.numPoses,
      minPoseDetectionConfidence: config.minPoseConfidence,
      minTrackingConfidence: config.minTrackingConfidence,
    })
  }

  detect(imageElement: HTMLCanvasElement | HTMLImageElement) {
    if (!this.landmarker) throw new Error('PoseDetector not initialised')
    return this.landmarker.detect(imageElement)
    // Returns: { landmarks: NormalizedLandmark[][], worldLandmarks: Landmark[][] }
    // landmarks[i] = array of 33 landmarks for pose i
    // worldLandmarks[i] = same but in metric 3D space (hip-centred)
  }
}
```

**Model choice — Lite vs Full vs Heavy:**

| Model | Size | Speed | Accuracy |
|---|---|---|---|
| `pose_landmarker_lite` | 2.9MB | ~30ms | Good for rough input |
| `pose_landmarker_full` | 5.5MB | ~60ms | Better for detailed drawings |
| `pose_landmarker_heavy` | 29MB | ~200ms | Best accuracy, slow initial load |

Use `lite` for v2.0. Expose model selection in settings for power users.

---

## MediaPipe Landmark Map

MediaPipe returns 33 landmarks. Relevant ones for body posing:

```
Index  Name                    Maps to bone
0      nose                    head
11     left shoulder           shoulder.L
12     right shoulder          shoulder.R
13     left elbow              forearm.L (midpoint)
14     right elbow             forearm.R (midpoint)
15     left wrist              hand.L (IK effector)
16     right wrist             hand.R (IK effector)
23     left hip                upper_leg.L
24     right hip               upper_leg.R
25     left knee               lower_leg.L (midpoint)
26     right knee              lower_leg.R (midpoint)
27     left ankle              foot.L (IK effector)
28     right ankle             foot.R (IK effector)
```

Indices 17–22 (fingers) and 29–32 (foot detail) are unused in Stage 2.
Spine is inferred from the midpoint between shoulders and midpoint between hips.

---

## Landmark → Bone Angle Mapping

```ts
// src/cv/LandmarkMapper.ts

import { NormalizedLandmark } from '@mediapipe/tasks-vision'
import * as THREE from 'three'

// MediaPipe worldLandmarks are in metric space, hip-centred, Y-up
// This maps directly to Three.js coordinate space after axis flip

export function mapLandmarksToPose(
  worldLandmarks: { x: number; y: number; z: number }[]
): Record<string, THREE.Quaternion> {
  const pose: Record<string, THREE.Quaternion> = {}

  // Each bone angle is computed from the vector between its two landmark endpoints
  // then converted to a local-space quaternion relative to the parent bone

  pose['upper_arm.L'] = computeBoneRotation(
    worldLandmarks[11], // shoulder.L
    worldLandmarks[13], // elbow.L
    worldLandmarks[11]  // parent = shoulder.L position
  )

  pose['forearm.L'] = computeBoneRotation(
    worldLandmarks[13], // elbow.L
    worldLandmarks[15], // wrist.L
    worldLandmarks[11]  // parent = shoulder.L position
  )

  // ... repeat for all limbs

  return pose
}

function computeBoneRotation(
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  parentStart: { x: number; y: number; z: number }
): THREE.Quaternion {
  const dir = new THREE.Vector3(
    end.x - start.x,
    end.y - start.y,
    end.z - start.z
  ).normalize()

  // Bone rest direction in local space (T-pose = pointing down Y for limbs)
  const restDir = new THREE.Vector3(0, -1, 0)
  return new THREE.Quaternion().setFromUnitVectors(restDir, dir)
}
```

### Depth ambiguity handling

2D landmark detection (from a sketch) loses depth information. The Z coordinate of
2D landmarks is always near zero. Heuristics to recover approximate depth:

1. **Limb length ratio:** If a detected arm appears shorter than the known bone length,
   it is likely foreshortened — estimate Z depth proportionally.
2. **Bilateral symmetry:** If one shoulder is significantly higher than the other in 2D,
   the character is likely rotated — infer Y-axis body rotation.
3. **Manual Z correction:** Expose a per-joint "depth nudge" slider that appears after
   detection, letting the user correct the most common foreshortening errors quickly.

---

## Sketch Canvas Component

```tsx
// src/cv/SketchCanvas.tsx

// A full-featured drawing canvas for stick figure input:
// - Freehand brush (pointer events)
// - Pressure sensitivity via pointer pressure API if available
// - Undo / redo (Ctrl+Z)
// - Clear button
// - Line thickness control
// - Import image button (for photo or reference upload)
// - Run detection button → calls PoseDetector.detect(canvas)
```

The canvas renders at the same aspect ratio as the Three.js viewport so spatial
correspondence between the sketch and the 3D scene is intuitive.

After detection runs, `DetectionOverlay.tsx` renders the 33 landmark dots and skeleton
lines on top of the sketch as a semi-transparent overlay, letting the user see what
was detected before it is applied.

---

## Multi-Character Detection Flow

```
User draws N stick figures on canvas
         ↓
PoseDetector.detect() returns N pose results (up to numPoses)
         ↓
For each detected pose i:
  If character[i] exists in roster → apply pose to character[i]
  Else → auto-create new character, apply pose
         ↓
User reviews detection overlay
         ↓
User clicks "Apply to scene"
         ↓
LandmarkMapper converts each pose to bone quaternions
         ↓
CharacterManager.applyDetectedPose(characterId, boneQuaternions)
         ↓
IK effectors are repositioned to match detected hand/foot positions
         ↓
User manually corrects with IK drag as needed
```

**numPoses config UI:**
- Stepper input in CVInputPanel, range 1–5
- Label: "Detect up to N figures"
- Setting persists in Zustand viewport state
- If detected poses < numPoses, no error — just fewer characters created

---

## Confidence Thresholding

MediaPipe returns a visibility score (0–1) per landmark.
Landmarks below threshold (default 0.5) are marked unreliable and excluded from mapping.
If more than 6 landmarks for a given pose fall below threshold, the entire pose detection
result for that figure is flagged with a warning in the overlay ("Low confidence — check
manually") and the pose is applied but highlighted in the roster.

---

## CVInputPanel UI Layout

```
┌─────────────────────────────────┐
│ Pose input                      │
│                                 │
│ [Sketch]  [Upload image]        │
│                                 │
│ ┌───────────────────────────┐   │
│ │                           │   │
│ │    Sketch canvas          │   │
│ │                           │   │
│ └───────────────────────────┘   │
│                                 │
│ Detect up to [1 ▲▼] figures     │
│                                 │
│ Model: [Lite ▼]                 │
│ Confidence: [──●──] 0.50        │
│                                 │
│ [Run detection]                 │
│                                 │
│ [Apply to scene]  [Discard]     │
└─────────────────────────────────┘
```

---

## Store Additions

```ts
// Additions to useSceneStore.ts

interface CVState {
  numPoses: number                    // 1–5
  modelVariant: 'lite' | 'full' | 'heavy'
  confidenceThreshold: number
  lastDetectionResult: DetectionResult | null
  detectionStatus: 'idle' | 'running' | 'done' | 'error'
}

interface DetectionResult {
  poses: DetectedPose[]
  timestamp: number
}

interface DetectedPose {
  landmarks: NormalizedLandmark[]
  worldLandmarks: Landmark[]
  confidence: number
  mappedBones: Record<string, THREE.Quaternion>
  lowConfidenceBones: string[]
}
```

---

## New Files Checklist

- [ ] `src/cv/PoseDetector.ts` — MediaPipe wrapper + config
- [ ] `src/cv/LandmarkMapper.ts` — landmark → quaternion conversion
- [ ] `src/cv/SketchCanvas.tsx` — drawing canvas + undo/redo
- [ ] `src/cv/DetectionOverlay.tsx` — landmark visualisation overlay
- [ ] `src/components/panels/CVInputPanel.tsx` — full input UI
- [ ] Update `src/store/useSceneStore.ts` — add CVState
- [ ] Update `src/App.tsx` — add CVInputPanel to sidebar
- [ ] Update `src/three/CharacterManager.ts` — add `applyDetectedPose` method

---

## Testing Strategy

Since detection accuracy on sketches is inherently variable, test with a range of inputs:

1. A clear photograph of a person in a recognisable pose (baseline — should be ~95%)
2. A detailed anatomical figure drawing
3. A simple contour line drawing with body proportions intact
4. A minimal stick figure (lines and circles)
5. Two stick figures on the same canvas (multi-character test)
6. A stick figure at an angle (foreshortening test)

For each, evaluate: were all 4 IK effectors placed within reasonable range of correct?
A "reasonable range" is defined as within 20% of bone length from the ground truth position.

---

## Future Upgrade — Custom Sketch Model (v2.1)

If MediaPipe accuracy on sketches proves insufficient after real user testing, the path
to a purpose-built model is:

1. **Dataset:** Generate synthetic sketches from 3D pose data — render the Stage 1 rig
   in a flat line-art style across thousands of randomised poses. Each render is
   automatically labelled with ground-truth joint positions.
2. **Model:** Fine-tune MoveNet Lightning (TensorFlow.js, runs in browser) or
   ViTPose-Small (requires ONNX Runtime Web) on the synthetic dataset.
3. **Integration:** Replace `PoseDetector.ts` with a `SketchPoseDetector.ts` that loads
   the custom model. `LandmarkMapper.ts` is unchanged — same output format.
4. **Estimated effort:** ~2–3 weeks for dataset generation pipeline + training +
   integration, assuming access to a GPU for training.

This upgrade is entirely self-contained — the rest of the Stage 2 architecture is
identical regardless of which detection model is used.
