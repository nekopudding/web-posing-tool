/**
 * PoseLibraryPanel.tsx — Save and load named pose snapshots for the whole scene.
 *
 * A saved pose captures ALL characters in the scene (poses + world transforms),
 * matched by position index when loading. If the saved snapshot has more characters
 * than the current scene, extras are ignored. If the current scene has more, the
 * extra characters are left unchanged.
 *
 * Interactions:
 *  - "Save" button (always visible) → opens save bar.
 *    - If a card was last loaded (activePoseId set): Overwrite / Save Copy / cancel.
 *    - Otherwise: name input + Save / cancel.
 *  - Click a card → load that snapshot onto current characters (pushes undo history).
 *  - Hover a card → ✕ icon appears; click it → delete confirmation dialog.
 *  - "New Scene" button → confirmation dialog → wipes scene to one default character.
 */

import { useState, useCallback } from 'react'
import { useSceneStore, type PoseState } from '../../store/useSceneStore'
import panelStyles from '../../styles/Panel.module.css'
import styles from '../../styles/PoseLibraryPanel.module.css'

const LIBRARY_KEY = 'pose-tool-scenes'

interface ScenePoseEntry {
  pose: PoseState
  worldPosition: { x: number; y: number; z: number }
  worldRotation: number
}

interface SavedPose {
  id: string
  name: string
  /** One entry per character, ordered by index in the scene at save time. */
  entries: ScenePoseEntry[]
  savedAt: number
}

function loadLibrary(): SavedPose[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as SavedPose[]
      // Guard against old format (pre-multi-character) that had `pose` instead of `entries`.
      if (Array.isArray(parsed) && parsed.every((p) => Array.isArray(p.entries))) return parsed
    }
  } catch {
    // ignore
  }
  return []
}

function persistLibrary(poses: SavedPose[]): void {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(poses))
  } catch {
    // ignore quota errors
  }
}

export function PoseLibraryPanel() {
  const characters = useSceneStore((s) => s.characters)
  const resetScene = useSceneStore((s) => s.resetScene)

  const [poses, setPoses] = useState<SavedPose[]>(loadLibrary)
  /** ID of the most recently loaded or saved pose — enables Overwrite button. */
  const [activePoseId, setActivePoseId] = useState<string | null>(null)
  /** ID of the pose pending deletion (drives delete confirmation dialog). */
  const [deleteId, setDeleteId] = useState<string | null>(null)
  /** Whether to show the new-scene confirmation dialog. */
  const [newSceneConfirm, setNewSceneConfirm] = useState(false)
  /** Whether the save bar is open. */
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')

  const updatePoses = useCallback((next: SavedPose[]) => {
    setPoses(next)
    persistLibrary(next)
  }, [])

  // ---- Load ----------------------------------------------------------------

  const handleLoad = useCallback((p: SavedPose) => {
    const store = useSceneStore.getState()
    store.pushHistory()

    // Step 1: adjust character count to match the snapshot.
    // Read fresh state after each add/remove since UUIDs are assigned inside the store.
    const needed = p.entries.length
    let current = useSceneStore.getState().characters

    // Add characters until we have enough (capped by MAX_CHARACTERS internally).
    for (let i = current.length; i < needed; i++) {
      store.addCharacter()
    }

    // Remove characters from the end if we have too many.
    current = useSceneStore.getState().characters
    for (let i = current.length - 1; i >= needed; i--) {
      store.removeCharacter(current[i].id)
    }

    // Step 2: apply poses using the final, up-to-date character list.
    const final = useSceneStore.getState().characters
    p.entries.forEach((entry, i) => {
      const char = final[i]
      if (!char) return
      store.setBulkPose(char.id, entry.pose)
      store.setWorldPosition(char.id, entry.worldPosition)
      store.setWorldRotation(char.id, entry.worldRotation)
    })

    setActivePoseId(p.id)
  }, []) // no deps — reads store directly each time

  // ---- Save bar open -------------------------------------------------------

  const handleSaveOpen = () => {
    const existing = activePoseId ? poses.find((p) => p.id === activePoseId) : null
    setSaveName(existing?.name ?? '')
    setSaveOpen(true)
  }

  // ---- Capture current scene -----------------------------------------------

  const captureEntries = useCallback((): ScenePoseEntry[] =>
    characters.map((c) => ({
      pose: { ...c.pose },
      worldPosition: { ...c.worldPosition },
      worldRotation: c.worldRotation,
    })), [characters])

  // ---- Save as new ---------------------------------------------------------

  const handleSaveNew = useCallback(() => {
    if (!saveName.trim()) return
    const entry: SavedPose = {
      id: crypto.randomUUID(),
      name: saveName.trim(),
      entries: captureEntries(),
      savedAt: Date.now(),
    }
    const next = [entry, ...poses]
    updatePoses(next)
    setActivePoseId(entry.id)
    setSaveOpen(false)
    console.log('[PoseLibrary] Saved new scene:', entry)
  }, [saveName, captureEntries, poses, updatePoses])

  // ---- Overwrite existing --------------------------------------------------

  const handleOverwrite = useCallback(() => {
    if (!activePoseId) return
    const updated: Partial<SavedPose> = {
      name: saveName.trim() || poses.find((p) => p.id === activePoseId)?.name,
      entries: captureEntries(),
      savedAt: Date.now(),
    }
    const next = poses.map((p) =>
      p.id === activePoseId ? { ...p, ...updated } : p
    )
    updatePoses(next)
    setSaveOpen(false)
    console.log('[PoseLibrary] Overwrote scene:', next.find((p) => p.id === activePoseId))
  }, [activePoseId, saveName, captureEntries, poses, updatePoses])

  // ---- Delete --------------------------------------------------------------

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteId) return
    const next = poses.filter((p) => p.id !== deleteId)
    updatePoses(next)
    if (activePoseId === deleteId) setActivePoseId(null)
    setDeleteId(null)
  }, [deleteId, poses, activePoseId, updatePoses])

  // ---- New scene -----------------------------------------------------------

  const handleNewScene = useCallback(() => {
    setNewSceneConfirm(false)
    setActivePoseId(null)
    setSaveOpen(false)
    resetScene()
  }, [resetScene])

  const poseToDelete = poses.find((p) => p.id === deleteId)
  const existingActive = activePoseId ? poses.find((p) => p.id === activePoseId) : null

  return (
    <section className={panelStyles.panel} style={{ position: 'relative' }}>
      <div className={panelStyles.panelHeader}>
        Scenes
        <div className={styles.headerBtns}>
          <button className={styles.newSceneBtn} onClick={() => setNewSceneConfirm(true)}>
            New
          </button>
          <button className={styles.saveBtn} onClick={handleSaveOpen}>
            Save
          </button>
        </div>
      </div>

      {/* ── Save bar ── */}
      {saveOpen && (
        <div className={styles.saveBar}>
          <input
            className={styles.saveInput}
            type="text"
            placeholder="Scene name…"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveNew()
              if (e.key === 'Escape') setSaveOpen(false)
            }}
            autoFocus
          />
          <div className={styles.saveBtns}>
            {existingActive && (
              <button className={styles.btnOverwrite} onClick={handleOverwrite}>
                Overwrite
              </button>
            )}
            <button
              className={styles.btnSaveNew}
              onClick={handleSaveNew}
              disabled={!saveName.trim()}
            >
              {existingActive ? 'Save Copy' : 'Save'}
            </button>
            <button className={styles.btnCancel} onClick={() => setSaveOpen(false)}>
              ✕
            </button>
          </div>
        </div>
      )}

      {/* ── Pose grid ── */}
      <div className={panelStyles.panelContent}>
        {poses.length === 0 ? (
          <div className={styles.empty}>No saved scenes</div>
        ) : (
          <div className={styles.grid}>
            {poses.map((p) => (
              <div
                key={p.id}
                className={`${styles.card} ${p.id === activePoseId ? styles.cardActive : ''}`}
                onClick={() => handleLoad(p)}
              >
                <button
                  className={styles.trashBtn}
                  onClick={(e) => { e.stopPropagation(); setDeleteId(p.id) }}
                  title="Delete"
                >
                  ✕
                </button>
                <div className={styles.cardName}>{p.name}</div>
                <div className={styles.cardDate}>
                  {p.entries.length > 1 && (
                    <span className={styles.cardChars}>{p.entries.length}chr · </span>
                  )}
                  {new Date(p.savedAt).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Delete confirmation dialog ── */}
      {deleteId && (
        <div className={styles.dialogOverlay}>
          <div className={styles.dialog}>
            <div className={styles.dialogMsg}>
              Delete <strong>"{poseToDelete?.name}"</strong>?
            </div>
            <div className={styles.dialogBtns}>
              <button className={styles.btnDialogCancel} onClick={() => setDeleteId(null)}>
                Cancel
              </button>
              <button className={styles.btnDialogDelete} onClick={handleDeleteConfirm}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── New scene confirmation dialog ── */}
      {newSceneConfirm && (
        <div className={styles.dialogOverlay}>
          <div className={styles.dialog}>
            <div className={styles.dialogMsg}>
              Start a new scene? All unsaved poses will be lost.
            </div>
            <div className={styles.dialogBtns}>
              <button className={styles.btnDialogCancel} onClick={() => setNewSceneConfirm(false)}>
                Cancel
              </button>
              <button className={styles.btnDialogDelete} onClick={handleNewScene}>
                New Scene
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
