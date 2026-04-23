/**
 * OutlineMaterial.ts — Inverted hull outline shader.
 *
 * ============================================================================
 * TECHNIQUE: Inverted Hull (Back-Face Expansion)
 * ============================================================================
 *
 * The outline is rendered by drawing the mesh a second time with:
 *   1. `side = THREE.BackSide` — only back faces are drawn; the front-face
 *      mesh behind it shows through, creating the illusion of an outline.
 *   2. Vertex positions are expanded along their normals in the vertex shader
 *      by `outlineThickness` world units. This "inflates" the mesh just enough
 *      so the back faces peek out around the silhouette of the front-face mesh.
 *
 * Why this technique?
 *  - No post-processing required (no render targets, no screen-space edge detect).
 *  - Works correctly at any zoom level (the outline is in world units, so it
 *    scales with distance — you can reduce thickness for distant characters).
 *  - Cheap: one extra draw call per character, same geometry, different material.
 *
 * Limitation: outline thickness is uniform. Edges facing the camera look thicker
 * than silhouette edges at oblique angles. For a stylized pose reference tool
 * this is acceptable; post-processing would be needed for uniform screen-space width.
 *
 * Usage in CharacterManager:
 *   For each bone segment mesh, clone it and add an outline mesh as a sibling:
 *     const outlineMesh = new THREE.Mesh(geometry, createOutlineMaterial())
 *     outlineMesh.renderOrder = -1  // draw outline first (behind the fill mesh)
 *     parent.add(outlineMesh)
 */

import * as THREE from 'three'

/**
 * Creates a ShaderMaterial that renders the mesh as an inverted hull outline.
 *
 * @param color     Outline color as a hex number (default: black).
 * @param thickness World-space expansion distance (default: 0.012 units).
 */
export function createOutlineMaterial(
  color: number = 0x000000,
  thickness: number = 0.012
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    // Back faces only — the "hull" is the back of the inflated mesh.
    side: THREE.BackSide,

    uniforms: {
      outlineThickness: { value: thickness },
      outlineColor: { value: new THREE.Color(color) },
    },

    vertexShader: /* glsl */ `
      uniform float outlineThickness;

      void main() {
        // Expand each vertex outward along its surface normal.
        // This inflates the mesh so back faces become visible around the silhouette.
        // Normal is in object space here; modelViewMatrix transforms it to view space.
        vec3 expandedPosition = position + normal * outlineThickness;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(expandedPosition, 1.0);
      }
    `,

    fragmentShader: /* glsl */ `
      uniform vec3 outlineColor;

      void main() {
        gl_FragColor = vec4(outlineColor, 1.0);
      }
    `,
  })
}

/**
 * Update the outline thickness uniform on an existing material.
 * Call this when the user changes the outline slider in ViewportPanel.
 */
export function setOutlineThickness(
  material: THREE.ShaderMaterial,
  thickness: number
): void {
  material.uniforms.outlineThickness.value = thickness
}

/**
 * Update the outline color uniform on an existing material.
 */
export function setOutlineColor(
  material: THREE.ShaderMaterial,
  color: number | string
): void {
  material.uniforms.outlineColor.value.set(color)
}
