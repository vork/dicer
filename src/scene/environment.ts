import * as THREE from 'three';

/**
 * A small emissive room, prefiltered into an environment map.
 *
 * Panel intensities are radiance in the renderer's linear units, so they set the
 * scene's overall exposure as much as the lights do — a key panel much above ~3
 * pushes even a near-black felt floor to white.
 *
 * The dice are polished resin, so nearly everything you read as "shape" on them is
 * reflected light. A plain ambient term makes them look like plastic toys; a room
 * with a big soft key panel and two coloured rim strips gives every edge a
 * highlight that travels as the die tumbles, which is what sells the material.
 */
function buildEnvironmentScene(): THREE.Scene {
  const scene = new THREE.Scene();

  const box = new THREE.BoxGeometry();
  // Emissive-only material: the environment scene is never lit, just captured.
  const panel = (color: THREE.ColorRepresentation, intensity: number) =>
    new THREE.MeshStandardMaterial({
      side: THREE.BackSide,
      color: 0x000000,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      roughness: 1,
      metalness: 0,
    });

  const add = (
    material: THREE.Material,
    position: [number, number, number],
    scale: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0],
  ) => {
    const mesh = new THREE.Mesh(box, material);
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.rotation.set(...rotation);
    scene.add(mesh);
    return mesh;
  };

  // Enclosing shell: near-black, with a slightly lifted ceiling so the dice never
  // reflect pure void.
  add(panel(0x0a0a10, 0.05), [0, 0, 0], [46, 26, 46]);
  add(panel(0x1b1c26, 0.25), [0, 12.6, 0], [40, 0.2, 40]);

  // Key: a wide softbox high and slightly in front, warm white.
  add(panel(0xfff2dc, 3.0), [0, 10.5, 7], [17, 0.2, 9], [0.32, 0, 0]);
  // Bounce below the key, keeps the underside of a tumbling die from going black.
  add(panel(0x2a2620, 0.3), [0, -3.4, 2], [22, 0.2, 16]);

  // Rim strips: cool from the left and behind, warm from the right.
  add(panel(0x6fa8ff, 1.8), [-11, 3.6, -3], [0.2, 5.5, 15], [0, 0, -0.22]);
  add(panel(0xffb27a, 1.4), [11, 3.2, -1], [0.2, 4.5, 13], [0, 0, 0.22]);
  // A dim slab straight behind, so edges facing away still catch something.
  add(panel(0x39415c, 0.7), [0, 4.5, -13], [16, 7, 0.2]);

  return scene;
}

export function createEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const scene = buildEnvironmentScene();
  const target = pmrem.fromScene(scene, 0.035);
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) (mesh.material as THREE.Material).dispose();
  });
  pmrem.dispose();
  return target.texture;
}

/**
 * Real-time lights. The environment map carries the ambient character; these
 * carry the shadow and the moving specular that makes the throw legible.
 */
export function createLights(
  trayWidth: number,
  trayDepth: number,
  shadowMapSize = 2048,
): THREE.Object3D[] {
  const lights: THREE.Object3D[] = [];

  // The key is directional purely for its shadow. A spotlight far enough away to
  // cover the tray spreads its shadow map so thinly that one texel is wider than a
  // die, and the contact shadow — the thing that makes the dice look heavy rather
  // than pasted on — disappears. An orthographic shadow camera cropped to the tray
  // spends every texel where the dice actually are.
  const key = new THREE.DirectionalLight(0xfff0d8, 2.9);
  key.position.set(6, 21, 9);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  const extent = Math.max(trayWidth, trayDepth) * 0.78;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 60;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 1.4;
  lights.push(key, key.target);

  // The visible pool of light on the felt. Casts nothing; it is pure staging.
  const pool = new THREE.SpotLight(0xffe9c8, 950, 0, Math.PI / 7.5, 0.9, 2);
  pool.position.set(2.6, 24, 7);
  pool.target.position.set(0, 0, 0);
  lights.push(pool, pool.target);

  // Cool counter-light from behind-left; no shadow, it only shapes the edges.
  const rim = new THREE.SpotLight(0x8fbaff, 520, 0, Math.PI / 4.2, 0.9, 2);
  rim.position.set(-13, 12, -14);
  rim.target.position.set(0, 0, 0);
  lights.push(rim, rim.target);

  // Warm kicker from the right, low and close, for the resin's inner glow.
  const kicker = new THREE.PointLight(0xffb271, 70, 34, 2);
  kicker.position.set(Math.max(trayWidth, 9), 3.2, -Math.max(trayDepth, 6) * 0.5);
  lights.push(kicker);

  const ambient = new THREE.HemisphereLight(0x2c3340, 0x0a0a0c, 0.25);
  lights.push(ambient);

  return lights;
}
