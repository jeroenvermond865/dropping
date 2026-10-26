// 3D-achtergrond: een nachtelijk heuvellandschap met lichtgevende routepunten.
(function () {
  const canvas = document.getElementById('scene');
  if (!canvas || !window.THREE) return;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x070b18, 0.02);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);

  // Landschap
  const geo = new THREE.PlaneGeometry(60, 60, 70, 70);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const height = (x, z) => Math.sin(x * 0.25) * Math.cos(z * 0.2) * 1.4 + Math.sin(x * 0.7 + z * 0.4) * 0.35;
  for (let i = 0; i < pos.count; i++) pos.setY(i, height(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  scene.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x22346e, flatShading: true, roughness: 0.9 })));
  scene.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0x2c4aa0, transparent: true, opacity: 0.3 })));

  // Bomen (kegeltjes) als bos
  const treeGeo = new THREE.ConeGeometry(0.35, 1.3, 6);
  const treeMat = new THREE.MeshStandardMaterial({ color: 0x0f3a35, flatShading: true });
  for (let i = 0; i < 160; i++) {
    const x = 4 + Math.random() * 10, z = -8 + Math.random() * 10;
    const t = new THREE.Mesh(treeGeo, treeMat);
    t.position.set(x, height(x, z) + 0.6, z);
    t.scale.setScalar(0.6 + Math.random() * 0.8);
    scene.add(t);
  }

  // Routepunten met lichtbundels
  const route = [[-9, 6], [-5, 1], [-6, -5], [0, -10], [8, -12], [15, -6], [16, 3]];
  const colors = [0x4dd2ff, 0xb06bff, 0x3ee08f, 0xffc44d];
  const beacons = route.map(([x, z], i) => {
    const g = new THREE.Group();
    const c = colors[i % colors.length];
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), new THREE.MeshBasicMaterial({ color: c }));
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.25, 6, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
    beam.position.y = 3;
    const light = new THREE.PointLight(c, 1.2, 6);
    g.add(orb, beam, light);
    g.position.set(x, height(x, z) + 0.5, z);
    scene.add(g);
    return g;
  });
  const curve = new THREE.CatmullRomCurve3(route.map(([x, z]) => new THREE.Vector3(x, height(x, z) + 0.15, z)));
  const path = new THREE.Mesh(new THREE.TubeGeometry(curve, 200, 0.06, 6), new THREE.MeshBasicMaterial({ color: 0x4dd2ff, transparent: true, opacity: 0.7 }));
  scene.add(path);
  const walker = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  walker.add(new THREE.PointLight(0xffffff, 1.5, 4));
  scene.add(walker);

  // Sterren
  const starGeo = new THREE.BufferGeometry();
  const stars = new Float32Array(1500 * 3);
  for (let i = 0; i < stars.length; i += 3) {
    const r = 70, th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI * 0.45;
    stars[i] = r * Math.sin(ph) * Math.cos(th); stars[i + 1] = r * Math.cos(ph) + 5; stars[i + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(stars, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.25, fog: false })));

  scene.add(new THREE.AmbientLight(0x6070c0, 0.8));
  const moon = new THREE.DirectionalLight(0xa0b8ff, 0.7);
  moon.position.set(-10, 20, 10);
  scene.add(moon);

  let tx = 0, ty = 0;
  addEventListener('pointermove', e => { tx = e.clientX / innerWidth - 0.5; ty = e.clientY / innerHeight - 0.5; });
  addEventListener('deviceorientation', e => { if (e.gamma != null) { tx = e.gamma / 90; ty = (e.beta - 45) / 90; } });

  function resize() {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();

  const t0 = performance.now();
  (function loop(now) {
    const t = (now - t0) / 1000;
    const a = t * 0.06;
    const r = camera.aspect < 1 ? 32 : 22;
    camera.position.set(Math.sin(a) * r + tx * 4, 14 - ty * 2, Math.cos(a) * r);
    camera.lookAt(2, -12, -2);
    beacons.forEach((b, i) => { b.children[0].scale.setScalar(1 + Math.sin(t * 3 + i) * 0.2); });
    walker.position.copy(curve.getPointAt((t * 0.04) % 1)).add(new THREE.Vector3(0, 0.2, 0));
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  })(t0);
})();
