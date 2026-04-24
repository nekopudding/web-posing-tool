import { ViewportCanvas } from './components/ViewportCanvas'
import { CharacterRoster } from './components/panels/CharacterRoster'
import { BodyTypePanel } from './components/panels/BodyTypePanel'
import { LayerPanel } from './components/panels/LayerPanel'
import { CameraPanel } from './components/panels/CameraPanel'
import { ViewportPanel } from './components/panels/ViewportPanel'
import { ControlsPanel } from './components/panels/ControlsPanel'
import styles from './styles/App.module.css'

/**
 * App.tsx — Root layout.
 *
 * Two-column layout:
 *   Left:  Three.js viewport (flex: 1, takes all remaining width)
 *   Right: Sidebar with stacked panels (300px fixed)
 *
 * No state lives in App — everything is in the Zustand store.
 */
function App() {
  return (
    <div className={styles.appRoot}>
      <div className={styles.viewportArea}>
        <ViewportCanvas />
      </div>
      <aside className={styles.sidebar}>
        <CharacterRoster />
        <BodyTypePanel />
        <LayerPanel />
        <CameraPanel />
        <ViewportPanel />
        <ControlsPanel />
      </aside>
    </div>
  )
}

export default App
