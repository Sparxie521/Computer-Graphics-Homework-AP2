/* =============================================================================
 *  interaction.js —— 只负责"收输入"，不解释输入（把事件翻译成语义回调）
 *
 *  不依赖控件库，自己监听拖拽与滚轮；这里用等价的
 *  Pointer Events（鼠标、触控、触控笔统一），行为与 mousedown/mousemove 一致，
 *  并额外获得指针捕获（拖出画布外也不会丢事件）。
 * ========================================================================== */
(function (global) {
  'use strict';

  var Interaction = {};

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} h  { onDragStart, onDrag(dx,dy), onZoom(deltaY), onKey(event) }
   */
  Interaction.init = function (canvas, h) {
    var dragging = false;
    var lastX = 0, lastY = 0;

    canvas.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;              // 只响应左键
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
      canvas.focus();
      if (h.onDragStart) h.onDragStart();
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX;
      var dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dx !== 0 || dy !== 0) h.onDrag(dx, dy);
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      canvas.classList.remove('dragging');
      if (e && canvas.releasePointerCapture && e.pointerId !== undefined) {
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
      }
      if (h.onDragEnd) h.onDragEnd();
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      h.onZoom(e.deltaY);
    }, { passive: false });

    window.addEventListener('keydown', h.onKey);
  };

  global.Interaction = Interaction;
})(window);
