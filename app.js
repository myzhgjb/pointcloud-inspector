/* 点云巡检工作台 —— 演示原型
 * 技术栈：three.js（WebGL 点云渲染）+ 自研轨道控制 + 二进制点云解析
 * 数据：程序化生成的建筑立面点云（手持 SLAM 采集口径），支持导入自有 .xyz/.ply
 */
(function () {
  'use strict';

  var view = document.getElementById('view');
  var canvas = document.getElementById('gl');
  var state = {
    mode: 'rgb',
    pts: 0,
    size: '—',
    anns: [],          // 全部标注
    picking: false,
    scanning: false,
    meta: null
  };

  // ---------- three 基础 ----------
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  var scene = new THREE.Scene();
  var isNarrow0 = window.innerWidth / window.innerHeight < 1.05;
  var camera = new THREE.PerspectiveCamera(isNarrow0 ? 68 : 52, 1, 0.1, 900);
  var cloud = null, geo = null;
  var markerGroup = new THREE.Group();
  scene.add(markerGroup);
  var trailGroup = new THREE.Group();
  scene.add(trailGroup);

  // 相机轨道状态
  var isNarrow = window.innerWidth / window.innerHeight < 1.05;
  var cam = { tx: 12, ty: 6.2, tz: 0, r: isNarrow ? 46 : 23, th: Math.PI / 2, ph: 1.50 };

  function applyCam() {
    var sp = Math.sin(cam.ph), cp = Math.cos(cam.ph);
    camera.position.set(
      cam.tx + cam.r * sp * Math.cos(cam.th),
      cam.ty + cam.r * cp,
      cam.tz + cam.r * sp * Math.sin(cam.th)
    );
    camera.lookAt(cam.tx, cam.ty, cam.tz);
  }

  function resize() {
    var w = view.clientWidth, h = view.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  // ---------- 交互：旋转 / 缩放 / 平移 ----------
  var drag = null;

  function onDown(e) {
    if (e.button === 2 || e.shiftKey) drag = { mode: 'pan', x: e.clientX, y: e.clientY };
    else drag = { mode: 'rot', x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0 };
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.mode === 'rot' && drag.moved !== undefined) drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.mode === 'rot') {
      cam.th -= dx * 0.006;
      cam.ph = Math.max(0.12, Math.min(Math.PI - 0.12, cam.ph - dy * 0.006));
    } else {
      var scale = cam.r * 0.0016;
      var right = new THREE.Vector3().subVectors(camera.position, new THREE.Vector3(cam.tx, cam.ty, cam.tz)).cross(new THREE.Vector3(0, 1, 0)).normalize();
      var up = new THREE.Vector3().crossVectors(right, new THREE.Vector3().subVectors(camera.position, new THREE.Vector3(cam.tx, cam.ty, cam.tz))).normalize();
      cam.tx -= right.x * dx * scale; cam.ty -= right.y * dx * scale; cam.tz -= right.z * dx * scale;
      cam.tx += up.x * dy * scale; cam.ty += up.y * dy * scale; cam.tz += up.z * dy * scale;
    }
    applyCam();
  }
  function onUp(e) {
    if (!drag) return;
    if (drag.mode === 'rot' && drag.moved !== undefined && drag.moved < 6 && !state.scanning) {
      pick(e);
    }
    drag = null;
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    cam.r = Math.max(4, Math.min(90, cam.r * Math.exp(e.deltaY * 0.0012)));
    applyCam();
  }, { passive: false });
  canvas.addEventListener('dblclick', function () { resetCam(); });

  // 触摸
  var touch = null;
  canvas.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, d: 0 };
    else if (e.touches.length === 2) {
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      touch = { pinch: Math.hypot(dx, dy) };
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', function (e) {
    if (!touch) return;
    if (e.touches.length === 2 && touch.pinch) {
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      var d = Math.hypot(dx, dy);
      cam.r = Math.max(4, Math.min(90, cam.r * (touch.pinch / d)));
      touch.pinch = d; applyCam();
      e.preventDefault();
    } else if (e.touches.length === 1 && touch.x !== undefined) {
      var mx = e.touches[0].clientX - touch.x, my = e.touches[0].clientY - touch.y;
      touch.x = e.touches[0].clientX; touch.y = e.touches[0].clientY;
      cam.th -= mx * 0.007; cam.ph = Math.max(0.12, Math.min(Math.PI - 0.12, cam.ph - my * 0.007));
      applyCam();
    }
  }, { passive: false });

  function resetCam() {
    cam.tx = 12; cam.ty = 6.2; cam.tz = 0; cam.r = isNarrow ? 46 : 23; cam.th = Math.PI / 2; cam.ph = 1.50;
    applyCam();
  }

  // ---------- 加载点云 ----------
  function loadPC() {
    return Promise.all([
      fetch('meta.json').then(function (r) { return r.json(); }),
      fetch('data.bin').then(function (r) { return r.arrayBuffer(); })
    ]).then(function (res) {
      var meta = res[0], buf = res[1];
      state.meta = meta;
      var N = meta.count;
      var f32 = new Float32Array(buf, 0, N * 3);
      var u8 = new Uint8Array(buf, N * 12);
      var rgb = u8.subarray(0, N * 3);
      var inten = u8.subarray(N * 3, N * 4);
      var sweep = u8.subarray(N * 4, N * 5);
      buildCloud(f32, rgb, inten, N, sweep);
      state.size = (buf.byteLength / 1048576).toFixed(1) + ' MB';
      document.getElementById('mSize').textContent = state.size;
      document.getElementById('mPts').textContent = N.toLocaleString();
      seedDefects(meta.defects);
      rebuildMarkers();
      renderList();
    });
  }

  var src = { pos: null, rgb: null, inten: null, sweep: null, N: 0, order: null };

  function buildCloud(posF32, rgbU8, intenU8, N, sweepU8) {
    // 按扫描顺序重排，实现「边走边建」的增量显示
    var order = new Uint32Array(N);
    for (var i = 0; i < N; i++) order[i] = i;
    if (sweepU8) order.sort(function (a, b) { return sweepU8[a] - sweepU8[b]; });

    var p = new Float32Array(N * 3);
    var c = new Float32Array(N * 3);
    for (var k = 0; k < N; k++) {
      var o = order[k];
      p[k * 3] = posF32[o * 3]; p[k * 3 + 1] = posF32[o * 3 + 1]; p[k * 3 + 2] = posF32[o * 3 + 2];
      c[k * 3] = rgbU8[o * 3] / 255; c[k * 3 + 1] = rgbU8[o * 3 + 1] / 255; c[k * 3 + 2] = rgbU8[o * 3 + 2] / 255;
    }
    var inten = new Float32Array(N);
    for (var m = 0; m < N; m++) inten[m] = intenU8 ? intenU8[order[m]] : 128;

    src.pos = p; src.rgb = c; src.inten = inten; src.N = N; src.order = order;

    if (cloud) { scene.remove(cloud); cloud.geometry.dispose(); }
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(c.slice(0), 3));
    geo.computeBoundingSphere();
    var mat = new THREE.PointsMaterial({
      size: 0.055, vertexColors: true, sizeAttenuation: true,
      transparent: true, opacity: 0.96, depthWrite: true
    });
    cloud = new THREE.Points(geo, mat);
    cloud.frustumCulled = false;
    scene.add(cloud);
    state.pts = N;
    setMode(state.mode, true);
    geo.setDrawRange(0, N);
  }

  // ---------- 着色模式 ----------
  function ramp(t) {
    // 蓝 -> 青 -> 黄 -> 红
    t = Math.max(0, Math.min(1, t));
    var c = new THREE.Color();
    if (t < 0.35) c.setRGB(0.17 + t * 0.5, 0.42 + t * 1.2, 1.0);
    else if (t < 0.68) c.setRGB(0.17 + (t - 0.35) * 2.6, 0.85 + (t - 0.35) * 0.4, 1.0 - (t - 0.35) * 2.4);
    else c.setRGB(1.0, 0.85 - (t - 0.68) * 2.0, 0.25 - (t - 0.68) * 0.7);
    return c;
  }

  function setMode(mode, silent) {
    state.mode = mode;
    if (!geo || !src.pos) return;
    var colAttr = geo.getAttribute('color');
    var arr = colAttr.array;
    var N = src.N, p = src.pos, base = src.rgb, it = src.inten;

    for (var i = 0; i < N; i++) {
      var r, g, b;
      if (mode === 'rgb') {
        r = base[i * 3]; g = base[i * 3 + 1]; b = base[i * 3 + 2];
      } else if (mode === 'h') {
        var t = Math.max(0, Math.min(1, p[i * 3 + 1] / 13));
        var c = ramp(1 - t * 0.85);
        r = c.r; g = c.g; b = c.b;
      } else if (mode === 'i') {
        var v = Math.pow(it[i] / 255, 0.85);
        r = g = b = 0.12 + v * 0.82;
      } else { // dev
        var y = p[i * 3 + 1], zz = p[i * 3 + 2];
        if (y < 0.35) { r = 0.18; g = 0.20; b = 0.23; }          // 地面
        else if (zz < -0.014) { r = 0.16; g = 0.18; b = 0.22; }  // 窗洞（设计即凹陷，不参与偏差）
        else {
          var d = Math.abs(zz) * 1000;                           // mm
          var c2 = ramp(d / 10);
          r = c2.r; g = c2.g; b = c2.b;
        }
      }
      arr[i * 3] = r; arr[i * 3 + 1] = g; arr[i * 3 + 2] = b;
    }
    colAttr.needsUpdate = true;
    var lg = document.getElementById('legendTitle');
    lg.textContent = mode === 'dev' ? '偏差色谱（相对设计立面，0–10 mm）' :
      mode === 'h' ? '高度着色（0 – 13 m）' : mode === 'i' ? '反射强度' : '真彩色（相机纹理）';
    if (!silent) {
      [].forEach.call(document.querySelectorAll('.mode'), function (el) {
        el.classList.toggle('on', el.dataset.m === mode);
      });
    }
  }

  // ---------- 标注 ----------
  function seedDefects(defects) {
    defects.forEach(function (d) {
      state.anns.push({
        id: d.id, type: d.type, level: d.level, size: d.size,
        x: d.x, y: d.y, z: 0.02, dev: d.dev, status: 'pending', from: 'ai'
      });
    });
  }

  function addMarker(a) {
    var color = a.status === 'confirmed' ? 0x38d39f : (a.from === 'ai' ? 0xffb020 : 0xff8a3d);
    var g = new THREE.SphereGeometry(0.16, 12, 12);
    var mat = new THREE.MeshBasicMaterial({ color: color });
    var mesh = new THREE.Mesh(g, mat);
    mesh.position.set(a.x, a.y, a.z + 0.05);
    mesh.userData.ann = a;
    markerGroup.add(mesh);
    a._mesh = mesh;

    var el = document.createElement('div');
    el.className = 'label3d' + (a.from === 'ai' ? '' : ' user');
    el.textContent = a.id + ' ' + a.type;
    view.appendChild(el);
    a._label = el;
  }

  function clearMarkers() {
    while (markerGroup.children.length) {
      var m = markerGroup.children.pop();
      m.geometry.dispose(); m.material.dispose();
    }
    state.anns.forEach(function (a) { if (a._label && a._label.parentNode) a._label.parentNode.removeChild(a._label); });
  }

  function rebuildMarkers() {
    clearMarkers();
    state.anns.forEach(function (a) { if (a.status !== 'false') addMarker(a); });
  }

  function pick(e) {
    if (!cloud) return;
    var rect = canvas.getBoundingClientRect();
    var mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    var ray = new THREE.Raycaster();
    ray.params.Points.threshold = 0.14;
    ray.setFromCamera(mouse, camera);
    var hits = ray.intersectObject(cloud, false);
    if (!hits.length) { hidePop(); return; }
    var pt = hits[0].point;
    showPop(e.clientX - rect.left, e.clientY - rect.top, pt);
  }

  var pendingPoint = null;
  function showPop(x, y, pt) {
    pendingPoint = pt;
    var pop = document.getElementById('pop');
    pop.style.left = Math.max(8, Math.min(view.clientWidth - 244, x + 12)) + 'px';
    pop.style.top = Math.max(8, Math.min(view.clientHeight - 250, y - 20)) + 'px';
    pop.classList.add('on');
    document.getElementById('fSize').value = '';
  }
  function hidePop() { document.getElementById('pop').classList.remove('on'); pendingPoint = null; }

  document.getElementById('fCancel').addEventListener('click', hidePop);
  document.getElementById('fSave').addEventListener('click', function () {
    if (!pendingPoint) return;
    var type = document.getElementById('fType').value;
    var level = document.getElementById('fLevel').value;
    var size = document.getElementById('fSize').value || '现场量测';
    var pre = { '裂缝': 'C', '空鼓': 'K', '渗水': 'S', '幕墙错位': 'M', '钢筋外露': 'G', '其他': 'X' }[type] || 'X';
    var n = state.anns.filter(function (a) { return a.type === type; }).length + 1;
    state.anns.push({
      id: pre + '-' + String(n).padStart(2, '0'), type: type, level: level, size: size,
      x: pendingPoint.x, y: pendingPoint.y, z: pendingPoint.z,
      dev: Math.abs(pendingPoint.z) * 1000, status: 'user', from: 'user'
    });
    hidePop();
    rebuildMarkers(); renderList();
  });

  // ---------- 渲染列表 / 统计 ----------
  function renderList() {
    var list = document.getElementById('list');
    var alive = state.anns.filter(function (a) { return a.status !== 'false'; });
    document.getElementById('listCnt').textContent = alive.length + ' 处';
    if (!alive.length) { list.innerHTML = '<div class="empty">暂无病害，点击点云新增</div>'; }
    else {
      list.innerHTML = alive.map(function (a, idx) {
        var lv = a.level === 'Ⅲ' ? 'lv3' : a.level === 'Ⅱ' ? 'lv2' : 'lv1';
        var color = a.status === 'confirmed' ? '#38d39f' : (a.from === 'ai' ? '#ffb020' : '#ff8a3d');
        var acts = a.status === 'pending'
          ? '<div class="acts"><button class="mini ok" data-ok="' + a.id + '" title="确认">✓</button><button class="mini no" data-no="' + a.id + '" title="误报">✕</button></div>'
          : (a.from === 'user' ? '<div class="acts"><button class="mini no" data-del="' + a.id + '" title="删除">✕</button></div>'
            : '<div class="acts"><span style="font-size:11px;color:#38d39f">已复核</span></div>');
        return '<div class="item" data-fly="' + a.id + '"><div class="dot" style="background:' + color + '"></div>'
          + '<div class="body"><div class="t1">' + a.id + ' ' + a.type + '<i class="' + lv + '">' + a.level + '</i></div>'
          + '<div class="t2">' + a.size + '　偏差 ' + a.dev.toFixed(1) + ' mm</div></div>' + acts + '</div>';
      }).join('');
    }

    var total = alive.length;
    var done = alive.filter(function (a) { return a.status === 'confirmed' || a.from === 'user'; }).length;
    var maxDev = alive.reduce(function (m, a) { return Math.max(m, a.dev || 0); }, 0);
    document.getElementById('sAll').textContent = total;
    document.getElementById('sDone').textContent = done;
    document.getElementById('sMax').textContent = maxDev.toFixed(1);

    var types = {};
    alive.forEach(function (a) { types[a.type] = (types[a.type] || 0) + 1; });
    var mx = Math.max.apply(null, Object.keys(types).map(function (k) { return types[k]; }).concat([1]));
    document.getElementById('bars').innerHTML = Object.keys(types).map(function (k) {
      return '<div class="bar"><span class="nm">' + k + '</span><span class="track"><i class="fill" style="width:' + (types[k] / mx * 100) + '%;display:block"></i></span><span class="v">' + types[k] + '</span></div>';
    }).join('') || '<div class="empty" style="padding:2px 0">—</div>';
  }

  document.getElementById('list').addEventListener('click', function (e) {
    var t = e.target;
    var okId = t.dataset && t.dataset.ok, noId = t.dataset && t.dataset.no, delId = t.dataset && t.dataset.del;
    if (okId) { var a = byId(okId); a.status = 'confirmed'; rebuildMarkers(); renderList(); return; }
    if (noId) { var b = byId(noId); b.status = 'false'; rebuildMarkers(); renderList(); return; }
    if (delId) { state.anns = state.anns.filter(function (x) { return x.id !== delId; }); rebuildMarkers(); renderList(); return; }
    var row = t.closest('.item');
    if (row) {
      var an = byId(row.dataset.fly);
      if (an) { cam.tx = an.x; cam.ty = an.y; cam.tz = 0; cam.r = 8; applyCam(); }
    }
  });
  function byId(id) { for (var i = 0; i < state.anns.length; i++) if (state.anns[i].id === id) return state.anns[i]; }

  // ---------- SLAM 扫描回放 ----------
  var trailLine = null, scannerDot = null;
  document.getElementById('btnScan').addEventListener('click', function () {
    if (state.scanning || !cloud) return;
    state.scanning = true;
    this.disabled = true;
    document.getElementById('scanbar').classList.add('on');
    rebuildTrail();
    var t0 = performance.now(), dur = 9000, N = src.N;
    var scanEl = document.getElementById('scanFill'), scanTxt = document.getElementById('scanTxt');

    (function frame() {
      var p = Math.min(1, (performance.now() - t0) / dur);
      var n = Math.floor(p * N);
      geo.setDrawRange(0, n);
      scanEl.style.width = (p * 100).toFixed(1) + '%';
      scanTxt.textContent = Math.round(p * 100) + '%　已建 ' + n.toLocaleString() + ' 点';
      // 相机跟着走
      var x = p * 24;
      camera.position.set(x, 1.55 + p * 0.3, 2.6);
      camera.lookAt(Math.min(x + 2.5, 24), 5.2, 0);
      if (scannerDot) scannerDot.position.set(x, 1.55, 2.6);
      if (p < 1) requestAnimationFrame(frame);
      else {
        state.scanning = false;
        document.getElementById('btnScan').disabled = false;
        setTimeout(function () { document.getElementById('scanbar').classList.remove('on'); }, 900);
        geo.setDrawRange(0, N);
        if (trailGroup) { while (trailGroup.children.length) trailGroup.remove(trailGroup.children[0]); }
        resetCam();
      }
    })();
  });

  function rebuildTrail() {
    while (trailGroup.children.length) {
      var c = trailGroup.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    var pts = [new THREE.Vector3(0, 1.55, 2.6), new THREE.Vector3(24, 1.55, 2.6)];
    var g = new THREE.BufferGeometry().setFromPoints(pts);
    trailLine = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0x4da3ff, dashSize: 0.4, gapSize: 0.25 }));
    trailLine.computeLineDistances();
    trailGroup.add(trailLine);
    scannerDot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x4da3ff }));
    scannerDot.position.set(0, 1.55, 2.6);
    trailGroup.add(scannerDot);
  }

  // ---------- 报告 / CSV ----------
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  document.getElementById('btnReport').addEventListener('click', function () {
    var alive = state.anns.filter(function (a) { return a.status !== 'false'; });
    var date = new Date().toLocaleString('zh-CN');
    var lines = [];
    lines.push('# 建筑外立面巡检报告');
    lines.push('');
    lines.push('| 项目 | 内容 |');
    lines.push('|---|---|');
    lines.push('| 工程名称 | 青苔片区建筑外立面 |');
    lines.push('| 采集设备 | 手持式 SLAM 三维扫描仪（10 mm 档） |');
    lines.push('| 点云精度 | ±6 mm　|');
    lines.push('| 点云规模 | ' + state.pts.toLocaleString() + ' 点 / ' + state.size + ' |');
    lines.push('| 立面尺寸 | 24.0 × 13.0 m |');
    lines.push('| 生成时间 | ' + date + ' |');
    lines.push('');
    lines.push('## 一、病害统计');
    var types = {};
    alive.forEach(function (a) { types[a.type] = (types[a.type] || 0) + 1; });
    lines.push('');
    lines.push('共识别病害 **' + alive.length + ' 处**，其中 Ⅲ 级 ' + alive.filter(function (a) { return a.level === 'Ⅲ'; }).length
      + ' 处、Ⅱ 级 ' + alive.filter(function (a) { return a.level === 'Ⅱ'; }).length
      + ' 处、Ⅰ 级 ' + alive.filter(function (a) { return a.level === 'Ⅰ'; }).length + ' 处。');
    lines.push('');
    Object.keys(types).forEach(function (k) { lines.push('- ' + k + '：' + types[k] + ' 处'); });
    lines.push('');
    lines.push('## 二、病害清单');
    lines.push('');
    lines.push('| 编号 | 类型 | 等级 | 位置 (x, y) | 尺寸 | 偏差 | 状态 |');
    lines.push('|---|---|---|---|---|---|---|');
    alive.forEach(function (a) {
      lines.push('| ' + a.id + ' | ' + a.type + ' | ' + a.level + ' | ' + a.x.toFixed(2) + ', ' + a.y.toFixed(2)
        + ' | ' + a.size + ' | ' + a.dev.toFixed(1) + ' mm | ' + (a.status === 'confirmed' ? '已复核' : a.from === 'ai' ? 'AI 预标注待复核' : '人工新增') + ' |');
    });
    lines.push('');
    lines.push('## 三、处理建议');
    lines.push('');
    lines.push('1. Ⅲ 级病害（' + alive.filter(function (a) { return a.level === 'Ⅲ'; }).map(function (a) { return a.id; }).join('、') + '）建议 7 日内安排专项复核并制定修复方案。');
    lines.push('2. Ⅱ 级病害纳入季度巡检计划，观察发展趋势。');
    lines.push('3. Ⅰ 级病害做好标记，与下次扫描成果做差分比对，判断是否扩展。');
    lines.push('');
    lines.push('> 说明：本报告由点云巡检工作台自动生成，偏差值为相对设计立面的法向距离，检测结果需人工复核后作为处置依据。');

    var txt = lines.join('\n');
    download('巡检报告_' + new Date().toISOString().slice(0, 10) + '.md', txt);
    toast('报告已生成并下载');
  });

  document.getElementById('btnCsv').addEventListener('click', function () {
    var alive = state.anns.filter(function (a) { return a.status !== 'false'; });
    var rows = [['编号', '类型', '等级', 'X(m)', 'Y(m)', '偏差(mm)', '尺寸', '状态']];
    alive.forEach(function (a) {
      rows.push([a.id, a.type, a.level, a.x.toFixed(3), a.y.toFixed(3), a.dev.toFixed(1), a.size,
        a.status === 'confirmed' ? '已复核' : a.from === 'ai' ? '待复核' : '人工新增']);
    });
    var csv = '\ufeff' + rows.map(function (r) { return r.join(','); }).join('\n');
    download('病害清单.csv', csv, 'text/csv;charset=utf-8');
    toast('CSV 已导出');
  });

  function toast(msg) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);background:#1b222c;border:1px solid #33414f;color:#e6e9ef;font-size:12.5px;padding:9px 16px;border-radius:8px;z-index:99';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 1800);
  }

  // ---------- 导入自有数据 ----------
  document.getElementById('btnImport').addEventListener('click', function () {
    document.getElementById('fileIn').click();
  });
  document.getElementById('fileIn').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result);
      var parsed = parsePointText(text);
      if (!parsed || parsed.n < 100) { toast('解析失败：需要至少 100 个点'); return; }
      buildCloud(parsed.pos, parsed.rgb, parsed.inten, parsed.n, null);
      document.getElementById('mPts').textContent = parsed.n.toLocaleString();
      state.size = (f.size / 1048576).toFixed(1) + ' MB';
      document.getElementById('mSize').textContent = state.size;
      state.anns = []; rebuildMarkers(); renderList();
      resetCam();
      toast('已载入 ' + parsed.n.toLocaleString() + ' 个点');
    };
    reader.readAsText(f);
  });

  function parsePointText(text) {
    var lines = text.split(/\r?\n/);
    var isPly = /ply/i.test(lines[0] || '');
    var start = 0, props = 3, hasColor = false;
    if (isPly) {
      var vi = 0, pn = 0;
      for (var i = 0; i < lines.length; i++) {
        var L = lines[i].trim();
        if (/^element vertex/i.test(L)) vi = parseInt(L.split(/\s+/)[2], 10);
        else if (/^property/i.test(L)) {
          if (/red|green|blue/i.test(L)) hasColor = true;
          if (!/list/i.test(L)) pn++;
        } else if (L === 'end_header') { start = i + 1; break; }
        if (vi && pn) { props = pn; }
      }
    }
    var n = 0, cap = isPly ? (vi || 100000) : Math.min(lines.length, 2000000);
    var pos = new Float32Array(cap * 3), rgb = new Uint8Array(cap * 3), it = new Uint8Array(cap);
    var minx = 1e9, miny = 1e9, minz = 1e9, maxx = -1e9, maxy = -1e9, maxz = -1e9;
    for (var j = start; j < lines.length && n < cap; j++) {
      var s = lines[j].trim(); if (!s || s[0] === '#') continue;
      var cols = s.split(/[\s,;]+/);
      if (cols.length < 3) continue;
      var x = parseFloat(cols[0]), y = parseFloat(cols[1]), z = parseFloat(cols[2]);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
      pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z;
      if (hasColor && cols.length >= 6) {
        rgb[n * 3] = +cols[3]; rgb[n * 3 + 1] = +cols[4]; rgb[n * 3 + 2] = +cols[5];
      } else {
        rgb[n * 3] = 150; rgb[n * 3 + 1] = 150; rgb[n * 3 + 2] = 150;
      }
      it[n] = 128;
      minx = Math.min(minx, x); maxx = Math.max(maxx, x);
      miny = Math.min(miny, y); maxy = Math.max(maxy, y);
      minz = Math.min(minz, z); maxz = Math.max(maxz, z);
      n++;
    }
    if (!n) return null;
    // 居中 + 缩放到合理尺度
    var cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2;
    var span = Math.max(maxx - minx, maxy - miny, maxz - minz) || 1;
    var k = 24 / span;
    for (var q = 0; q < n; q++) {
      pos[q * 3] = (pos[q * 3] - cx) * k + 12;
      pos[q * 3 + 1] = (pos[q * 3 + 1] - cy) * k + 6.5;
      pos[q * 3 + 2] = (pos[q * 3 + 2] - cz) * k;
    }
    return { pos: pos.subarray(0, n * 3), rgb: rgb.subarray(0, n * 3), inten: it.subarray(0, n), n: n };
  }

  // ---------- 模式切换 / 菜单 ----------
  document.getElementById('modes').addEventListener('click', function (e) {
    var el = e.target.closest('.mode'); if (!el) return;
    setMode(el.dataset.m);
  });
  document.getElementById('btnMenu').addEventListener('click', function () {
    document.getElementById('side').classList.toggle('open');
  });

  // ---------- 渲染循环 ----------
  var lastT = performance.now(), frames = 0, fpsT = lastT;
  function loop(now) {
    requestAnimationFrame(loop);
    if (!state.scanning) applyCam();
    // 标签投影
    for (var i = 0; i < state.anns.length; i++) {
      var a = state.anns[i];
      if (!a._label || a.status === 'false') { if (a._label) a._label.style.display = 'none'; continue; }
      var v = new THREE.Vector3(a.x, a.y, a.z + 0.16).project(camera);
      var show = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      a._label.style.display = show ? 'block' : 'none';
      if (show) {
        var lx = (v.x * 0.5 + 0.5) * view.clientWidth, ly = (-v.y * 0.5 + 0.5) * view.clientHeight;
        a._label.style.left = Math.max(34, Math.min(view.clientWidth - 34, lx)) + 'px';
        a._label.style.top = Math.max(18, Math.min(view.clientHeight - 12, ly)) + 'px';
      }
    }
    renderer.render(scene, camera);
    frames++;
    if (now - fpsT > 500) {
      document.getElementById('mFps').textContent = Math.round(frames * 1000 / (now - fpsT));
      frames = 0; fpsT = now;
    }
  }

  // ---------- 关于 / URL 参数 ----------
  document.getElementById('btnImport2').addEventListener('click', function () {
    document.getElementById('fileIn').click();
  });
  document.getElementById('btnAbout2').addEventListener('click', function () {
    document.getElementById('aboutModal').classList.add('on');
  });
  document.getElementById('btnAbout').addEventListener('click', function () {
    document.getElementById('aboutModal').classList.add('on');
  });
  document.getElementById('aboutClose').addEventListener('click', function () {
    document.getElementById('aboutModal').classList.remove('on');
  });
  document.getElementById('aboutModal').addEventListener('click', function (e) {
    if (e.target === this) this.classList.remove('on');
  });

  if (isNarrow0) {
    var bs = document.getElementById('btnScan');
    if (bs) bs.textContent = '扫描';
  }

  // ---------- 启动 ----------
  resize();
  applyCam();
  requestAnimationFrame(loop);
  var qm = /[?&]mode=(rgb|h|i|dev)/.exec(location.search);
  var qs = /[?&]noscан/.test(location.search);
  loadPC().then(function () {
    applyCam();
    if (qm) setMode(qm[1]);
    // 自动播放一次扫描，作为开场
    if (!/[?&]nofly/.test(location.search)) setTimeout(function () { document.getElementById('btnScan').click(); }, 600);
  }).catch(function (err) {
    console.error(err);
    document.getElementById('mPts').textContent = '加载失败';
  });

  window.__demo = { state: state, setMode: setMode };
})();
