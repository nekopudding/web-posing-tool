/**
 * LayerPanel.tsx — Toggle mesh layer visibility per character.
 *
 * Phase 1–3: toggles CharacterManager.setLayerVisibility which shows/hides
 * the whole rig group. Phase 4 separates skin, muscle, and bone into distinct
 * SkinnedMesh objects so they can be toggled independently.
 */

import { useSceneStore } from '../../store/useSceneStore'
import type { LayerVisibility } from '../../store/useSceneStore'
import panelStyles from '../../styles/Panel.module.css'

const LAYERS: { key: keyof LayerVisibility; label: string }[] = [
  { key: 'skin',   label: 'Skin'   },
  { key: 'muscle', label: 'Muscle' },
  { key: 'bone',   label: 'Bone'   },
]

export function LayerPanel() {
  const characters = useSceneStore((s) => s.characters)
  const activeId = useSceneStore((s) => s.activeCharacterId)
  const updateLayer = useSceneStore((s) => s.updateLayer)

  const active = characters.find((c) => c.id === activeId)

  if (!active) {
    return (
      <section className={panelStyles.panel}>
        <div className={panelStyles.panelHeader}>Layers</div>
        <div className={panelStyles.panelContent} style={{ color: '#556', fontSize: 11 }}>
          Select a character
        </div>
      </section>
    )
  }

  return (
    <section className={panelStyles.panel}>
      <div className={panelStyles.panelHeader}>Layers</div>
      <div className={panelStyles.panelContent}>
        {LAYERS.map(({ key, label }) => (
          <div key={key} className={panelStyles.checkRow}>
            <input
              type="checkbox"
              id={`layer-${key}`}
              checked={active.layerVisibility[key]}
              onChange={(e) => updateLayer(active.id, key, e.target.checked)}
            />
            <label htmlFor={`layer-${key}`}>{label}</label>
          </div>
        ))}
      </div>
    </section>
  )
}
