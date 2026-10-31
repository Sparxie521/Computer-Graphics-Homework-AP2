/* =============================================================================
 *  ui.js —— 只负责"参数面板 DOM ↔ 状态对象"的双向同步
 *  控件直接改写 state / cam，渲染循环每帧读状态（单向数据流：UI → state → 渲染）
 * ========================================================================== */
(function (global) {
  'use strict';

  var UI = {};

  function $(id) { return document.getElementById(id); }

  /**
   * @param {object} state 全局状态（速度、倾角、显示开关…）
   * @param {object} cam   摄像机
   * @param {object} actions { onReset }
   */
  UI.init = function (state, cam, actions) {
    var el = {
      projRadios: document.querySelectorAll('input[name="proj"]'),
      preset:  $('ctl-preset'),
      roam:    $('ctl-roam'),
      orbit:   $('ctl-orbit'),   vOrbit: $('val-orbit'),
      spin:    $('ctl-spin'),    vSpin:  $('val-spin'),
      tilt:    $('ctl-tilt'),    vTilt:  $('val-tilt'),
      incl:    $('ctl-incl'),    vIncl:  $('val-incl'),
      orbits:  $('ctl-orbits'),
      axis:    $('ctl-axis'),
      stars:   $('ctl-stars'),
      reset:   $('ctl-reset')
    };

    /* ---------- 投影 ---------- */
    Array.prototype.forEach.call(el.projRadios, function (r) {
      r.addEventListener('change', function () {
        if (r.checked) cam.proj = r.value;
      });
    });

    /* ---------- 预设视角 ---------- */
    el.preset.addEventListener('change', function () {
      cam.applyPreset(el.preset.value);
      UI.sync(state, cam);
    });

    /* ---------- 漫游开关 ---------- */
    el.roam.addEventListener('change', function () {
      if (el.roam.checked !== cam.roamPlaying) cam.toggleRoam();
    });

    /* ---------- 速度 / 倾角 ---------- */
    el.orbit.addEventListener('input', function () {
      state.speed.orbit = parseFloat(el.orbit.value);
      el.vOrbit.textContent = state.speed.orbit.toFixed(2) + '×';
    });
    el.spin.addEventListener('input', function () {
      state.speed.spin = parseFloat(el.spin.value);
      el.vSpin.textContent = state.speed.spin.toFixed(2) + '×';
    });
    el.tilt.addEventListener('input', function () {
      state.tilt = parseFloat(el.tilt.value);
      el.vTilt.textContent = state.tilt.toFixed(1) + '°';
    });
    el.incl.addEventListener('input', function () {
      state.incl = parseFloat(el.incl.value);
      el.vIncl.textContent = state.incl.toFixed(2) + '°';
    });

    /* ---------- 显示开关 ---------- */
    el.orbits.addEventListener('change', function () { state.showOrbits = el.orbits.checked; });
    el.axis.addEventListener('change', function () { state.showAxis = el.axis.checked; });
    el.stars.addEventListener('change', function () { state.showStars = el.stars.checked; });

    /* ---------- 重置 ---------- */
    el.reset.addEventListener('click', function () {
      if (actions && actions.onReset) actions.onReset();
      UI.sync(state, cam);
    });

    UI._el = el;
    UI.sync(state, cam);
  };

  /** 只同步"漫游"开关（拖拽接管视角时用，避免整面板重刷） */
  UI.syncRoam = function (cam) {
    if (UI._el) UI._el.roam.checked = cam.roamPlaying;
  };

  /** 把 state / cam 的当前值刷回控件（键盘操作后也需要同步） */
  UI.sync = function (state, cam) {
    var el = UI._el;
    if (!el) return;

    Array.prototype.forEach.call(el.projRadios, function (r) { r.checked = (r.value === cam.proj); });

    el.roam.checked = cam.roamPlaying;
    el.orbits.checked = state.showOrbits;
    el.axis.checked = state.showAxis;
    el.stars.checked = state.showStars;

    el.orbit.value = state.speed.orbit;
    el.spin.value = state.speed.spin;
    el.tilt.value = state.tilt;
    el.incl.value = state.incl;

    el.vOrbit.textContent = state.speed.orbit.toFixed(2) + '×';
    el.vSpin.textContent = state.speed.spin.toFixed(2) + '×';
    el.vTilt.textContent = state.tilt.toFixed(1) + '°';
    el.vIncl.textContent = state.incl.toFixed(2) + '°';
  };

  global.UI = UI;
})(window);
