/* =============================================================================
 *  main.js —— 主程序：WebGL 初始化 / 资源上传 / 状态 / 渲染循环 / 输入分发
 *
 *  分层：
 *      geometry.js   只算顶点
 *      textures.js   只负责纹理上传（含 FLIP_Y 处理）
 *      transforms.js 手工矩阵 + 自检
 *      scene.js      层级树（节点 + local 矩阵），不含 GL 调用
 *      camera.js     球坐标机位 + 关键帧漫游
 *      interaction.js 收输入
 *      ui.js         面板 ↔ 状态
 *    main.js 只做"胶水"：把上面几块拼起来，并持有全部 GL 对象。
 * ========================================================================== */
(function () {
  'use strict';

  /* ======================= 0. 基础 ======================= */

  var canvas    = document.getElementById('glcanvas');
  var statusEl  = document.getElementById('status');
  var loadingEl = document.getElementById('loading');
  var errEl     = document.getElementById('err');

  var Q = new URLSearchParams(location.search);

  function fail(msg) {
    loadingEl.classList.add('hidden');
    errEl.classList.remove('hidden');
    errEl.textContent = msg;
    console.error(msg);
  }

  // preserveDrawingBuffer 只在"截图模式"（?shot=1）下开启，正常浏览不牺牲性能
  var gl = canvas.getContext('webgl2', {
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: Q.has('shot')
  });
  if (!gl) {
    fail('此浏览器不支持 WebGL 2.0。\n请使用新版 Chrome / Edge / Firefox，并确认硬件加速已开启。');
    return;
  }

  /* ======================= 1. 着色器 ======================= */

  var progBody = initShaders(gl, 'vbody', 'fbody');
  var progFlat = initShaders(gl, 'vflat', 'fflat');
  var progGlow = initShaders(gl, 'vglow', 'fglow');
  if (!progBody || progBody === -1 || !progFlat || progFlat === -1 ||
      !progGlow || progGlow === -1) {
    fail('着色器编译失败，请查看控制台（F12）中的 GLSL 错误日志。');
    return;
  }

  function uniforms(prog, names) {
    var o = {};
    for (var i = 0; i < names.length; i++) o[names[i]] = gl.getUniformLocation(prog, names[i]);
    return o;
  }

  var U = {
    body: uniforms(progBody, ['uModel', 'uView', 'uProj', 'uTex', 'uUseTex', 'uColor',
                              'uLightPos', 'uEyePos', 'uEmissive', 'uAmbient',
                              'uSpecular', 'uShininess', 'uBright']),
    flat: uniforms(progFlat, ['uModel', 'uView', 'uProj', 'uColor', 'uPointSize',
                              'uRoundPoints']),
    glow: uniforms(progGlow, ['uModel', 'uView', 'uProj', 'uColor', 'uPower', 'uStrength'])
  };

  var A = {
    body: {
      pos: gl.getAttribLocation(progBody, 'aPosition'),
      nrm: gl.getAttribLocation(progBody, 'aNormal'),
      uv:  gl.getAttribLocation(progBody, 'aTexCoord')
    },
    flat: { pos: gl.getAttribLocation(progFlat, 'aPosition') },
    glow: { pos: gl.getAttribLocation(progGlow, 'aPosition') }
  };

  /* ======================= 2. 矩阵上传 =======================
   * MV.js 用行主序嵌套数组存矩阵（m[row][col]），而 uniformMatrix4fv(transpose=false)
   * 按列主序解读，直接把 flatten(m) 传上去等于把矩阵转置（平移跑到第 4 行、旋转反向）。
   * 这里手工按「列主序 = m[j][i]」展开，等价于 flatten(transpose(m))，且零额外内存。
   * （与 AP1 里处理的是同一个坑，见 README 技术要点。）
   */
  var scratch = new Float32Array(16);

  function uploadMat4(loc, m) {
    if (!loc) return;                       // 未被使用的 uniform 会被编译器优化掉
    var k = 0;
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) scratch[k++] = m[j][i];
    }
    gl.uniformMatrix4fv(loc, false, scratch);
  }

  /* ======================= 3. 网格 ======================= */

  function makeMesh(data) {
    function vbo(arr) {
      var b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      return b;
    }
    var m = { bufs: [vbo(data.positions)], sizes: [3] };
    if (data.normals) { m.bufs.push(vbo(data.normals)); m.sizes.push(3); }
    if (data.uvs)     { m.bufs.push(vbo(data.uvs));     m.sizes.push(2); }

    if (data.indices) {
      m.idx = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
      m.count = data.indices.length;
    } else {
      m.count = data.positions.length / 3;
    }
    return m;
  }

  // 每次绑定前先关掉所有属性数组，避免上一个 program 的 attribute 状态泄漏
  var MAX_ATTR = 4;
  function bindMesh(mesh, locs) {
    for (var i = 0; i < MAX_ATTR; i++) gl.disableVertexAttribArray(i);
    for (var k = 0; k < locs.length; k++) {
      var loc = locs[k];
      if (loc < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.bufs[k]);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, mesh.sizes[k], gl.FLOAT, false, 0, 0);
    }
  }

  /* ======================= 4. 状态 ======================= */

  var state = {
    paused: false,
    speed: { orbit: 1, spin: 1 },
    tilt: CONFIG.bodies.earth.tilt,
    incl: CONFIG.bodies.moon.inclination,
    showOrbits: true,
    showAxis: true,
    showStars: true,
    angles: { sunSpin: 0, earthOrbit: CONFIG.bodies.earth.startAngle, earthSpin: 0, moonOrbit: 0 },
    elapsed: 0
  };

  var cam = createCamera();
  var projM = mat4();
  var textures = {};

  /** 按时间推进四个角度（速度为 0 即冻结，方便讲解单个变换） */
  function advance(dt) {
    var B = CONFIG.bodies;
    state.angles.earthOrbit += dt * (360 / B.earth.orbitPeriod) * state.speed.orbit;
    state.angles.earthSpin  += dt * (360 / B.earth.spinPeriod)  * state.speed.spin;
    state.angles.moonOrbit  += dt * (360 / B.moon.orbitPeriod)  * state.speed.orbit;
    state.angles.sunSpin    += dt * (360 / B.sun.spinPeriod)    * state.speed.spin;
    state.elapsed += dt;
  }

  /** 由绝对时间（秒）反算四个角度 —— 用于 ?t= 参数，保证截图可复现 */
  function setFromTime(sec) {
    var B = CONFIG.bodies;
    state.angles.earthOrbit = (B.earth.startAngle || 0) + sec * (360 / B.earth.orbitPeriod) * state.speed.orbit;
    state.angles.earthSpin  = sec * (360 / B.earth.spinPeriod) * state.speed.spin;
    state.angles.moonOrbit  = sec * (360 / B.moon.orbitPeriod) * state.speed.orbit;
    state.angles.sunSpin    = sec * (360 / B.sun.spinPeriod)   * state.speed.spin;
    state.elapsed = sec;
  }

  /* ======================= 5. 渲染器（注入给 scene.js） ======================= */

  /**
   * 面向摄像机的公告板矩阵：把单位四边形摆到世界坐标 pos 处、正对相机。
   * 视图矩阵的前两行就是相机在世界空间的「右」「上」方向，
   * 用它们做基向量，四边形自然始终正对镜头。
   */
  function billboardMatrix(pos, scale) {
    var v = cam.view;
    var m = mat4();
    m[0][0] = v[0][0] * scale; m[0][1] = v[1][0] * scale; m[0][2] = 0; m[0][3] = pos[0];
    m[1][0] = v[0][1] * scale; m[1][1] = v[1][1] * scale; m[1][2] = 0; m[1][3] = pos[1];
    m[2][0] = v[0][2] * scale; m[2][1] = v[1][2] * scale; m[2][2] = 0; m[2][3] = pos[2];
    return m;
  }

  var R = {

    /** 不透明球体：纹理 + 以太阳为点光源的漫反射/镜面 */
    drawBody: function (M, mat) {
      gl.useProgram(progBody);
      uploadMat4(U.body.uModel, M);
      uploadMat4(U.body.uProj, projM);
      uploadMat4(U.body.uView, cam.view);

      gl.uniform3f(U.body.uLightPos, 0, 0, 0);          // 太阳在原点
      gl.uniform3f(U.body.uEyePos, cam.eye[0], cam.eye[1], cam.eye[2]);
      gl.uniform1f(U.body.uEmissive, mat.emissive || 0);
      gl.uniform1f(U.body.uAmbient, CONFIG.material.ambient);
      gl.uniform1f(U.body.uSpecular, mat.specular || 0);
      gl.uniform1f(U.body.uShininess, mat.shininess || 16);
      gl.uniform1f(U.body.uBright, mat.bright || 1);
      gl.uniform1f(U.body.uUseTex, mat.tex ? 1 : 0);
      gl.uniform4f(U.body.uColor, 1, 1, 1, 1);

      if (mat.tex && textures[mat.tex]) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, textures[mat.tex]);
        gl.uniform1i(U.body.uTex, 0);
      }

      bindMesh(sphereMesh, [A.body.pos, A.body.nrm, A.body.uv]);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereMesh.idx);
      gl.drawElements(gl.TRIANGLES, sphereMesh.count, gl.UNSIGNED_SHORT, 0);
    },

    /** 轨道线：单位圆 × 半径 */
    drawRing: function (M, radius, color) {
      gl.useProgram(progFlat);
      uploadMat4(U.flat.uModel, mult(M, scale(radius, radius, radius)));
      uploadMat4(U.flat.uProj, projM);
      uploadMat4(U.flat.uView, cam.view);
      gl.uniform4fv(U.flat.uColor, color);
      gl.uniform1f(U.flat.uPointSize, 1);
      gl.uniform1f(U.flat.uRoundPoints, 0);
      bindMesh(ringMesh, [A.flat.pos]);
      gl.drawArrays(gl.LINE_LOOP, 0, ringMesh.count);
    },

    /** 地球自转轴：单位线段 × 缩放 */
    drawAxis: function (M, color) {
      gl.useProgram(progFlat);
      uploadMat4(U.flat.uModel, M);
      uploadMat4(U.flat.uProj, projM);
      uploadMat4(U.flat.uView, cam.view);
      gl.uniform4fv(U.flat.uColor, color);
      gl.uniform1f(U.flat.uPointSize, 1);
      gl.uniform1f(U.flat.uRoundPoints, 0);
      bindMesh(axisMesh, [A.flat.pos]);
      gl.drawArrays(gl.LINES, 0, axisMesh.count);
    },

    /** 星空：一批 gl.POINTS */
    drawStars: function () {
      gl.useProgram(progFlat);
      uploadMat4(U.flat.uModel, mat4());
      uploadMat4(U.flat.uProj, projM);
      uploadMat4(U.flat.uView, cam.view);
      gl.uniform4fv(U.flat.uColor, CONFIG.colors.stars);
      gl.uniform1f(U.flat.uPointSize, CONFIG.stars.size);
      gl.uniform1f(U.flat.uRoundPoints, 1);
      bindMesh(starMesh, [A.flat.pos]);
      gl.drawArrays(gl.POINTS, 0, starMesh.count);
    },

    /** 太阳光晕：公告板 + 加法混合（rgba 越靠外越透明） */
    drawSunGlow: function (pos, radius) {
      gl.useProgram(progGlow);
      uploadMat4(U.glow.uModel, billboardMatrix(pos, radius * 3.0));
      uploadMat4(U.glow.uProj, projM);
      uploadMat4(U.glow.uView, cam.view);
      gl.uniform3f(U.glow.uColor, 1.0, 0.58, 0.18);
      gl.uniform1f(U.glow.uPower, 2.4);
      gl.uniform1f(U.glow.uStrength, 0.60);
      bindMesh(glowMesh, [A.glow.pos]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  };

  /* ======================= 6. 资源 ======================= */

  var sphereMesh = makeMesh(Geom.sphere(CONFIG.mesh.latBands, CONFIG.mesh.longBands, 1));
  var ringMesh   = makeMesh(Geom.unitRing(CONFIG.mesh.ringSegments));
  var axisMesh   = makeMesh(Geom.unitAxis());
  var starMesh   = makeMesh(Geom.starField(CONFIG.stars.count, CONFIG.stars.rMin,
                                           CONFIG.stars.rMax, CONFIG.stars.seed));
  // 光晕用的单位四边形（TRIANGLE_STRIP 顺序：左下 → 右下 → 左上 → 右上）
  var glowMesh   = makeMesh({ positions: new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]) });

  var tree = Scene.build(R);

  /* ======================= 7. 渲染循环 ======================= */

  var last = 0, fpsAcc = 0, fpsFrames = 0, fps = 0, statusTimer = 0;

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    var h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function drawLayer(entries, layer) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.node.layer === layer && e.node.draw) e.node.draw(e.M, state);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);

    if (!last) last = now;
    var dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, 0.05);                 // 切标签页回来不要"瞬移"

    if (!state.paused) advance(dt);
    resize();

    /* --- 先算世界矩阵（层级逐层相乘），再把地球位置给摄像机做跟拍 --- */
    var entries = Scene.collect(tree, state);
    var earthPos = null, sunPos = [0, 0, 0];
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].node.name === 'earth') earthPos = Scene.positionOf(entries[i].M);
      else if (entries[i].node.name === 'sun') sunPos = Scene.positionOf(entries[i].M);
    }
    cam.update(dt, earthPos);
    projM = cam.projection(canvas.width / Math.max(1, canvas.height));

    /* --- 绘制 --- */
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.004, 0.006, 0.012, 1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // ① 星空：最远，不写深度
    gl.depthMask(false);
    drawLayer(entries, 'sky');

    // ② 太阳光晕：加法混合叠加到背景上（不写深度，随后被太阳球体盖住中心）
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    R.drawSunGlow(sunPos, CONFIG.bodies.sun.radius);
    gl.disable(gl.BLEND);

    // ③ 不透明天体
    gl.depthMask(true);
    drawLayer(entries, 'body');

    // ④ 透明线（轨道线 / 自转轴），混合 + 不写深度
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    drawLayer(entries, 'line');
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    /* --- 状态栏 --- */
    fpsAcc += dt; fpsFrames++; statusTimer += dt;
    if (statusTimer > 0.25) {
      fps = fpsAcc > 0 ? fpsFrames / fpsAcc : 0;
      fpsAcc = 0; fpsFrames = 0; statusTimer = 0;
      updateStatus();
    }
  }

  function updateStatus() {
    var projTxt = cam.proj === 'ortho' ? '正交' : '透视';
    var roamTxt = cam.roamPlaying ? '播放中' : '已暂停 / 鼠标接管';
    var years = state.angles.earthOrbit / 360;
    statusEl.innerHTML =
      '投影 <b>' + projTxt + '</b>（O 切换）　·　漫游 <b>' + roamTxt + '</b>' +
      (state.paused ? '　·　<b>全部运动暂停</b>（P）' : '') +
      '<br>地球年 <span class="k">' + years.toFixed(2) + '</span>' +
      '　·　月相周期 <span class="k">' + (state.angles.moonOrbit / 360).toFixed(2) + '</span>' +
      '　·　<span class="k">' + fps.toFixed(0) + '</span> fps';
  }

  /* ======================= 8. 输入 ======================= */

  function resetAll() {
    state.paused = false;
    state.speed.orbit = 1;
    state.speed.spin = 1;
    state.tilt = CONFIG.bodies.earth.tilt;
    state.incl = CONFIG.bodies.moon.inclination;
    state.showOrbits = true;
    state.showAxis = true;
    state.showStars = true;
    cam.reset();
    UI.sync(state, cam);
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (k === 'o') {
      cam.proj = cam.proj === 'persp' ? 'ortho' : 'persp';
      UI.sync(state, cam);
      e.preventDefault();
    } else if (k === ' ') {
      cam.toggleRoam();
      UI.sync(state, cam);
      e.preventDefault();
    } else if (k === 'p') {
      state.paused = !state.paused;
      e.preventDefault();
    } else if (k === 'r') {
      resetAll();
      e.preventDefault();
    } else if (k >= '1' && k <= '4') {
      cam.applyPreset(['full', 'side', 'top', 'earth'][parseInt(k, 10) - 1]);
      UI.sync(state, cam);
      e.preventDefault();
    }
  }

  /* ======================= 9. URL 参数（截图 / 演示用） =======================
   * 例：?t=8.4&proj=ortho&view=full&roam=0&no=lines&hud=0&shot=1
   *     t=固定模拟秒数（同时冻结时间）  proj=persp|ortho  view=full|side|top|earth
   *     cam=az,el,dist  no=lines,axis,stars  hud=0 隐藏状态栏  shot=1 开启截图缓冲
   * ========================================================================== */
  function applyQuery() {
    if (Q.has('tilt')) state.tilt = parseFloat(Q.get('tilt'));
    if (Q.has('incl')) state.incl = parseFloat(Q.get('incl'));

    if (Q.get('proj') === 'ortho') cam.proj = 'ortho';
    if (Q.get('view')) cam.applyPreset(Q.get('view'));
    if (Q.get('roam') === '0') cam.roamPlaying = false;

    // 把摄像机定格在漫游路径的某一时刻（截图用）
    if (Q.has('roamAt')) {
      var rp = cam.sampleRoam(parseFloat(Q.get('roamAt')));
      cam.az = rp.az;
      cam.el = rp.el;
      cam.dist = rp.dist;
      cam.roamPlaying = false;
    }

    if (Q.has('t')) {
      setFromTime(parseFloat(Q.get('t')));
      state.paused = true;
      cam.roamPlaying = false;
    }

    if (Q.has('cam')) {
      var a = Q.get('cam').split(',').map(Number);
      if (a.length === 3 && a.every(function (v) { return isFinite(v); })) {
        cam.az = a[0]; cam.el = a[1]; cam.dist = a[2];
        cam.roamPlaying = false;
      }
    }

    var no = (Q.get('no') || '').split(',');
    if (no.indexOf('lines') >= 0) state.showOrbits = false;
    if (no.indexOf('axis')  >= 0) state.showAxis = false;
    if (no.indexOf('stars') >= 0) state.showStars = false;
    if (Q.get('hud') === '0') statusEl.classList.add('hidden');
    // ui=0：隐藏左侧参数面板，画布铺满整窗（录屏 / 出图用）
    if (Q.get('ui') === '0') document.getElementById('panel').classList.add('hidden');
  }

  /* ======================= 10. 启动 ======================= */

  Interaction.init(canvas, {
    onDrag: function (dx, dy) {
      cam.drag(dx, dy);
      UI.syncRoam(cam);           // 拖拽即接管 → 面板上的漫游勾选框也要跟着变
    },
    onZoom: function (dz) {
      cam.zoom(dz);
      UI.syncRoam(cam);
    },
    onKey: onKey
  });

  applyQuery();
  UI.init(state, cam, { onReset: resetAll });
  Transforms.selfTest();          // 手造矩阵 vs 解析解，控制台打印误差
  updateStatus();

  Tex.loadAll(gl, {
    sun:   CONFIG.bodies.sun.texture,
    earth: CONFIG.bodies.earth.texture,
    moon:  CONFIG.bodies.moon.texture
  }).then(function (t) {
    textures = t;
    loadingEl.classList.add('hidden');
    last = 0;
    requestAnimationFrame(frame);
  }).catch(function (err) {
    fail('纹理加载失败：' + err.message +
      '\n\n请用静态服务器（http://）打开本页；直接双击 file:// 会被浏览器的跨域策略拦截。' +
      '\n例如在项目目录执行：python -m http.server 8080');
  });
})();
