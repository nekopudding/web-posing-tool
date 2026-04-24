/**
 * CharacterRoster.tsx — Add, select, and remove characters in the scene.
 *
 * Limit: MAX_CHARACTERS (6) per scene for performance.
 * The "Add" button is hidden when the limit is reached.
 */

import { useSceneStore, MAX_CHARACTERS } from '../../store/useSceneStore'
import panelStyles from '../../styles/Panel.module.css'
import styles from '../../styles/CharacterRoster.module.css'

export function CharacterRoster() {
  const characters = useSceneStore((s) => s.characters)
  const activeId = useSceneStore((s) => s.activeCharacterId)
  const addCharacter = useSceneStore((s) => s.addCharacter)
  const removeCharacter = useSceneStore((s) => s.removeCharacter)
  const selectCharacter = useSceneStore((s) => s.selectCharacter)
  const resetPose = useSceneStore((s) => s.resetPose)

  return (
    <section className={panelStyles.panel}>
      <div className={panelStyles.panelHeader}>
        Characters
        <span style={{ color: 'var(--text-dim)' }}>{characters.length}/{MAX_CHARACTERS}</span>
      </div>
      <div className={panelStyles.panelContent}>
        <div className={styles.list}>
          {characters.map((c) => (
            <div
              key={c.id}
              className={`${styles.card} ${c.id === activeId ? styles.cardActive : ''}`}
              onClick={() => selectCharacter(c.id)}
            >
              <span className={styles.cardName}>{c.name}</span>
              {/* Reset pose button */}
              <button
                className={styles.btnReset}
                title="Reset pose to T-pose"
                onClick={(e) => {
                  e.stopPropagation()
                  resetPose(c.id)
                }}
              >
                ↺
              </button>
              {/* Remove character — only show if more than 1 character */}
              {characters.length > 1 && (
                <button
                  className={styles.btnDelete}
                  title="Remove character"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeCharacter(c.id)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
        {characters.length < MAX_CHARACTERS && (
          <button className={panelStyles.btnFull} onClick={addCharacter}>
            + Add Character
          </button>
        )}
      </div>
    </section>
  )
}
