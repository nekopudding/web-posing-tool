/**
 * GridOverlay.ts — Ground grid and axes indicator for the viewport.
 *
 * Uses Three.js built-in helpers:
 *   - GridHelper: XZ-plane grid centered at origin
 *   - AxesHelper: RGB XYZ axis arrows at origin
 *
 * Toggled via the ViewportPanel "Grid" checkbox, which calls setVisible().
 */

import * as THREE from 'three'

export class GridOverlay {
  private gridHelper: THREE.GridHelper
  private axesHelper: THREE.AxesHelper

  /**
   * @param scene     The Three.js scene to add helpers to.
   * @param size      Total grid extent in world units (default: 10 = 5 units each side).
   * @param divisions Number of grid cells per side (default: 20).
   */
  constructor(scene: THREE.Scene, size = 10, divisions = 20) {
    // Grid lines — dark blue-grey tones that read well on the dark background.
    // centerLineColor: the two center lines (X and Z axes) drawn slightly lighter.
    // gridColor: all other grid lines.
    this.gridHelper = new THREE.GridHelper(size, divisions, 0x3a3a5c, 0x252540)
    this.gridHelper.position.y = 0 // sits on the ground plane (y=0)

    // Small colored axis arrows at origin: red=X, green=Y, blue=Z.
    this.axesHelper = new THREE.AxesHelper(0.5)

    scene.add(this.gridHelper)
    scene.add(this.axesHelper)
  }

  /** Show or hide the grid and axes. */
  setVisible(v: boolean): void {
    this.gridHelper.visible = v
    this.axesHelper.visible = v
  }

  /** Remove helpers from scene and release geometry/material resources. */
  dispose(scene: THREE.Scene): void {
    scene.remove(this.gridHelper)
    scene.remove(this.axesHelper)
    this.gridHelper.geometry.dispose()
    ;(this.gridHelper.material as THREE.Material).dispose()
    this.axesHelper.geometry.dispose()
    ;(this.axesHelper.material as THREE.Material | THREE.Material[]).valueOf()
  }
}
