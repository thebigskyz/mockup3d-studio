import * as THREE from 'three';

function prepare(texture, renderer) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false; // glTF UVs have v = 0 at the top
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

/**
 * Turn a dropped/pasted/chosen file into a texture.
 * Returns { texture, width, height, video?, url, name }.
 */
export async function loadMedia(file, renderer) {
  const url = URL.createObjectURL(file);
  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name);

  if (isVideo) {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('This video format is not supported by the browser.'));
    });
    await video.play().catch(() => {});
    const texture = prepare(new THREE.VideoTexture(video), renderer);
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    return { texture, width: video.videoWidth, height: video.videoHeight, video, url, name: file.name };
  }

  // Wait for the load event rather than img.decode(): decode() can stall
  // while the tab is in the background.
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = url;
  });
  const texture = prepare(new THREE.Texture(img), renderer);
  texture.needsUpdate = true;
  return { texture, width: img.naturalWidth, height: img.naturalHeight, url, name: file.name };
}

/** Placeholder shown on the screen until a design is added. */
export function placeholderTexture(renderer, landscape) {
  const w = landscape ? 2622 : 1206;
  const h = landscape ? 1206 : 2622;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const u = Math.min(w, h);
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#20232b');
  grad.addColorStop(1, '#0d0e12');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `600 ${Math.round(u * 0.06)}px -apple-system, Helvetica, sans-serif`;
  g.fillText('Drop your design', w / 2, h / 2 - u * 0.04);
  g.fillStyle = 'rgba(255,255,255,0.3)';
  g.font = `400 ${Math.round(u * 0.038)}px -apple-system, Helvetica, sans-serif`;
  g.fillText('PNG, JPG or video', w / 2, h / 2 + u * 0.04);
  const texture = prepare(new THREE.CanvasTexture(c), renderer);
  return { texture, width: w, height: h, name: null };
}
