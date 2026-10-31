/* =============================================================================
 *  textures.js —— 位图纹理加载（gl.texImage2D + UNPACK_FLIP_Y_WEBGL）
 *
 *  ★ 地球纹理"上下颠倒"的经典问题：
 *
 *  位图（JPEG/PNG）在文件里是「第 0 行在最上面」存储的（top-down），而 OpenGL/WebGL
 *  的纹理坐标系原点在「左下角」(bottom-left)，t 轴向上。若原样上传，
 *  图像的最上面一行会变成纹理坐标 t=0 —— 即北极跑到了 t=0（下方），
 *  球体就会出现「南极朝上、地图上下颠倒」。
 *
 *  两种等价修法（本项目用第 1 种，并在 README 中说明另一种）：
 *    ① gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true) —— 上传时把图像行序翻转，
 *       之后 v=1 对应图像顶部（北极）。本项目采用。注意：这是「全局像素存储状态」，
 *       用完必须复位为 false，否则后续所有 texImage2D 都会被意外翻转。
 *    ② 保持 FLIP_Y = false，改为在 UV 上动手：球体 UV 采用 v = i / latBands
 *       （北极 v=0），与 geometry.js 里 v = 1 − i/latBands 恰好互补。
 *       两种写法结果完全一致，二选一即可，混用才会出错。
 * ========================================================================== */
(function (global) {
  'use strict';

  var Tex = {};

  /**
   * 加载一张纹理。返回 Promise<WebGLTexture>。
   * @param {WebGL2RenderingContext} gl
   * @param {string} url
   */
  Tex.load = function (gl, url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);

        // ★ 关键：翻转 Y，解决自上而下存储的位图与左下角为原点的纹理坐标不一致的问题
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   // 复位全局状态

        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        // 经度方向（u）必须 REPEAT，否则接缝处会出现一条亮缝；
        // 纬度方向（v）用 CLAMP_TO_EDGE，两极不会采样到对面的像素
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // 各向异性过滤（可选）：球体侧视时贴图会被强烈压缩，开一点能显著减少模糊
        var aniso = gl.getExtension('EXT_texture_filter_anisotropic');
        if (aniso) {
          var max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
          gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
        }

        gl.bindTexture(gl.TEXTURE_2D, null);
        resolve(tex);
      };
      img.onerror = function () {
        reject(new Error('纹理加载失败：' + url));
      };
      img.src = url;
    });
  };

  /**
   * 批量加载。map: { sun: 'textures/sun.jpg', ... } → Promise<{ sun: tex, ... }>
   */
  Tex.loadAll = function (gl, map) {
    var keys = Object.keys(map);
    return Promise.all(keys.map(function (k) { return Tex.load(gl, map[k]); }))
      .then(function (list) {
        var out = {};
        keys.forEach(function (k, i) { out[k] = list[i]; });
        return out;
      });
  };

  global.Tex = Tex;
})(window);
