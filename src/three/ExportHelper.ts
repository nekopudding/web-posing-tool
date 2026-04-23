/**
 * ExportHelper.ts — PNG and pose JSON export utilities.
 *
 * Phase 5 stub — the interface is defined now so panels can reference it,
 * but the actual implementations are filled in during Phase 5.
 *
 * PNG export relies on `preserveDrawingBuffer: true` set on the WebGLRenderer
 * in SceneManager — without this, the canvas is cleared after each frame and
 * toBlob() would return a blank image.
 */

import * as THREE from 'three'
import type { Character } from '../store/useSceneStore'

export class ExportHelper {
  /**
   * Export the current viewport as a PNG file download.
   * The renderer must have been created with `preserveDrawingBuffer: true`.
   *
   * @param renderer  The active WebGLRenderer.
   * @param filename  Optional download filename (without extension).
   */
  exportPNG(renderer: THREE.WebGLRenderer, filename = 'pose-ref'): void {
    renderer.domElement.toBlob((blob) => {
      if (!blob) {
        console.error('[ExportHelper] Canvas toBlob returned null — is preserveDrawingBuffer enabled?')
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${filename}.png`
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  /**
   * Copy the current viewport to the clipboard as a PNG image.
   * Requires the Clipboard API (Chrome 66+, Firefox 87+).
   * Falls back to exportPNG if the Clipboard API is unavailable.
   */
  async copyToClipboard(renderer: THREE.WebGLRenderer): Promise<void> {
    if (!navigator.clipboard || !window.ClipboardItem) {
      console.warn('[ExportHelper] Clipboard API not available — falling back to PNG download.')
      this.exportPNG(renderer, 'pose-ref-clipboard')
      return
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      renderer.domElement.toBlob(resolve, 'image/png')
    )
    if (!blob) return

    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ])
    } catch (err) {
      console.error('[ExportHelper] Clipboard write failed:', err)
    }
  }

  /**
   * Export all character poses as a JSON file.
   * The JSON contains an array of Character objects (serializable — no Three.js refs).
   * Can be re-imported via importPoseJSON.
   */
  exportPoseJSON(characters: Character[], filename = 'poses'): void {
    const json = JSON.stringify(characters, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${filename}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  /**
   * Parse a previously exported pose JSON file.
   * Returns the Character array on success, or null on parse error.
   *
   * Phase 5: caller should validate the schema and call store actions to apply.
   */
  importPoseJSON(file: File): Promise<Character[] | null> {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target?.result as string) as Character[]
          resolve(Array.isArray(parsed) ? parsed : null)
        } catch {
          console.error('[ExportHelper] Failed to parse pose JSON')
          resolve(null)
        }
      }
      reader.readAsText(file)
    })
  }
}
