/* =============================================================================
 *  transforms.js —— 手工构造的变换矩阵（mat4 + rotate + mult 组合）
 *
 *  整个场景里只有一处运动不是"调库里的复合函数"，而是用 MV.js 的基本变换
 *  （mat4 单位阵 + rotate + translate）逐个 mult 出来的：
 *      ★ 月球轨道面倾角矩阵  R = Ry(Ω) · Rx(i) · Ry(−Ω)
 *
 *  为什么不能简单写 rotate(i, [0,0,1])？
 *  因为月球的轨道平面要绕「升交点轴」倾斜。升交点轴是黄道面 (xz 平面) 内一条
 *  方位角为 Ω 的直线，不是坐标轴。绕任意轴的旋转可以由三次基本旋转"夹"出来
 *  （共轭 / 相似变换，教材 Ch4 变换推导）：
 *
 *      R_u(i) = Ry(Ω) · Rx(i) · Ry(−Ω)
 *
 *  几何直观（依次施加，注意矩阵从右往左作用于点）：
 *      ① Ry(−Ω)：把"升交点轴"转到 x 轴上；
 *      ② Rx(i)  ：现在绕 x 轴倾斜 i 度，就是绕升交点轴倾斜；
 *      ③ Ry(Ω)  ：把一切转回原方位。
 *  三个矩阵相乘得到 3×3 结果为（c = cosΩ, s = sinΩ, ci = cos i, si = sin i）：
 *
 *      ┌ c² + s²·ci    s·si      c·s·(ci − 1) ┐   ← 绕 u=(cosΩ, 0, −sinΩ) 转 i 度
 *      │ −s·si         ci        −c·si         │      正是 Rodrigues 公式
 *      └ c·s·(ci − 1)  c·si      s² + c²·ci    ┘      Ⅰ·ci + si·[u]× + (1−ci)·uuᵀ
 *
 *  自洽性检查：Ω = 0 时退化为 Rx(i)；且 R·u = u（u 是该旋转的不动轴，
 *  即"升交点轴"，倾角绕它施加，月球轨道面因此只倾斜不扭转）。
 *
 *  该结果已写入 moonPlaneClosedForm()，启动时与"三次 rotate + mult"的结果逐元素
 *  比对（误差 < 1e-12），既验证了代码，也验证了手工 mult 的顺序。
 * ========================================================================== */
(function (global) {
  'use strict';

  var X = {};

  /* ---------------- 基本变换的语义化包装（都是 MV.js 原语） ---------------- */

  /** 绕 z 轴旋转 deg 度 —— 地球自转轴的倾角方向 */
  X.tiltZ = function (deg) {
    return rotate(deg, [0, 0, 1]);
  };

  /** 绕 y 轴旋转 deg 度 —— 自转 / 公转 */
  X.spinY = function (deg) {
    return rotate(deg, [0, 1, 0]);
  };

  /** 绕 x 轴旋转 deg 度 */
  X.rotX = function (deg) {
    return rotate(deg, [1, 0, 0]);
  };

  /** 等比缩放 r */
  X.scaleUniform = function (r) {
    return scale(r, r, r);
  };

  /** 平移 (x, 0, 0) 的语义化写法 */
  X.translateX = function (x) {
    return translate(x, 0, 0);
  };

  /* ---------------- ★ 手工矩阵：月球轨道面倾角 ---------------- */

  /**
   * 月球轨道面倾角矩阵（不用复合函数，三次基本旋转手搓 mult）。
   * @param {number} nodeDeg  升交点方位角 Ω（度）
   * @param {number} inclDeg  轨道倾角 i（度）
   * @returns {mat4}
   */
  X.moonOrbitPlane = function (nodeDeg, inclDeg) {
    var m = mat4();                                  // ① 单位阵起步
    m = mult(m, X.spinY(nodeDeg));                   // ② Ry(Ω)
    m = mult(m, X.rotX(inclDeg));                    // ③ ·Rx(i)
    m = mult(m, X.spinY(-nodeDeg));                  // ④ ·Ry(−Ω)  —— 三步共轭
    return m;
  };

  /**
   * 上面那个矩阵的解析解（推导见文件头注释），用于自检。
   * @returns {mat4}
   */
  X.moonPlaneClosedForm = function (nodeDeg, inclDeg) {
    var O = radians(nodeDeg), i = radians(inclDeg);
    var c = Math.cos(O), s = Math.sin(O);
    var ci = Math.cos(i), si = Math.sin(i);
    var cs = c * s;

    return mat4(
      c * c + s * s * ci,   s * si,        cs * (ci - 1),   0,
      -s * si,              ci,            -c * si,         0,
      cs * (ci - 1),        c * si,        s * s + c * c * ci, 0,
      0,                    0,             0,               1
    );
  };

  /** 两个 4×4 矩阵逐元素最大差 */
  X.maxDiff = function (A, B) {
    var m = 0;
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) {
        m = Math.max(m, Math.abs(A[i][j] - B[i][j]));
      }
    }
    return m;
  };

  /**
   * 启动自检：把 hand-built 矩阵与解析解对比。
   * 控制台会打印一行 [矩阵自检]，零误差说明手工 mult 的顺序完全正确。
   */
  X.selfTest = function () {
    var cases = [[30, 5.15], [0, 23.5], [75, 40], [200, 12.7]];
    var worst = 0;
    cases.forEach(function (cs) {
      worst = Math.max(worst, X.maxDiff(
        X.moonOrbitPlane(cs[0], cs[1]),
        X.moonPlaneClosedForm(cs[0], cs[1])
      ));
    });
    console.log('[矩阵自检] moonOrbitPlane = Ry(Ω)·Rx(i)·Ry(−Ω) 与解析解最大误差 = ' +
      worst.toExponential(2) + (worst < 1e-12 ? '  ✔' : '  ✘'));
    return worst;
  };

  global.Transforms = X;
})(window);
