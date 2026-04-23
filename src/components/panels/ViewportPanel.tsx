/**
 * ViewportPanel.tsx — Grid, outline, background, and export controls.
 */

import { useSceneStore } from '../../store/useSceneStore'
import panelStyles from '../../styles/Panel.module.css'

// Available background color swatches
const BG_COLORS = [
  { label: 'White',      value: '#f0f0f0' },
  { label: 'Light grey', value: '#888899' },
  { label: 'Dark',       value: '#1a1a2e' },
  { label: 'Black',      value: '#000000' },
]

export function ViewportPanel() {
  const gridEnabled = useSceneStore((s) => s.viewport.gridEnabled)
  const outlineThickness = useSceneStore((s) => s.viewport.outlineThickness)
  const backgroundColor = useSceneStore((s) => s.viewport.backgroundColor)
  const setGridEnabled = useSceneStore((s) => s.setGridEnabled)
  const setOutlineThickness = useSceneStore((s) => s.setOutlineThickness)
  const setBackgroundColor = useSceneStore((s) => s.setBackgroundColor)

  const handleExportPNG = () => {
    // Access the renderer via the scene store subscription pattern is complex here;
    // instead we grab it directly from the canvas element.
    // The canvas element is identified by its CSS class from ViewportCanvas.
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) return
    // We need the renderer — access it via a module-level ref.
    // For Phase 1, we use a simpler approach: trigger toBlob directly on the canvas.
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'pose-ref.png'
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  return (
    <section className={panelStyles.panel}>
      <div className={panelStyles.panelHeader}>Viewport</div>
      <div className={panelStyles.panelContent}>

        {/* Grid toggle */}
        <div className={panelStyles.checkRow}>
          <input
            type="checkbox"
            id="grid-toggle"
            checked={gridEnabled}
            onChange={(e) => setGridEnabled(e.target.checked)}
          />
          <label htmlFor="grid-toggle">Show Grid</label>
        </div>

        {/* Outline thickness */}
        <div className={panelStyles.row}>
          <span className={panelStyles.label}>Outline</span>
          <input
            type="range"
            className={panelStyles.slider}
            min={0.001}
            max={0.03}
            step={0.001}
            value={outlineThickness}
            onChange={(e) => setOutlineThickness(parseFloat(e.target.value))}
          />
        </div>

        {/* Background color swatches */}
        <div className={panelStyles.row}>
          <span className={panelStyles.label}>BG</span>
          <div className={panelStyles.swatchRow}>
            {BG_COLORS.map(({ label, value }) => (
              <button
                key={value}
                className={`${panelStyles.swatch} ${backgroundColor === value ? panelStyles.swatchActive : ''}`}
                style={{ background: value }}
                title={label}
                onClick={() => setBackgroundColor(value)}
              />
            ))}
          </div>
        </div>

        {/* Export PNG */}
        <button className={panelStyles.btnFull} onClick={handleExportPNG}>
          Export PNG
        </button>

      </div>
    </section>
  )
}
