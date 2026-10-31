/* =============================================================================
 *  geometry.js —— 只负责"算顶点"，不碰 WebGL 状态、不碰 DOM
 *
 *  生成三类数据：
 *    1. 经纬球（位置 + 法线 + 纹理坐标 + 索引）—— 太阳 / 地球 / 月球共用一份网格，
 *       靠模型矩阵里的 scale 调整大小，省显存也省代码。
 *    2. 单位圆（半径 1，xz 平面，LINE_LOOP）—— 轨道线；用矩阵缩放到所需半径。
 *    3. 单位轴线段（y ∈ [-1, 1]）—— 地球自转轴；同样靠矩阵缩放。
 *    4. 星空点（球壳内随机分布，固定种子）—— gl.POINTS。
 * ========================================================================== */
(function (global) {
  'use strict';

  var Geom = {};

  /**
   * 经纬球。
   * 参数化（右手系，y 轴向上，北极在 +y）：
   *     phi   = π · i / latBands          i = 0(北极) … latBands(南极)
   *     theta = 2π · j / longBands        j = 0 … longBands(经度绕一圈)
   *     x = sinφ·cosθ,  y = cosφ,  z = sinφ·sinθ
   *
   * 纹理坐标：u = j / longBands（经度 0→1，首尾在 ±180° 经线处接缝）
   *           v = 1 − i / latBands（★ 北极 v=1，南极 v=0）
   *
   * v 的方向必须和纹理上传时的 UNPACK_FLIP_Y_WEBGL 配套，否则地球会出现
   * "南极朝上"的上下颠倒，详见 textures.js 与 README。
   */
  Geom.sphere = function (latBands, longBands, radius) {
    radius = radius || 1;
    var pos = [], nrm = [], uv = [], idx = [];
    var i, j;

    for (i = 0; i <= latBands; i++) {
      var phi = Math.PI * i / latBands;
      var sy = Math.cos(phi), sr = Math.sin(phi);
      for (j = 0; j <= longBands; j++) {
        var theta = 2 * Math.PI * j / longBands;
        var x = sr * Math.cos(theta);
        var z = sr * Math.sin(theta);
        pos.push(radius * x, radius * sy, radius * z);
        nrm.push(x, sy, z);                                  // 单位球法线 = 位置方向
        uv.push(j / longBands, 1 - i / latBands);
      }
    }

    // 逆时针绕序（从球外看），这样开启背面剔除时朝外的面不会被剔掉
    for (i = 0; i < latBands; i++) {
      for (j = 0; j < longBands; j++) {
        var a = i * (longBands + 1) + j;
        var b = a + longBands + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }

    return {
      positions: new Float32Array(pos),
      normals: new Float32Array(nrm),
      uvs: new Float32Array(uv),
      indices: new Uint16Array(idx),
      vertexCount: latBands * longBands * 6,
      indexed: true
    };
  };

  /** 单位圆（xz 平面，y = 0），闭合 LINE_LOOP。 */
  Geom.unitRing = function (segments) {
    var pts = [];
    for (var k = 0; k < segments; k++) {
      var a = 2 * Math.PI * k / segments;
      pts.push(Math.cos(a), 0, Math.sin(a));
    }
    return { positions: new Float32Array(pts), vertexCount: segments, indexed: false };
  };

  /** 单位轴线段：y 从 −1 到 +1（2 个顶点，gl.LINES）。 */
  Geom.unitAxis = function () {
    return { positions: new Float32Array([0, -1, 0, 0, 1, 0]), vertexCount: 2, indexed: false };
  };

  /**
   * 星空：在半径 [rMin, rMax] 的球壳内均匀撒点。
   * 用固定种子的线性同余发生器（LCG），保证每次刷新星图一致 → 截图可复现。
   */
  Geom.starField = function (count, rMin, rMax, seed) {
    var s = seed >>> 0;
    function rnd() {                       // 0 ≤ rnd() < 1
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    }
    var pts = [];
    for (var k = 0; k < count; k++) {
      // 均匀球面方向：z 均匀取 cosθ，方位角均匀取 φ
      var u = 2 * rnd() - 1;               // cos(theta)
      var phi = 2 * Math.PI * rnd();
      var r = rMin + (rMax - rMin) * Math.cbrt(rnd());
      var st = Math.sqrt(1 - u * u);
      pts.push(r * st * Math.cos(phi), r * u, r * st * Math.sin(phi));
    }
    return { positions: new Float32Array(pts), vertexCount: count, indexed: false };
  };

  global.Geom = Geom;
})(window);
