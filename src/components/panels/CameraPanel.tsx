/**
 * CameraPanel.tsx — FOV slider, lens presets, and camera reset.
 *
 * FOV (Field of View) controls how "wide" or "telephoto" the camera appears.
 * Common photography equivalents (35mm full frame):
 *   24mm ≈ 84° FOV — wide angle, visible perspective distortion
 *   50mm ≈ 47° FOV — "natural" perspective, closest to human eye
 *   85mm ≈ 29° FOV — telephoto, flatters portraits, compresses depth
 *
 * Orthographic camera presets are useful for reference drawings:
 *   - Front/side/top views eliminate perspective distortion entirely.
 *   - These lock rotation but allow pan and zoom.
 */

import { useSceneStore } from '../../store/useSceneStore'
import type { CameraPreset } from '../../store/useSceneStore'
import panelStyles from '../../styles/Panel.module.css'

// Lens presets: label → FOV in degrees (approximate full-frame equivalents)
const LENS_PRESETS: { label: string; fov: number }[] = [
  { label: '24mm', fov: 84 },
  { label: '50mm', fov: 47 },
  { label: '85mm', fov: 29 },
]

const CAM_PRESETS: { label: string; preset: CameraPreset }[] = [
  { label: 'Persp', preset: 'perspective'  },
  { label: 'Front', preset: 'ortho-front'  },
  { label: 'Side',  preset: 'ortho-side'   },
  { label: 'Top',   preset: 'ortho-top'    },
]

export function CameraPanel() {
  const fov = useSceneStore((s) => s.camera.fov)
  const preset = useSceneStore((s) => s.camera.preset)
  const setCameraFov = useSceneStore((s) => s.setCameraFov)
  const setCameraPreset = useSceneStore((s) => s.setCameraPreset)

  return (
    <section className={panelStyles.panel}>
      <div className={panelStyles.panelHeader}>Camera</div>
      <div className={panelStyles.panelContent}>

        {/* FOV slider — only meaningful for perspective camera */}
        {preset === 'perspective' && (
          <>
            <div className={panelStyles.row}>
              <span className={panelStyles.label}>FOV</span>
              <input
                type="range"
                className={panelStyles.slider}
                min={10}
                max={120}
                step={1}
                value={fov}
                onChange={(e) => setCameraFov(parseInt(e.target.value, 10))}
              />
              <span style={{ fontSize: 11, color: '#8888aa', minWidth: 28, textAlign: 'right' }}>
                {fov}°
              </span>
            </div>

            {/* Lens preset buttons */}
            <div className={panelStyles.row}>
              <span className={panelStyles.label}>Lens</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {LENS_PRESETS.map(({ label, fov: presetFov }) => (
                  <button
                    key={label}
                    className={`${panelStyles.btnSmall} ${fov === presetFov ? panelStyles.btnSmallActive : ''}`}
                    onClick={() => setCameraFov(presetFov)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Camera view preset buttons */}
        <div className={panelStyles.row}>
          <span className={panelStyles.label}>View</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {CAM_PRESETS.map(({ label, preset: p }) => (
              <button
                key={p}
                className={`${panelStyles.btnSmall} ${preset === p ? panelStyles.btnSmallActive : ''}`}
                onClick={() => setCameraPreset(p)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

      </div>
    </section>
  )
}
