# Stage 3 — LLM Prompt-Based Scene Configuration

## Overview

Stage 3 adds a natural language interface for controlling the scene. The user types
instructions like "put the left character in a contrapposto pose", "rotate the camera
to a low angle looking up", or "make the figure lean forward with arms crossed" and the
LLM translates these into structured scene mutations that are applied directly to the
Zustand store.

The LLM never controls the app directly — it outputs a strictly typed JSON action
payload that the app validates and executes. This keeps the LLM sandboxed and the
app deterministic.

---

## Goals

- Natural language posing for users who find IK drag unintuitive for complex poses
- Natural language camera and viewport control
- Multi-character scene direction ("make character 2 face character 1")
- Pose vocabulary that artists already use (contrapposto, foreshortening, weight shift)
- Works with the Anthropic API (Claude) as the LLM backend
- Graceful fallback when the LLM output is ambiguous or invalid

---

## Architecture Principle — LLM as JSON Emitter

The LLM is given a detailed system prompt that defines the full action schema. It is
instructed to respond only with a JSON action payload — no prose, no explanation.
The app parses and validates the JSON, applies the actions, then optionally shows the
user a human-readable summary of what changed.

This means:
- The LLM never has access to Three.js or the DOM
- Invalid LLM output is caught by the schema validator before anything happens
- Every LLM action is undoable (all mutations go through the existing Zustand store)
- The full action history is inspectable for debugging

---

## New Dependencies

```json
{
  "dependencies": {
    "zod": "^3.23.0"
  }
}
```

Zod handles JSON schema validation of LLM output. No LLM SDK is needed — the Anthropic
API is called directly via `fetch`. The API key is entered by the user in settings and
stored in `localStorage` only (never sent anywhere except `api.anthropic.com`).

---

## Project Structure Additions

```
src/
├── llm/
│   ├── AnthropicClient.ts      # Fetch wrapper for /v1/messages
│   ├── SystemPrompt.ts         # System prompt builder (dynamic, schema-aware)
│   ├── ActionSchema.ts         # Zod schemas for all LLM output actions
│   ├── ActionExecutor.ts       # Validates + applies action payload to store
│   ├── SceneSerializer.ts      # Converts current scene state to LLM-readable summary
│   └── PromptHistory.ts        # Conversation history manager (multi-turn)
├── components/panels/
│   └── PromptPanel.tsx         # Chat input UI, history, status
```

---

## Action Schema

The LLM can emit one or more actions per response. All actions are defined with Zod and
exported as TypeScript types. The full schema is also serialised into the system prompt
so the LLM knows exactly what it can produce.

```ts
// src/llm/ActionSchema.ts

import { z } from 'zod'

// ── Pose actions ──────────────────────────────────────────────

// Set a specific bone rotation by Euler angles (degrees, XYZ order)
const SetBoneRotation = z.object({
  type: z.literal('SET_BONE_ROTATION'),
  characterId: z.string(),          // character id or "active" for current selection
  bone: z.string(),                 // bone name from BONES.md
  euler: z.object({
    x: z.number().min(-180).max(180),
    y: z.number().min(-180).max(180),
    z: z.number().min(-180).max(180),
  }),
})

// Move an IK end effector to a world-space position
const SetIKTarget = z.object({
  type: z.literal('SET_IK_TARGET'),
  characterId: z.string(),
  effector: z.enum(['hand.L', 'hand.R', 'foot.L', 'foot.R']),
  position: z.object({
    x: z.number(),                  // world space, metres
    y: z.number(),
    z: z.number(),
  }),
})

// Apply a named preset pose
const ApplyPosePreset = z.object({
  type: z.literal('APPLY_POSE_PRESET'),
  characterId: z.string(),
  preset: z.enum([
    'tpose',
    'apose',
    'standing_neutral',
    'contrapposto',
    'sitting',
    'kneeling',
    'running',
    'reaching_up',
    'arms_crossed',
    'hands_on_hips',
  ]),
})

// Mirror the active character's pose (left/right flip)
const MirrorPose = z.object({
  type: z.literal('MIRROR_POSE'),
  characterId: z.string(),
  axis: z.enum(['x']),              // only X mirror in v1
})

// ── Body type actions ─────────────────────────────────────────

const SetMorphWeight = z.object({
  type: z.literal('SET_MORPH_WEIGHT'),
  characterId: z.string(),
  morph: z.enum(['build', 'sex', 'weight']),
  value: z.number().min(0).max(1),
})

// ── Character actions ─────────────────────────────────────────

const AddCharacter = z.object({
  type: z.literal('ADD_CHARACTER'),
  name: z.string().optional(),
})

const SelectCharacter = z.object({
  type: z.literal('SELECT_CHARACTER'),
  characterId: z.string(),          // id or "last" / "first"
})

const SetCharacterPosition = z.object({
  type: z.literal('SET_CHARACTER_POSITION'),
  characterId: z.string(),
  position: z.object({ x: z.number(), z: z.number() }), // world XZ (Y stays at floor)
})

const SetCharacterFacing = z.object({
  type: z.literal('SET_CHARACTER_FACING'),
  characterId: z.string(),
  // Point character toward another character, a direction, or a world position
  toward: z.union([
    z.object({ characterId: z.string() }),
    z.object({ direction: z.enum(['camera', 'left', 'right', 'forward', 'back']) }),
    z.object({ position: z.object({ x: z.number(), z: z.number() }) }),
  ]),
})

// ── Camera actions ────────────────────────────────────────────

const SetCameraPreset = z.object({
  type: z.literal('SET_CAMERA_PRESET'),
  preset: z.enum([
    'front',
    'back',
    'left',
    'right',
    'top',
    'three_quarter',
    'low_angle',
    'high_angle',
    'over_shoulder',
    'dutch_angle',
  ]),
})

const SetCameraFOV = z.object({
  type: z.literal('SET_CAMERA_FOV'),
  fov: z.number().min(10).max(120),
})

const SetLensPreset = z.object({
  type: z.literal('SET_LENS_PRESET'),
  preset: z.enum(['24mm', '50mm', '85mm', 'fisheye']),
})

const OrbitCamera = z.object({
  type: z.literal('ORBIT_CAMERA'),
  deltaAzimuth: z.number().min(-180).max(180),  // degrees, positive = rotate right
  deltaElevation: z.number().min(-90).max(90),  // degrees, positive = look up
  deltaDistance: z.number().optional(),          // multiplier, e.g. 0.5 = zoom in
})

// ── Viewport actions ──────────────────────────────────────────

const SetGrid = z.object({
  type: z.literal('SET_GRID'),
  mode: z.enum(['off', '1point', '2point']),
})

const SetLayerVisibility = z.object({
  type: z.literal('SET_LAYER_VISIBILITY'),
  characterId: z.string(),
  layer: z.enum(['skin', 'muscle', 'bone']),
  visible: z.boolean(),
})

// ── Root response schema ──────────────────────────────────────

const Action = z.discriminatedUnion('type', [
  SetBoneRotation,
  SetIKTarget,
  ApplyPosePreset,
  MirrorPose,
  SetMorphWeight,
  AddCharacter,
  SelectCharacter,
  SetCharacterPosition,
  SetCharacterFacing,
  SetCameraPreset,
  SetCameraFOV,
  SetLensPreset,
  OrbitCamera,
  SetGrid,
  SetLayerVisibility,
])

export const LLMResponse = z.object({
  actions: z.array(Action).min(1).max(20),
  summary: z.string().max(200),   // human-readable description of what was done
  clarification: z.string().optional(), // if the request was ambiguous, ask here
})

export type LLMResponseType = z.infer<typeof LLMResponse>
export type ActionType = z.infer<typeof Action>
```

---

## System Prompt

The system prompt is built dynamically at request time to include current scene state.
This gives the LLM the context it needs to resolve references like "the left character"
or "move the arm down a bit more".

```ts
// src/llm/SystemPrompt.ts

export function buildSystemPrompt(sceneContext: string): string {
  return `
You are a 3D scene director assistant for a pose reference tool used by artists.
Your job is to translate natural language instructions into structured scene changes.

## Response format

You MUST respond with ONLY valid JSON matching this schema. No prose before or after.

{
  "actions": [ ...one or more action objects... ],
  "summary": "Brief human-readable description of what you did (max 200 chars)",
  "clarification": "Optional: ask this if the request is genuinely ambiguous"
}

## Available action types and their schemas

${ACTION_SCHEMA_REFERENCE}

## Current scene state

${sceneContext}

## Rules

1. Always use character IDs exactly as shown in scene state. Never invent IDs.
2. Bone names must exactly match BONES.md: hips, spine, chest, neck, head,
   shoulder.L/R, upper_arm.L/R, forearm.L/R, hand.L/R,
   upper_leg.L/R, lower_leg.L/R, foot.L/R, toe.L/R
3. Euler angles are in degrees, XYZ order, range -180 to 180.
4. World space units are metres. A typical character is ~1.7m tall.
   Floor is at Y=0. Character hips are at approximately Y=0.9.
5. Prefer SET_IK_TARGET for hand/foot positioning — it is more intuitive than
   individual bone rotations for end limbs. Use SET_BONE_ROTATION for spine,
   neck, head, and shoulder adjustments.
6. Prefer APPLY_POSE_PRESET when the user describes a named pose. Only use
   individual bone/IK actions for fine adjustments on top of presets.
7. When a user says "a bit", "slightly", "a little" — use small values (5–15°).
   When they say "a lot", "significantly", "fully" — use larger values (45–90°).
8. Camera actions use the current orbit target (scene centre or active character).
9. If the instruction is physically impossible (e.g. "make the arm go through the
   torso"), apply the closest achievable pose and note it in the summary.
10. Never emit more than 20 actions in a single response.
`
}
```

---

## Scene Serialiser

The scene state is summarised in a compact, LLM-readable format before each request.
This avoids sending raw quaternions (which the LLM can't reason about) and instead
describes the scene in natural terms.

```ts
// src/llm/SceneSerializer.ts

export function serializeScene(store: SceneState): string {
  const chars = store.characters.map((c, i) => {
    const poseDesc = describePose(c.pose)   // converts quaternions to plain English
    return `Character "${c.name}" (id: ${c.id})${i === 0 ? ' [ACTIVE]' : ''}:
  - Pose: ${poseDesc}
  - Body type: build=${c.morphWeights.build.toFixed(2)}, sex=${c.morphWeights.sex.toFixed(2)}, weight=${c.morphWeights.weight.toFixed(2)}
  - Position: x=${c.worldPosition.x.toFixed(2)}, z=${c.worldPosition.z.toFixed(2)}
  - Layers visible: ${Object.entries(c.layerVisibility).filter(([,v]) => v).map(([k]) => k).join(', ')}
`
  }).join('\n')

  const cam = `Camera: FOV=${store.camera.fov}°, lens=${store.camera.lensPreset}`
  const vp  = `Viewport: grid=${store.viewport.gridMode}`

  return `${chars}\n${cam}\n${vp}`
}

function describePose(pose: PoseState): string {
  // Convert stored quaternions to approximate human-readable descriptions
  // e.g. "left arm raised ~45°, right arm at side, slight forward lean"
  // This is a best-effort natural language approximation
  // Implementation: convert key bone quaternions to Euler, threshold into descriptions
  // ...
}
```

---

## Anthropic API Client

```ts
// src/llm/AnthropicClient.ts

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export async function callClaude(
  systemPrompt: string,
  history: Message[],
  userMessage: string,
  apiKey: string
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        ...history,
        { role: 'user', content: userMessage },
      ],
    }),
  })

  if (!response.ok) {
    const err = await response.json()
    throw new Error(`Anthropic API error: ${err.error?.message ?? response.status}`)
  }

  const data = await response.json()
  return data.content[0].text
}
```

Note on API key: the user supplies their own Anthropic API key in a settings panel.
It is stored in `localStorage` under `pose_ref_api_key` and sent only to
`api.anthropic.com`. It is never logged or stored server-side (there is no server).

---

## Action Executor

```ts
// src/llm/ActionExecutor.ts

import { LLMResponse, LLMResponseType, ActionType } from './ActionSchema'
import { useSceneStore } from '../store/useSceneStore'

export function executeActions(rawJson: string): {
  success: boolean
  summary: string
  errors: string[]
} {
  // 1. Parse JSON
  let parsed: unknown
  try { parsed = JSON.parse(rawJson) }
  catch { return { success: false, summary: '', errors: ['LLM returned invalid JSON'] } }

  // 2. Validate against schema
  const result = LLMResponse.safeParse(parsed)
  if (!result.success) {
    return {
      success: false,
      summary: '',
      errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
    }
  }

  const { actions, summary } = result.data
  const store = useSceneStore.getState()
  const errors: string[] = []

  // 3. Execute each action
  for (const action of actions) {
    try {
      applyAction(action, store)
    } catch (e) {
      errors.push(`Failed to apply ${action.type}: ${(e as Error).message}`)
    }
  }

  return { success: errors.length === 0, summary, errors }
}

function applyAction(action: ActionType, store: ReturnType<typeof useSceneStore.getState>) {
  const resolveCharId = (id: string) =>
    id === 'active' ? store.activeCharacterId ?? store.characters[0]?.id : id

  switch (action.type) {
    case 'SET_BONE_ROTATION': {
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(action.euler.x),
          THREE.MathUtils.degToRad(action.euler.y),
          THREE.MathUtils.degToRad(action.euler.z),
          'XYZ'
        )
      )
      store.updatePose(resolveCharId(action.characterId), action.bone, q)
      break
    }
    case 'SET_IK_TARGET':
      store.setIKTarget(resolveCharId(action.characterId), action.effector, action.position)
      break
    case 'APPLY_POSE_PRESET':
      store.applyPosePreset(resolveCharId(action.characterId), action.preset)
      break
    case 'SET_CAMERA_PRESET':
      store.setCameraPreset(action.preset)
      break
    case 'SET_CAMERA_FOV':
      store.setCameraFOV(action.fov)
      break
    // ... all other cases
  }
}
```

---

## Pose Presets

Named poses are stored as bone quaternion dictionaries in `src/data/posePresets.ts`.
They are applied wholesale to a character and serve as the starting point for further
IK adjustment.

```ts
export const POSE_PRESETS: Record<string, PoseState> = {
  tpose: { /* all bones at identity */ },
  apose: { /* arms at ~45° from body */ },
  standing_neutral: {
    'spine': eulerToQuat(5, 0, 0),           // slight forward lean
    'upper_arm.L': eulerToQuat(0, 0, 30),    // arms slightly away from body
    'upper_arm.R': eulerToQuat(0, 0, -30),
    // ...
  },
  contrapposto: {
    'hips': eulerToQuat(0, 0, 8),            // hip tilt
    'spine': eulerToQuat(0, 0, -5),          // counter-rotation
    'upper_leg.L': eulerToQuat(-5, 0, 0),    // weight-bearing leg
    // ...
  },
  // ... all presets
}
```

When the LLM emits `APPLY_POSE_PRESET`, the executor looks up the preset dictionary
and calls `store.updatePose` for each bone. The user can then fine-tune with IK or
further prompts.

---

## Camera Presets

```ts
// Applied by SET_CAMERA_PRESET
export const CAMERA_PRESETS: Record<string, CameraOrbitState> = {
  front:         { azimuth: 0,    elevation: 0,  distance: 3.5 },
  back:          { azimuth: 180,  elevation: 0,  distance: 3.5 },
  left:          { azimuth: -90,  elevation: 0,  distance: 3.5 },
  right:         { azimuth: 90,   elevation: 0,  distance: 3.5 },
  top:           { azimuth: 0,    elevation: 89, distance: 4.0 },
  three_quarter: { azimuth: 45,   elevation: 15, distance: 3.5 },
  low_angle:     { azimuth: 20,   elevation: -25, distance: 3.0 },
  high_angle:    { azimuth: 20,   elevation: 45,  distance: 4.0 },
  over_shoulder: { azimuth: 150,  elevation: 10,  distance: 2.0 },
  dutch_angle:   { azimuth: 30,   elevation: 10,  distance: 3.5, roll: 15 },
}
```

---

## Conversation History + Multi-Turn

The LLM prompt input supports multi-turn conversation. Each exchange is stored in
`PromptHistory.ts` and included in subsequent API calls, enabling follow-up refinements:

```
User: "Put the character in a contrapposto pose"
LLM:  → APPLY_POSE_PRESET: contrapposto
      → summary: "Applied contrapposto pose"

User: "Raise the right arm a bit"
LLM:  (has previous context)
      → SET_IK_TARGET: hand.R, y += 0.2
      → summary: "Raised right arm slightly"

User: "Actually make it more dramatic"
LLM:  (has full history)
      → SET_IK_TARGET: hand.R, y += 0.3
      → SET_BONE_ROTATION: shoulder.R, z = -60
      → summary: "Made right arm raise more dramatic"
```

History is capped at the last 10 exchanges to stay within token limits. Earlier
exchanges are summarised and prepended as a "conversation so far" block.

```ts
// src/llm/PromptHistory.ts

interface Exchange {
  userMessage: string
  assistantJson: string
  summary: string
  timestamp: number
}

export class PromptHistory {
  private exchanges: Exchange[] = []
  private maxExchanges = 10

  add(exchange: Exchange) {
    this.exchanges.push(exchange)
    if (this.exchanges.length > this.maxExchanges) {
      this.exchanges.shift()
    }
  }

  toMessages(): { role: 'user' | 'assistant'; content: string }[] {
    return this.exchanges.flatMap(e => [
      { role: 'user' as const, content: e.userMessage },
      { role: 'assistant' as const, content: e.assistantJson },
    ])
  }

  clear() { this.exchanges = [] }
}
```

---

## PromptPanel UI

```
┌─────────────────────────────────┐
│ Scene prompt                    │
│                                 │
│ ┌───────────────────────────┐   │
│ │ User: contrapposto pose   │   │
│ │ ✓ Applied contrapposto    │   │
│ │                           │   │
│ │ User: raise right arm     │   │
│ │ ✓ Raised right arm        │   │
│ └───────────────────────────┘   │
│                                 │
│ ┌─────────────────────────┐ [↑] │
│ │ Type a pose instruction… │     │
│ └─────────────────────────┘     │
│                                 │
│ [Clear history]                 │
│                                 │
│ API key: [••••••••] [Edit]      │
└─────────────────────────────────┘
```

Status indicators:
- Spinner while waiting for API response
- Green checkmark + summary on success
- Red warning icon + error message on validation failure
- "Clarification needed" banner if LLM emits a `clarification` field

All actions are undoable via Ctrl+Z (Stage 1 undo system).

---

## Error Handling

| Error type | Behaviour |
|---|---|
| Invalid JSON from LLM | Show error, do not apply anything, ask user to rephrase |
| Schema validation failure | Show which fields failed, do not apply, log for debugging |
| Unknown character ID | Skip that action, apply others, warn in summary |
| Unknown bone name | Skip that action, apply others, warn in summary |
| API network error | Show retry button, do not modify scene |
| API auth error | Prompt user to check API key in settings |
| Rate limit (429) | Show "slow down" message, auto-retry after 5s |

---

## Privacy and API Key Handling

- API key entered once in settings panel, stored in `localStorage`
- Key is only ever sent to `api.anthropic.com` in the `x-api-key` header
- Scene state sent to the API contains only structural descriptions (bone angles,
  positions, morph weights) — no user identity, no uploaded images
- Conversation history is stored in memory only, cleared on page reload
- A "Clear history" button in PromptPanel wipes the in-memory history immediately

---

## Store Additions

```ts
// Additions to useSceneStore.ts for Stage 3

interface LLMState {
  promptHistory: PromptHistory
  apiKey: string | null            // loaded from localStorage on init
  isProcessing: boolean
  lastError: string | null
  lastSummary: string | null
}

// New actions added to store:
setIKTarget: (characterId: string, effector: string, position: Vector3Like) => void
applyPosePreset: (characterId: string, preset: string) => void
setCameraPreset: (preset: string) => void
setCameraOrbit: (azimuth: number, elevation: number, distance: number) => void
```

---

## New Files Checklist

- [ ] `src/llm/AnthropicClient.ts` — API fetch wrapper
- [ ] `src/llm/SystemPrompt.ts` — dynamic system prompt builder
- [ ] `src/llm/ActionSchema.ts` — Zod schemas for all actions
- [ ] `src/llm/ActionExecutor.ts` — validates + applies actions to store
- [ ] `src/llm/SceneSerializer.ts` — converts scene state to LLM-readable text
- [ ] `src/llm/PromptHistory.ts` — multi-turn history manager
- [ ] `src/data/posePresets.ts` — named pose quaternion dictionaries
- [ ] `src/data/cameraPresets.ts` — named camera orbit positions
- [ ] `src/components/panels/PromptPanel.tsx` — full chat UI
- [ ] Update `src/store/useSceneStore.ts` — add LLMState + new actions
- [ ] Update `src/App.tsx` — add PromptPanel to sidebar

---

## Example Prompts and Expected Outputs

```
"Put the character in a running pose"
→ APPLY_POSE_PRESET: running

"Make her look over her left shoulder"
→ SET_BONE_ROTATION: neck, y=45
→ SET_BONE_ROTATION: head, y=30

"Low angle, looking up at the figure from below"
→ SET_CAMERA_PRESET: low_angle

"Add a second character and make them face each other"
→ ADD_CHARACTER
→ SET_CHARACTER_POSITION: char1, x=-0.6, z=0
→ SET_CHARACTER_POSITION: char2, x=0.6, z=0
→ SET_CHARACTER_FACING: char1, toward=char2
→ SET_CHARACTER_FACING: char2, toward=char1

"Make the model more muscular and show the muscle layer"
→ SET_MORPH_WEIGHT: active, build=0.8
→ SET_LAYER_VISIBILITY: active, muscle=true

"Fisheye lens, turn on the two-point perspective grid"
→ SET_LENS_PRESET: fisheye
→ SET_GRID: 2point

"Tilt the camera slightly to the left for a dutch angle"
→ SET_CAMERA_PRESET: dutch_angle

"Raise the right hand above the head"
→ SET_IK_TARGET: active, hand.R, position={x:0.2, y:2.1, z:0.0}

"Mirror the pose"
→ MIRROR_POSE: active, axis=x
```

---

## Future Upgrades (Post Stage 3)

- **Voice input:** Web Speech API → text → existing prompt pipeline. No backend needed.
- **Pose description output:** User selects a pose and asks "describe this pose" —
  LLM reads the scene serialisation and returns a natural language description for
  the artist's reference notes.
- **Batch scene generation:** User provides a list of poses ("generate 5 action poses
  for a fighting character") and the LLM generates each in sequence, saving as a
  pose library.
- **Style-aware prompting:** User sets an art style context ("manga", "classical
  figure drawing", "action comic") and the LLM biases its pose and camera
  suggestions toward that aesthetic.
- **Reference image description:** User uploads a reference photo, a vision-capable
  LLM describes the pose and camera angle in terms of the action schema, and it is
  applied to the scene — a higher-accuracy alternative to Stage 2's CV detection.
