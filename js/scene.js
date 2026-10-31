/* =============================================================================
 *  scene.js —— 场景图（层级变换树）+ 逐层矩阵相乘
 *
 *  ★ 层级结构（README 中的「变换嵌套树」即此）：
 *
 *      root
 *      ├── sun                M = Ry(自转) · S(3.0)
 *      ├── earthOrbit         M = Ry(公转角)                          ── 外层：公转轨道变换
 *      │   └── earthCenter    M = · T(12,0,0)                         ── 地球中心节点
 *      │       ├── earth      M = · Rz(23.5°) · Ry(自转角) · S(0.95)  ── 内层：先转后挂
 *      │       ├── earthAxis  M = · Rz(23.5°) · S(1.85)
 *      │       └── moonOrbit  M = · [Ry(Ω)Rx(i)Ry(−Ω)] · Ry(月公转角) ── 手工矩阵：轨道面倾角
 *      │           └── moon   M = · T(2.4,0,0) · Ry(180°) · S(0.26)
 *      └── stars              M = I
 *
 *  每个节点的 local(state) 只给出「相对父节点」的矩阵；世界矩阵由 collect() 沿树
 *  逐层 mult 得到：M_world = M_parent · M_local。
 *  这与显式维护一个 push/pop 矩阵栈完全等价（递归传参天然就是栈：函数返回即"弹栈"），
 *  而且不会出现漏 pop 导致的后面的物体被错误累积变换的问题。
 *
 *  ★ 为什么倾角必须放在内层：
 *      M = R_轨道 · T · R_倾角 · R_自转 · S   → 地球绕太阳转，且自转轴始终相对
 *                                               轨道半径方向倾斜 23.5°（先转后挂）
 *      若写成 M = R_倾角 · R_轨道 · T · …      → 整条轨道都被掀翻 23.5°，
 *                                               太阳系结构就错了（顺序决定结构）
 * ========================================================================== */
(function (global) {
  'use strict';

  var Scene = {};
  var X = global.Transforms;

  /**
   * 构建场景图。R 是渲染器（由 main.js 注入，scene 只调用、不关心 GL 细节）。
   * 节点字段：
   *   name     节点名（调试 / 取世界矩阵用）
   *   layer    'body' 不透明球体 | 'line' 透明线 | 'sky' 星空 | null 只做变换中转
   *   local(s) 相对父节点的 4×4 矩阵
   *   draw(M, s) 绘制回调（M 为该节点的世界矩阵）
   *   children 子节点数组
   */
  Scene.build = function (R) {
    var B = CONFIG.bodies;
    var M = CONFIG.material;
    var C = CONFIG.colors;

    /* ---------------- 月球（叶子） ---------------- */
    var moon = {
      name: 'moon',
      layer: 'body',
      local: function () {
        // 位置在倾角坐标系里沿 +x 走 orbitRadius；潮汐锁定 = 不再额外自转，
        // 因为 moonOrbit 的坐标系本身已经跟着公转角一起转（见 README）
        return mult(X.translateX(B.moon.orbitRadius),
                    mult(X.spinY(B.moon.nearFace), X.scaleUniform(B.moon.radius)));
      },
      draw: function (m) {
        R.drawBody(m, {
          tex: 'moon', emissive: 0,
          specular: M.moonSpecular, shininess: M.moonShininess, bright: 1.0
        });
      }
    };

    /* ---------------- 月球轨道面：手工矩阵所在节点 ---------------- */
    var moonOrbit = {
      name: 'moonOrbit',
      layer: 'line',
      local: function (s) {
        var plane = X.moonOrbitPlane(B.moon.nodeAngle, s.incl);   // ★ 手造矩阵
        return mult(plane, X.spinY(s.angles.moonOrbit));
      },
      draw: function (m, s) {
        if (s.showOrbits) R.drawRing(m, B.moon.orbitRadius, C.orbitMoon);
      },
      children: [moon]
    };

    /* ---------------- 地球 ---------------- */
    var earth = {
      name: 'earth',
      layer: 'body',
      local: function (s) {
        // ★ 内层：先在地球自身坐标系里"先倾角、后自转"
        return mult(mult(X.tiltZ(s.tilt), X.spinY(s.angles.earthSpin)),
                    X.scaleUniform(B.earth.radius));
      },
      draw: function (m) {
        R.drawBody(m, {
          tex: 'earth', emissive: 0,
          specular: M.earthSpecular, shininess: M.earthShininess, bright: 1.0
        });
      }
    };

    /* ---------------- 地球自转轴（可视化 23.5°） ---------------- */
    var earthAxis = {
      name: 'earthAxis',
      layer: 'line',
      local: function (s) {
        return mult(X.tiltZ(s.tilt), X.scaleUniform(B.earth.radius * 1.95));
      },
      draw: function (m, s) {
        if (s.showAxis) R.drawAxis(m, C.axis);
      }
    };

    /* ---------------- 地球中心节点：T(12,0,0) ---------------- */
    var earthCenter = {
      name: 'earthCenter',
      layer: null,
      local: function () { return X.translateX(B.earth.orbitRadius); },
      children: [earth, earthAxis, moonOrbit]
    };

    /* ---------------- 地球公转（外层） ---------------- */
    var earthOrbit = {
      name: 'earthOrbit',
      layer: 'line',
      local: function (s) { return X.spinY(s.angles.earthOrbit); },
      draw: function (m, s) {
        if (s.showOrbits) R.drawRing(m, B.earth.orbitRadius, C.orbitEarth);
      },
      children: [earthCenter]
    };

    /* ---------------- 太阳 ---------------- */
    var sun = {
      name: 'sun',
      layer: 'body',
      local: function (s) {
        return mult(X.spinY(s.angles.sunSpin), X.scaleUniform(B.sun.radius));
      },
      draw: function (m) {
        R.drawBody(m, { tex: 'sun', emissive: 1, bright: M.sunBright });
      }
    };

    /* ---------------- 星空背景 ---------------- */
    var stars = {
      name: 'stars',
      layer: 'sky',
      local: function () { return mat4(); },
      draw: function (m, s) { if (s.showStars) R.drawStars(); }
    };

    return {
      name: 'root',
      layer: null,
      local: function () { return mat4(); },
      children: [sun, earthOrbit, stars]
    };
  };

  /**
   * 一次遍历求出所有节点的世界矩阵。
   * 返回 [{ node, M }, ...]，按「先父后子」的顺序排列。
   */
  Scene.collect = function (root, state) {
    var out = [];

    (function walk(node, parentM) {
      var m = node.local ? mult(parentM, node.local(state)) : parentM;
      out.push({ node: node, M: m });
      if (node.children) {
        for (var i = 0; i < node.children.length; i++) walk(node.children[i], m);
      }
    })(root, mat4());

    return out;
  };

  /** 取某节点世界矩阵的平移分量（行主序，平移在第 4 列） */
  Scene.positionOf = function (m) {
    return [m[0][3], m[1][3], m[2][3]];
  };

  global.Scene = Scene;
})(window);
