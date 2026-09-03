/* theme-bootstrap.js — 12b: 从 index.html 内联 <script> 迁出（CSP script-src 'self' 清洁化）。
 * Vite 将 public/ 逐字复制到 out/renderer/，classic（非 module）脚本在 <head> 中
 * 解析阻塞执行 → 仍先于 body 首帧，保持 T30 无 FOUC 语义。
 * 逻辑与内联版逐字等价：同步设置 data-theme / colorScheme / class / lang。 */
(function () {
  try {
    var k = 'las:theme'
    var lk = 'las:locale'
    var m = localStorage.getItem(k) || 'system'
    var s = m
    if (m === 'system') {
      try {
        s = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      } catch (e) {
        s = 'light'
      }
    }
    document.documentElement.setAttribute('data-theme', s)
    document.documentElement.style.colorScheme = s
    document.documentElement.classList.remove('light', 'dark')
    document.documentElement.classList.add(s)
    var loc = localStorage.getItem(lk) || 'zh-CN'
    if (loc) document.documentElement.lang = loc
  } catch (e) {}
})()
