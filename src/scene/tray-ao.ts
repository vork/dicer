import * as THREE from 'three';

/**
 * Ambient occlusion for the tray floor, baked from the geometry rather than
 * sampled.
 *
 * The tray is a box open at the top, so how much ambient light a point on the
 * felt can receive is exactly how much of the opening it can see — and the
 * fraction of a diffuse surface's hemisphere subtended by a parallel rectangle is
 * a form factor with a closed form. No rays, no noise, no bake time: a couple of
 * arctangents per texel.
 *
 * Why it was needed: with the direct lights silenced, 30% of the felt's
 * brightness was ambient, and that share was flat at 30% everywhere — hard
 * against the walls exactly as much as out in the middle. A box whose floor does
 * not darken toward its own walls reads as a painted rectangle rather than
 * something with depth, which is what it looked like.
 *
 * The dice get nothing from this and need nothing: every one of them is convex to
 * within a millionth of a unit, and a convex solid cannot occlude itself. What
 * grounds a die on the felt is its contact shadow, which the key light's shadow
 * map already draws at 228 texels per world unit.
 */

/**
 * Form factor from a differential horizontal surface to a rectangle in a parallel
 * plane, with the surface below one corner of it.
 *
 * Standard configuration: sides `a` and `b`, separation `c`. This is the piece
 * every other case is built from, since a point under the middle of a rectangle
 * is four of these back to back.
 */
function cornerFormFactor(a: number, b: number, c: number): number {
  if (a <= 0 || b <= 0 || c <= 0) return 0;
  const x = a / c;
  const y = b / c;
  const rx = Math.sqrt(1 + x * x);
  const ry = Math.sqrt(1 + y * y);
  return ((x / rx) * Math.atan(y / rx) + (y / ry) * Math.atan(x / ry)) / (2 * Math.PI);
}

/**
 * How much of the opening a point on the floor can see, as a fraction of its
 * hemisphere. 1 would be an unobstructed sky; the middle of this tray sees about
 * 0.84 and a point against a wall about 0.44, which is the factor of two you would
 * expect from losing half the sky behind a wall.
 */
function openingVisibility(x: number, z: number, halfWidth: number, halfDepth: number, height: number): number {
  const left = halfWidth + x;
  const right = halfWidth - x;
  const back = halfDepth + z;
  const front = halfDepth - z;
  return (
    cornerFormFactor(left, back, height) +
    cornerFormFactor(right, back, height) +
    cornerFormFactor(left, front, height) +
    cornerFormFactor(right, front, height)
  );
}

/**
 * Bakes the floor's occlusion into a texture, addressed by a UV that runs 0..1
 * across the inner rectangle.
 *
 * Normalised so the most open point on the floor comes out at 1. The absolute
 * form factor is below 1 everywhere — the middle of the tray genuinely receives
 * only 84% of an open sky — but applying that raw would darken the whole floor by
 * a sixth and undo lighting that was tuned without it. What is wanted here is the
 * gradient, not a re-exposure.
 */
export function createTrayFloorAo(
  innerWidth: number,
  innerDepth: number,
  wallHeight: number,
  size = 128,
): THREE.DataTexture {
  const halfWidth = innerWidth / 2;
  const halfDepth = innerDepth / 2;
  const width = size;
  const height = Math.max(2, Math.round((size * innerDepth) / innerWidth));

  const visibility = new Float32Array(width * height);
  let brightest = 0;
  for (let row = 0; row < height; row++) {
    // Texel centres, so the edge texel is inside the floor rather than on its rim.
    const z = ((row + 0.5) / height - 0.5) * innerDepth;
    for (let column = 0; column < width; column++) {
      const x = ((column + 0.5) / width - 0.5) * innerWidth;
      const seen = openingVisibility(x, z, halfWidth, halfDepth, wallHeight);
      visibility[row * width + column] = seen;
      if (seen > brightest) brightest = seen;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < visibility.length; i++) {
    const ao = Math.min(1, visibility[i] / brightest);
    const value = Math.round(ao * 255);
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  // Linear data, not colour: an sRGB transfer here would bend the gradient.
  texture.colorSpace = THREE.NoColorSpace;
  // Read with uv1, not uv. `Texture.channel` defaults to 0 whatever the map is
  // for, so an aoMap left alone samples the same coordinates as the colour maps —
  // here that is the felt's tiling UVs in world units, which clamp to one edge
  // texel and hand back a constant. It measured as a flat 0.32 across the whole
  // floor, which looks like a working occlusion map right up until you plot it.
  texture.channel = 1;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A second UV set for the floor, running 0..1 across the inner rectangle.
 *
 * The floor's own UVs are the shape's coordinates in world units, which is what
 * makes the felt grain tile — so the occlusion map, which must not tile, needs its
 * own. `aoMap` reads `uv1` by default, which is exactly this one.
 */
export function applyFloorAoUv(geometry: THREE.BufferGeometry, innerWidth: number, innerDepth: number) {
  const position = geometry.getAttribute('position');
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    // The floor is built flat in XY and then laid down, so the shape's y is the
    // tray's depth. Reading position rather than assuming the rotation keeps this
    // correct if the floor is ever built the other way up.
    uv[i * 2] = position.getX(i) / innerWidth + 0.5;
    uv[i * 2 + 1] = position.getY(i) / innerDepth + 0.5;
  }
  geometry.setAttribute('uv1', new THREE.BufferAttribute(uv, 2));
}
