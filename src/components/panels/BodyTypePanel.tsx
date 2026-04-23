/**
 * BodyTypePanel.tsx — Morph target sliders for body proportions.
 *
 * Phase 1–3: sliders update the store but don't visually change the placeholder
 * rig. Phase 4 wires these to GLTF morph target influences.
 */

import { useSceneStore } from '../../store/useSceneStore'
import type { MorphWeights } from '../../store/useSceneStore'
import panelStyles from '../../styles/Panel.module.css'

// Slider config: key, min label, max label
const SLIDERS: { key: keyof MorphWeights; min: string; max: string }[] = [
  { key: 'build',  min: 'Lean',    max: 'Heavy' },
  { key: 'sex',    min: 'Masc',    max: 'Femme' },
  { key: 'weight', min: 'Defined', max: 'Soft'  },
]

export function BodyTypePanel() {
  const characters = useSceneStore((s) => s.characters)
  const activeId = useSceneStore((s) => s.activeCharacterId)
  const updateMorph = useSceneStore((s) => s.updateMorph)

  const active = characters.find((c) => c.id === activeId)

  if (!active) {
    return (
      <section className={panelStyles.panel}>
        <div className={panelStyles.panelHeader}>Body Type</div>
        <div className={panelStyles.panelContent} style={{ color: '#556', fontSize: 11 }}>
          Select a character
        </div>
      </section>
    )
  }

  return (
    <section className={panelStyles.panel}>
      <div className={panelStyles.panelHeader}>Body Type</div>
      <div className={panelStyles.panelContent}>
        {SLIDERS.map(({ key, min, max }) => (
          <div key={key} className={panelStyles.row}>
            <span className={panelStyles.label} style={{ fontSize: 10, color: '#6688aa' }}>
              {min}
            </span>
            <input
              type="range"
              className={panelStyles.slider}
              min={0}
              max={1}
              step={0.01}
              value={active.morphWeights[key]}
              onChange={(e) => updateMorph(active.id, key, parseFloat(e.target.value))}
            />
            <span className={panelStyles.label} style={{ fontSize: 10, color: '#6688aa', textAlign: 'right' }}>
              {max}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
