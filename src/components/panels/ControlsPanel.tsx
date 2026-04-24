/**
 * ControlsPanel.tsx — Quick-reference guide for mouse/gizmo controls.
 * Always visible at the bottom of the sidebar. No local state.
 */

import panelStyles from '../../styles/Panel.module.css'
import styles from './ControlsPanel.module.css'

const CONTROLS = [
  { label: 'Orbit', desc: 'Left drag (empty space)' },
  { label: 'Pan', desc: 'Right drag / middle drag' },
  { label: 'Zoom', desc: 'Scroll wheel' },
  { label: 'Select joint', desc: 'Click any sphere' },
  { label: 'IK drag', desc: 'Drag hand / foot sphere' },
]

const GIZMO_CONTROLS = [
  { label: 'Rotate X/Y/Z', desc: 'Drag red / green / blue ring', color: 'ring' },
  { label: 'Translate X/Y/Z', desc: 'Drag red / green / blue arrow (IK joints)', color: 'arrow' },
]

export function ControlsPanel() {
  return (
    <section className={panelStyles.panel}>
      <div className={panelStyles.panelHeader}>Controls</div>
      <div className={panelStyles.panelContent}>
        <div className={styles.group}>
          {CONTROLS.map(({ label, desc }) => (
            <div key={label} className={styles.row}>
              <span className={styles.action}>{label}</span>
              <span className={styles.desc}>{desc}</span>
            </div>
          ))}
        </div>
        <div className={styles.sectionLabel}>Transform gizmo (selected joint)</div>
        <div className={styles.group}>
          {GIZMO_CONTROLS.map(({ label, desc }) => (
            <div key={label} className={styles.row}>
              <span className={styles.action}>{label}</span>
              <span className={styles.desc}>{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
