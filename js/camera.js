/* =============================================================================
 *  camera.js —— 摄像机：球坐标定位 + 关键帧漫游 + 鼠标接管
 *
 *  用「方位角 az + 俯仰角 el + 距离 dist」三个量描述机位（球坐标），
 *  再 lookAt(eye, at, up) 得到视图矩阵，比直接摆弄 4×4 矩阵直观得多。
 *
 *  漫游：在 CONFIG.roam.keys 上做「周期 Catmull–Rom 样条」采样。
 *  之所以不用线性插值：线性插值在关键帧处速度突变，镜头会"一顿一顿"；
 *  Catmull–Rom 只用相邻 4 个控制点、C¹ 连续，且天然穿过所有关键帧。
 *  首尾相接（最后一项 t 与第一项同角度）→ 可以无缝循环。
 * ========================================================================== */
(function (global) {
  'use strict';

  var CFG = CONFIG.camera;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** 把角度差折算到 (−180, 180]，避免插值时"绕远路"转 350° */
  function shortestAngle(d) {
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    return d;
  }

  /** 均匀参数 Catmull–Rom 插值 */
  function catmullRom(p0, p1, p2, p3, s) {
    var s2 = s * s, s3 = s2 * s;
    return 0.5 * ((2 * p1) +
      (-p0 + p2) * s +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * s3);
  }

  function createCamera() {
    var K = CONFIG.roam.keys;
    var N = K.length - 1;                  // 段数（首尾相接）

    var C = {
      az: CFG.az,
      el: CFG.el,
      dist: CFG.dist,
      follow: CFG.follow,                  // 'sun' | 'earth'
      proj: 'persp',                       // 'persp' | 'ortho'
      roamPlaying: true,
      roamT: 0,
      eye: vec3(0, 0, 0),
      at: vec3(0, 0, 0),
      view: mat4()
    };

    /* ---- 关键帧取值：j 可以越界，自动环绕并把 az 加上 ±360 ---- */
    function keyAt(j) {
      return K[((j % N) + N) % N];
    }
    function azAt(j) {
      return K[((j % N) + N) % N].az + 360 * Math.floor(j / N);
    }

    /** 在漫游时间 t（秒）处采样机位 */
    C.sampleRoam = function (t) {
      var dur = CONFIG.roam.duration;
      t = ((t % dur) + dur) % dur;
      var i = 0;
      while (i < N - 1 && t >= K[i + 1].t) i++;
      var k1 = K[i], k2 = K[i + 1];
      var span = k2.t - k1.t;
      var s = span > 0 ? (t - k1.t) / span : 0;
      var k0 = keyAt(i - 1), k3 = keyAt(i + 2);
      return {
        az: catmullRom(azAt(i - 1), azAt(i), azAt(i + 1), azAt(i + 2), s),
        el: catmullRom(k0.el, k1.el, k2.el, k3.el, s),
        dist: catmullRom(k0.dist, k1.dist, k2.dist, k3.dist, s)
      };
    };

    /** 每帧更新：先决定球坐标，再算 eye / view */
    C.update = function (dt, followPoint) {
      if (C.roamPlaying) {
        C.roamT += dt;
        var p = C.sampleRoam(C.roamT);
        // 指数趋近：dt 越大追得越快，与帧率无关
        var k = 1 - Math.exp(-CFG.roamRate * dt);
        C.az += shortestAngle(p.az - C.az) * k;
        C.el += (p.el - C.el) * k;
        C.dist += (p.dist - C.dist) * k;
      }

      var at = (C.follow === 'earth' && followPoint) ? followPoint : [0, 0, 0];
      C.at = vec3(at[0], at[1], at[2]);

      var ce = Math.cos(radians(C.el));
      var se = Math.sin(radians(C.el));
      var az = radians(C.az);
      C.eye = vec3(at[0] + C.dist * ce * Math.sin(az),
                   at[1] + C.dist * se,
                   at[2] + C.dist * ce * Math.cos(az));

      C.view = lookAt(C.eye, C.at, vec3(0, 1, 0));
    };

    /**
     * 投影矩阵。
     * 正交投影的半高取 dist·tan(fov/2)，正好等于透视投影在"观察目标所在深度"处的
     * 半高 —— 两种投影下屏幕中心处的物体大小一致，差异只体现在远近
     * （近大远小 / 平行线是否收敛），对比才公平。
     */
    C.projection = function (aspect) {
      if (C.proj === 'ortho') {
        var h = Math.max(0.5, C.dist * Math.tan(radians(CFG.fov) / 2));
        return ortho(-h * aspect, h * aspect, -h, h, CFG.near, CFG.far);
      }
      return perspective(CFG.fov, aspect, CFG.near, CFG.far);
    };

    /* ---- 交互 ---- */

    /** 拖拽：立即接管视角（并暂停漫游，按空格可交还） */
    C.drag = function (dx, dy) {
      C.roamPlaying = false;
      C.az -= dx * CFG.dragSpeed;
      C.el = clamp(C.el + dy * CFG.dragSpeed, -89, 89);
    };

    /** 滚轮推拉 */
    C.zoom = function (deltaY) {
      C.roamPlaying = false;
      C.dist = clamp(C.dist * (1 + deltaY * CFG.zoomSpeed), CFG.minDist, CFG.maxDist);
    };

    /** 切换到预设机位 */
    C.applyPreset = function (name) {
      var p = CONFIG.presets[name];
      if (!p) return;
      C.follow = p.follow;
      C.az = p.az;
      C.el = p.el;
      C.dist = p.dist;
      C.roamPlaying = false;
    };

    /** 空格：暂停 / 继续漫游（继续时把观察目标交还给太阳系中心） */
    C.toggleRoam = function () {
      C.roamPlaying = !C.roamPlaying;
      // 暂停时漫游时间自然冻结（update 里只在 roamPlaying 时累加），镜头停在原处；
      // 恢复时从冻结处继续，并由 update 的指数趋近把视角平滑地拉回路径
      if (C.roamPlaying) C.follow = 'sun';
      return C.roamPlaying;
    };

    /** 重置 = 回到默认机位 + 重新开始漫游 */
    C.reset = function () {
      C.follow = CFG.follow;
      C.az = CFG.az;
      C.el = CFG.el;
      C.dist = CFG.dist;
      C.proj = 'persp';
      C.roamT = 0;
      C.roamPlaying = true;
    };

    return C;
  }

  global.createCamera = createCamera;
})(window);
