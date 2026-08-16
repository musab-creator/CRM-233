'use client';

import { useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildHouse } from '@/lib/house-model';
import {
  applyShingleColor,
  createRidgeMaterial,
  createShingleMaterial,
} from '@/lib/shingle-texture';
import type { ShinglePalette } from '@/lib/roof-colors';

export type CameraView = 'street' | 'side' | 'aerial';

const VIEWS: Record<CameraView, { position: [number, number, number]; target: [number, number, number] }> = {
  // Standing across the street: eye level, not a drone shot.
  street: { position: [9, 2.6, 14.5], target: [-0.5, 2.9, 0.5] },
  side: { position: [-13.5, 3.0, 8.5], target: [-0.5, 2.7, 0.5] },
  aerial: { position: [8, 10.5, 12], target: [0, 1.8, 0] },
};

export interface RoofSceneHandle {
  setPalette: (palette: ShinglePalette) => void;
  setView: (view: CameraView) => void;
}

export default function RoofScene({
  palette,
  ref,
  onReady,
}: {
  palette: ShinglePalette;
  ref?: React.Ref<RoofSceneHandle>;
  onReady?: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const roofMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const capMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const viewRef = useRef<CameraView>('street');
  const applyViewRef = useRef<(() => void) | null>(null);
  // Kept in a ref so the scene is built once and never torn down on re-render.
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  useImperativeHandle(ref, () => ({
    setPalette(next: ShinglePalette) {
      if (roofMaterialRef.current) applyShingleColor(roofMaterialRef.current, next);
      if (capMaterialRef.current) applyShingleColor(capMaterialRef.current, next);
    },
    setView(view: CameraView) {
      viewRef.current = view;
      applyViewRef.current?.();
    },
  }));

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();

    // Sky gradient, drawn to a canvas so there is no external asset to load.
    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 8;
    skyCanvas.height = 256;
    const skyCtx = skyCanvas.getContext('2d')!;
    const gradient = skyCtx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, '#6ea8d8');
    gradient.addColorStop(0.55, '#bcd8ee');
    gradient.addColorStop(1, '#e8eef2');
    skyCtx.fillStyle = gradient;
    skyCtx.fillRect(0, 0, 8, 256);
    const skyTexture = new THREE.CanvasTexture(skyCanvas);
    skyTexture.colorSpace = THREE.SRGBColorSpace;
    scene.background = skyTexture;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
    camera.position.set(...VIEWS.street.position);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(...VIEWS.street.target);
    controls.minDistance = 9;
    controls.maxDistance = 46;
    // Stop the camera dropping below grade or flipping over the top.
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minPolarAngle = 0.15;
    controls.enablePan = false;
    controlsRef.current = controls;

    // ---- Lighting: late-morning sun, so the roof is lit but not blown out ----
    const sun = new THREE.DirectionalLight(0xfff4e2, 2.5);
    sun.position.set(16, 22, 13);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 80;
    sun.shadow.camera.left = -26;
    sun.shadow.camera.right = 26;
    sun.shadow.camera.top = 26;
    sun.shadow.camera.bottom = -20;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);

    scene.add(new THREE.HemisphereLight(0xbcd8ee, 0x6d7a55, 1.25));
    // A weak fill from the shaded side so dark shingles never read as pure black.
    const fill = new THREE.DirectionalLight(0xd8e6ff, 0.5);
    fill.position.set(-14, 8, -10);
    scene.add(fill);

    // ---- Ground ----
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(90, 64),
      new THREE.MeshStandardMaterial({ color: '#7d9457', roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // ---- House ----
    const roofMaterial = createShingleMaterial(paletteRef.current);
    const capMaterial = createRidgeMaterial(paletteRef.current);
    roofMaterialRef.current = roofMaterial;
    capMaterialRef.current = capMaterial;

    const house = buildHouse(roofMaterial, capMaterial);
    scene.add(house.group);

    // Re-frame the current preset for the current aspect ratio. Narrow frames
    // crop the house at the wide-screen distances, so the camera widens its
    // FOV slightly and backs away from the target as the viewport narrows.
    function applyView() {
      const { position, target } = VIEWS[viewRef.current];
      const factor = camera.aspect >= 1.4 ? 1 : 1 + (1.4 - camera.aspect) * 0.7;
      const t = new THREE.Vector3(...target);
      camera.position.copy(
        new THREE.Vector3(...position).sub(t).multiplyScalar(factor).add(t),
      );
      controls.target.copy(t);
      controls.update();
    }
    applyViewRef.current = applyView;

    // ---- Resize ----
    function resize() {
      if (!mount) return;
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      const previousAspect = camera.aspect;
      camera.aspect = width / height;
      camera.fov = camera.aspect >= 1.4 ? 42 : Math.min(56, 42 + (1.4 - camera.aspect) * 14);
      camera.updateProjectionMatrix();
      // Only re-frame when the shape of the frame actually changes, so window
      // nudges don't stomp a camera the user has orbited by hand.
      if (Math.abs(camera.aspect - previousAspect) > 0.1) applyView();
    }
    resize();
    applyView();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    let frame = 0;
    let announced = false;
    function animate() {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      if (!announced) {
        announced = true;
        onReady?.();
      }
    }
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const material = object.material;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });
      skyTexture.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
    // Built once. Color and camera changes go through the imperative handle so
    // that switching colors never rebuilds the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={mountRef} className="h-full w-full [&>canvas]:block [&>canvas]:h-full [&>canvas]:w-full" />;
}
