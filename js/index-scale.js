/* 板块图：相对当前可视窗口起点的涨跌幅。纯函数，供页面与单测共用。不插值、不沿用窗口外的点。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.Hs300IndexScale = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function isNum(v) {
    return v != null && v !== "" && Number.isFinite(Number(v));
  }

  /**
   * values：仅含可视窗口内、按日期升序的收盘价（窗口外的点不要传入）。
   * 第一个非空收盘为基期 P0，该日涨跌幅为 0%；基期之前的空值保持 null。
   * 窗口内后续空值保持 null，不插值。
   */
  function windowRelativeSeries(values) {
    const n = values == null ? 0 : values.length;
    const out = new Array(n).fill(null);
    let baseI = -1;
    let p0 = null;
    for (let i = 0; i < n; i++) {
      if (isNum(values[i])) {
        baseI = i;
        p0 = Number(values[i]);
        break;
      }
    }
    if (baseI < 0 || p0 === 0) return out;
    for (let i = baseI; i < n; i++) {
      if (!isNum(values[i])) continue;
      out[i] = (Number(values[i]) / p0 - 1) * 100;
    }
    return out;
  }

  function firstValidIndex(values) {
    if (!values) return -1;
    for (let i = 0; i < values.length; i++) {
      if (isNum(values[i])) return i;
    }
    return -1;
  }

  return { windowRelativeSeries, firstValidIndex, isNum };
});
