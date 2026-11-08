// The front glass: a sharp mirror reflection of the environment added on top
// of the screen, as real glass does.
//
// It samples the full-resolution HDRI directly (the lighting copy of the
// environment is pre-blurred and low resolution), and its strength follows
// Fresnel: `reflectance` straight on (real glass is about 4%), rising to a
// full mirror at grazing angles. Additive, so the screen underneath keeps its
// colours and the reflection only ever brightens it.

import * as THREE from 'three';

/** Shared by every device's glass; kept up to date by the scene. */
export const glassEnv = {
  map: { value: null },                     // equirect HDRI (after tint / highlights / contrast)
  rotation: { value: new THREE.Matrix3() }, // environment rotation
  level: { value: 1 },                      // the environment's Intensity
  // How widely the reflection spreads across the glass: 1 = a real mirror;
  // above 1 shows more of the environment (zoomed out). The scene sets it to
  // undo the magnification of long lenses, times the Reflection zoom.
  spread: { value: 1 },
};

export function createGlassMaterial(reflectance = 0.08) {
  return new THREE.ShaderMaterial({
    uniforms: {
      envMap: glassEnv.map,
      envRotation: glassEnv.rotation,
      level: glassEnv.level,
      spread: glassEnv.spread,
      reflectance: { value: reflectance },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vCentre;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vCentre = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D envMap;
      uniform mat3 envRotation;
      uniform float level;
      uniform float reflectance;
      uniform float spread;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vCentre;

      // Bilinear filtering done by hand in log space. Hardware filtering
      // blends the raw HDR values, and a light that's hundreds of times
      // brighter than its surroundings then wins almost the whole texel: its
      // edge becomes a staircase of hard texel steps. Blending logarithms
      // gives a smooth ramp instead.
      vec3 envTexel(ivec2 p) {
        return log2(texelFetch(envMap, p, 0).rgb + 1e-3);
      }
      vec3 sampleEnv(vec2 uv) {
        ivec2 size = textureSize(envMap, 0);
        vec2 p = uv * vec2(size) - 0.5;
        vec2 f = fract(p);
        ivec2 i = ivec2(floor(p));
        int x0 = i.x < 0 ? i.x + size.x : (i.x >= size.x ? i.x - size.x : i.x); // wraps around
        int x1 = x0 + 1 >= size.x ? 0 : x0 + 1;
        int y0 = clamp(i.y, 0, size.y - 1);
        int y1 = clamp(i.y + 1, 0, size.y - 1);
        vec3 a = mix(envTexel(ivec2(x0, y0)), envTexel(ivec2(x1, y0)), f.x);
        vec3 b = mix(envTexel(ivec2(x0, y1)), envTexel(ivec2(x1, y1)), f.x);
        return max(exp2(mix(a, b, f.y)) - 1e-3, 0.0);
      }

      void main() {
        vec3 n = normalize(vWorldNormal);
        vec3 v = normalize(cameraPosition - vWorldPos);
        if (dot(n, v) < 0.0) n = -n;
        // Same direction -> equirect mapping as three.js uses for the
        // background and the lighting, so reflections line up with both.
        // Across a flat screen the reflection only changes with the viewing
        // direction, which barely changes with a long lens: the screen then
        // shows a tiny, magnified patch of the HDRI. Scale how far each
        // point's reflection strays from the one at the glass's centre.
        vec3 r = reflect(-v, n);
        vec3 r0 = reflect(-normalize(cameraPosition - vCentre), n);
        vec3 d = envRotation * normalize(r0 + (r - r0) * spread);
        vec2 uv = vec2(atan(d.z, d.x) * 0.15915494309189535 + 0.5,
                       asin(clamp(d.y, -1.0, 1.0)) * 0.3183098861837907 + 0.5);
        vec3 env = sampleEnv(uv);
        float c = clamp(dot(n, v), 0.0, 1.0);
        float fresnel = reflectance + (1.0 - reflectance) * pow(1.0 - c, 5.0);
        gl_FragColor = vec4(env * fresnel * level, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}
