/**
 * useSceneStore.ts — Zustand store, single source of truth for all scene state.
 *
 * Design rules:
 *  - ONLY serializable data lives here (no Three.js objects, no DOM refs).
 *  - Quaternions are stored as plain {x,y,z,w} objects, not THREE.Quaternion.
 *  - Three.js reads from this store via subscriptions (see ViewportCanvas.tsx),
 *    not via React renders, so pose updates at 60fps don't trigger React re-renders.
 *  - The `subscribeWithSelector` middleware is required for `store.subscribe(selector, fn)`.
 */

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { BONE_NAMES } from '../three/IKChains'

// ---------------------------------------------------------------------------
// Serializable quaternion — stores bone orientation.
// x, y, z are the vector (imaginary) components; w is the scalar component.
// Identity quaternion (no rotation) = { x:0, y:0, z:0, w:1 }.
// ---------------------------------------------------------------------------
export interface SerializedQuaternion {
  x: number
  y: number
  z: number
  /** Scalar component of the quaternion. Range [-1, 1]. w=1 means no rotation. */
  w: number
}

// ---------------------------------------------------------------------------
// PoseState — maps bone name → quaternion for a single character.
// Keys are values from BONE_NAMES (e.g. "upper_arm.L", "foot.R").
// ---------------------------------------------------------------------------
export type PoseState = Record<string, SerializedQuaternion>

// ---------------------------------------------------------------------------
// MorphWeights — body shape blend parameters.
// All values are normalized 0–1 and map directly to GLTF morph target influences
// in Phase 4. For Phase 1–3 the placeholder rig ignores these, but the store
// already tracks them so panels work immediately.
// ---------------------------------------------------------------------------
export interface MorphWeights {
  /** 0 = lean / thin build, 1 = heavy / muscular build */
  build: number
  /** 0 = masculine proportions, 1 = feminine proportions */
  sex: number
  /** 0 = defined / low body fat, 1 = soft / high body fat */
  weight: number
}

// ---------------------------------------------------------------------------
// LayerVisibility — which mesh layers are shown for a character.
// In Phase 1–3 these are stubs (whole rig toggles). Phase 4 wires them to
// separate SkinnedMesh objects inside the loaded GLTF.
// ---------------------------------------------------------------------------
export interface LayerVisibility {
  skin: boolean
  muscle: boolean
  bone: boolean
}

// ---------------------------------------------------------------------------
// Character — all per-character state.
// ---------------------------------------------------------------------------
export interface Character {
  /** UUID generated at creation — used as React key and Three.js lookup key. */
  id: string
  /** Display name shown in the roster. Editable in Phase 5. */
  name: string
  /**
   * Full pose snapshot — one quaternion per bone.
   * Written by GizmoController on pointerup (not every frame).
   * Three.js reads via Zustand subscription, not React.
   */
  pose: PoseState
  morphWeights: MorphWeights
  layerVisibility: LayerVisibility
  /**
   * World-space position of the character root (hips joint).
   * Used to place multiple characters apart in the scene.
   */
  worldPosition: { x: number; y: number; z: number }
  /**
   * Y-axis rotation of the whole character in radians.
   * 0 = facing +Z. Positive = counter-clockwise when viewed from above.
   */
  worldRotation: number
}

// ---------------------------------------------------------------------------
// CameraState
// ---------------------------------------------------------------------------
export type CameraPreset = 'perspective' | 'ortho-front' | 'ortho-side' | 'ortho-top'

export interface CameraState {
  /** Vertical field of view in degrees. Range 10–120. Default 50. */
  fov: number
  /**
   * Active camera preset. 'perspective' uses a free-orbit PerspectiveCamera.
   * Ortho presets lock the camera to a fixed axis and disable rotation.
   */
  preset: CameraPreset
}

// ---------------------------------------------------------------------------
// ViewportState
// ---------------------------------------------------------------------------
export interface ViewportState {
  gridEnabled: boolean
  /** Outline expansion thickness in world units. Range 0.005–0.025. */
  outlineThickness: number
  /** CSS color string for the renderer's clear color. */
  backgroundColor: string
}

// ---------------------------------------------------------------------------
// Full store interface — state + actions
// ---------------------------------------------------------------------------
export interface SceneState {
  characters: Character[]
  /** ID of the currently selected character, or null if none. */
  activeCharacterId: string | null
  /**
   * Name of the currently selected bone within the active character, or null.
   * Drives the yellow joint highlight and determines which gizmo to show.
   * Cleared automatically when `selectCharacter` is called.
   */
  selectedBoneName: string | null
  camera: CameraState
  viewport: ViewportState

  // --- Character actions ---
  addCharacter: () => void
  removeCharacter: (id: string) => void
  selectCharacter: (id: string | null) => void
  /** Select a specific bone within the active character. */
  selectBone: (boneName: string | null) => void

  // --- Pose actions ---
  /** Called by GizmoController on pointerup to write the final solved pose. */
  updatePose: (characterId: string, boneName: string, q: SerializedQuaternion) => void
  /** Resets the active character to T-pose (all identity quaternions). */
  resetPose: (characterId: string) => void

  // --- Body type actions ---
  updateMorph: (characterId: string, key: keyof MorphWeights, value: number) => void

  // --- Layer actions ---
  updateLayer: (characterId: string, layer: keyof LayerVisibility, value: boolean) => void

  // --- World transform actions ---
  setWorldPosition: (characterId: string, pos: { x: number; y: number; z: number }) => void
  setWorldRotation: (characterId: string, radians: number) => void

  // --- Camera actions ---
  setCameraFov: (fov: number) => void
  setCameraPreset: (preset: CameraPreset) => void

  // --- Viewport actions ---
  setGridEnabled: (v: boolean) => void
  setOutlineThickness: (v: number) => void
  setBackgroundColor: (color: string) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of characters allowed in a scene (performance cap). */
export const MAX_CHARACTERS = 6

/** Default camera FOV in degrees. Roughly equivalent to a 50mm lens. */
const DEFAULT_FOV = 50

/** Factory: create an identity PoseState (all bones at rest / T-pose). */
function makeIdentityPose(): PoseState {
  const pose: PoseState = {}
  for (const name of BONE_NAMES) {
    pose[name] = { x: 0, y: 0, z: 0, w: 1 }
  }
  return pose
}

/** Factory: create a new Character with default values. */
function makeCharacter(index: number): Character {
  return {
    id: crypto.randomUUID(),
    name: `Character ${index + 1}`,
    pose: makeIdentityPose(),
    morphWeights: { build: 0.5, sex: 0.5, weight: 0.5 },
    layerVisibility: { skin: true, muscle: false, bone: true },
    // Spread characters 1.5 units apart along X so they don't overlap.
    worldPosition: { x: index * 1.5, y: 0, z: 0 },
    worldRotation: 0,
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSceneStore = create<SceneState>()(
  subscribeWithSelector((set, _get) => ({
    // Initial state — one character already in the scene
    characters: [makeCharacter(0)],
    activeCharacterId: null,
    selectedBoneName: null,
    camera: {
      fov: DEFAULT_FOV,
      preset: 'perspective',
    },
    viewport: {
      gridEnabled: true,
      outlineThickness: 0.012,
      backgroundColor: '#1a1a2e',
    },

    // ---- Character actions ----

    addCharacter: () =>
      set((state) => {
        if (state.characters.length >= MAX_CHARACTERS) return state
        const newChar = makeCharacter(state.characters.length)
        return { characters: [...state.characters, newChar] }
      }),

    removeCharacter: (id) =>
      set((state) => {
        const filtered = state.characters.filter((c) => c.id !== id)
        // If the removed character was active, deselect
        const newActive =
          state.activeCharacterId === id ? null : state.activeCharacterId
        return { characters: filtered, activeCharacterId: newActive }
      }),

    // Selecting a different character clears the per-bone selection.
    selectCharacter: (id) => set({ activeCharacterId: id, selectedBoneName: null }),

    selectBone: (boneName) => set({ selectedBoneName: boneName }),

    // ---- Pose actions ----

    updatePose: (characterId, boneName, q) =>
      set((state) => ({
        characters: state.characters.map((c) =>
          c.id === characterId
            ? { ...c, pose: { ...c.pose, [boneName]: q } }
            : c
        ),
      })),

    resetPose: (characterId) =>
      set((state) => ({
        characters: state.characters.map((c) =>
          c.id === characterId ? { ...c, pose: makeIdentityPose() } : c
        ),
      })),

    // ---- Body type actions ----

    updateMorph: (characterId, key, value) =>
      set((state) => ({
        characters: state.characters.map((c) =>
          c.id === characterId
            ? { ...c, morphWeights: { ...c.morphWeights, [key]: value } }
            : c
        ),
      })),

    // ---- Layer actions ----

    updateLayer: (characterId, layer, value) =>
      set((state) => ({
        characters: state.characters.map((c) =>
          c.id === characterId
            ? { ...c, layerVisibility: { ...c.layerVisibility, [layer]: value } }
            : c
        ),
      })),

    // ---- World transform actions ----

    setWorldPosition: (characterId, pos) =>
      set((state) => ({
        characters: state.characters.map((c) =>
          c.id === characterId ? { ...c, worldPosition: pos } : c
        ),
      })),

    setWorldRotation: (characterId, radians) =>
      set((state) => ({
        characters: state.characters.map((c) =>
          c.id === characterId ? { ...c, worldRotation: radians } : c
        ),
      })),

    // ---- Camera actions ----

    setCameraFov: (fov) =>
      set((state) => ({ camera: { ...state.camera, fov } })),

    setCameraPreset: (preset) =>
      set((state) => ({ camera: { ...state.camera, preset } })),

    // ---- Viewport actions ----

    setGridEnabled: (gridEnabled) =>
      set((state) => ({ viewport: { ...state.viewport, gridEnabled } })),

    setOutlineThickness: (outlineThickness) =>
      set((state) => ({ viewport: { ...state.viewport, outlineThickness } })),

    setBackgroundColor: (backgroundColor) =>
      set((state) => ({ viewport: { ...state.viewport, backgroundColor } })),
  }))
)
