import * as THREE from 'three'

/**
 * Small shader patches on top of three's built-in materials. They keep the
 * stock lighting / shadow code paths (cheap and robust on mobile GPUs) and only
 * add the sci-fi touches: neon self-glow, fresnel rims, and anti-aliased grids.
 */

/** Neon body material: instance colour feeds a faint self-glow plus a fresnel rim. */
export function createShapeMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.36,
    metalness: 0.12,
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = { value: 0.16 }
    shader.uniforms.uRim = { value: 0.55 }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlow;\nuniform float uRim;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float rim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
        totalEmissiveRadiance += diffuseColor.rgb * (uGlow + rim * uRim);`,
      )
  }
  material.customProgramCacheKey = () => 'neon-shape-v1'
  return material
}

const GRID_GLSL = /* glsl */ `
float gridLine(vec2 p, float width) {
  vec2 d = fwidth(p);
  vec2 g = abs(fract(p - 0.5) - 0.5) / max(d, vec2(1e-4));
  return 1.0 - min(min(g.x, g.y) / width, 1.0);
}
`

/** Arena floor: lit + shadowed standard material with glowing 1 m grid and border. */
export function createFloorMaterial(halfX: number, halfZ: number): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#1b2536'),
    roughness: 0.92,
    metalness: 0.0,
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHalf = { value: new THREE.Vector2(halfX, halfZ) }
    shader.uniforms.uLine = { value: new THREE.Color('#38e1ff') }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGridPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGridPos = (modelMatrix * vec4(transformed, 1.0)).xz;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vGridPos;
        uniform vec2 uHalf;
        uniform vec3 uLine;
        ${GRID_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float radial = length(vGridPos) / length(uHalf);
        diffuseColor.rgb *= 1.08 - 0.35 * radial;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // Lines on the half-metre offsets so the outermost lines sit on the glass.
        float minor = gridLine(vGridPos + 0.5, 1.0);
        float major = gridLine((vGridPos + 0.5) / 4.0, 1.4);
        vec2 edgeDist = uHalf - abs(vGridPos);
        float border = 1.0 - smoothstep(0.0, 0.18, min(edgeDist.x, edgeDist.y));
        float centre = 1.0 - smoothstep(0.0, 0.05, abs(length(vGridPos) - 1.2));
        totalEmissiveRadiance += uLine * (minor * 0.11 + major * 0.08 + border * 0.9 + centre * 0.12);`,
      )
  }
  material.customProgramCacheKey = () => 'arena-floor-v1'
  return material
}

/** Unlit outer ground that fades into the void. */
export function createOuterGroundMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color('#060a12') })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLine = { value: new THREE.Color('#1f6f8b') }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGridPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGridPos = (modelMatrix * vec4(transformed, 1.0)).xz;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vGridPos;
        uniform vec3 uLine;
        ${GRID_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float fade = 1.0 - smoothstep(6.0, 30.0, length(vGridPos));
        float line = gridLine((vGridPos + 0.5) / 2.0, 1.0);
        diffuseColor.rgb += uLine * line * 0.35 * fade;`,
      )
  }
  material.customProgramCacheKey = () => 'outer-ground-v1'
  return material
}

/** Semi-transparent containment glass with fresnel sheen and glowing panel borders. */
export function createGlassMaterial(options: { verticalGradient: boolean }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color('#4fd8ff') },
      uOpacity: { value: 0.035 },
      uVertical: { value: options.verticalGradient ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uVertical;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        float facing = abs(dot(normalize(vNormalW), normalize(vViewDir)));
        float fresnel = pow(1.0 - facing, 3.0);
        vec2 e = min(vUv, 1.0 - vUv);
        float edge = min(e.x, e.y);
        float border = 1.0 - smoothstep(0.0, 0.025, edge);
        float base = uVertical * (1.0 - smoothstep(0.0, 0.35, vUv.y)) * 0.06;
        float alpha = uOpacity + fresnel * 0.12 + border * 0.28 + base;
        vec3 col = uColor * (0.55 + fresnel * 0.8 + border * 0.9 + base * 4.0);
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.6));
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}
