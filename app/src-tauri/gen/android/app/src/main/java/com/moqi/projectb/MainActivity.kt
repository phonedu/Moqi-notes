package com.moqi.projectb

import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * 系统返回键接进应用内导航（用户 2026-10-12 口径：「先关浮层，上一层；编辑态不接」）：
 * 按一次先交给 web 层（`window.__moqiBack`，阶梯在 `ui/useOverlays.useBackNavigation`）——
 * 浮层 → 上一层，全都不接手才退出应用；**编辑态不参与**（那级不接）。
 *
 * ⚠️ 2026-10-12 复盘：**这一段在「0.6 回修批 α–ζ」里被 IME insets 的改写整段误删**
 * （本文件当时被换成「只剩 insets 监听」）⇒ 真机上返回键直接退出应用；而
 * `accept:MOBILE-BACK-1` 只在**浏览器通道**调 JS 侧 `window.__moqiBack` ⇒ **门照绿（门盲区）**。
 * 已恢复；并在 `scripts/css-presence.mjs` 的 MUST 表加一行**结构断言**防止再丢。
 */
class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // ---- 系统返回键（`D-069`）：先问 web 层，不接再退出应用 ----
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val view = webViewRef
        if (view == null) {
          finish()
          return
        }
        view.evaluateJavascript("(window.__moqiBack && window.__moqiBack()) === true") { result ->
          if (result != "true") {
            // web 层不接：还原默认行为（退出应用）。先禁用自己再转发，避免自递归。
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
          }
        }
      }
    })

    // `#8` / `#5①`（2026-10-12）：**宿主侧显式消费 IME inset**。
    //
    // 背景：`enableEdgeToEdge()` 会执行 `setDecorFitsSystemWindows(window, false)`，于是
    // Android 11+ 上「系统自动 resize 窗口」不再可靠——软键盘以 **IME inset** 的形式下发，
    // 若不消费，WebView 铺满全窗、界面纹丝不动（用户现象：「整个界面不会朝上面推」）。
    // 口径见 `10` 二册 §6.3「软键盘与视口」：宿主让 WebView 视口矮下去。
    //
    // 取 **(ii)**（@0 2026-10-12 点名）：**保留 edge-to-edge**（0.6 第零项真机验收过的安全区行为，
    // 回退会重开顶/底安全区风险），改为把 IME 高度显式施加给内容视图的底部——WebView 随之变矮，
    // JS 侧 `innerHeight` 与 `visualViewport` 同缩（`--kb-h ≈ 0`，靠 `dvh`/`100%` 自然重排）；
    // 若某些版本 IME inset 不下发，则 `--kb-h > 0` 由 CSS 把下沿浮层抬起——**两种档同一套前端代码**。
    //
    // **(i) 真机备选**（真机上仍不让位时切换）：`WindowCompat.setDecorFitsSystemWindows(window, true)`。
    // ⚠️ 本文件属生成的 Android 壳，**改动未经真机验证**（标「未验证」，等后续真机批验证）。
    val content = findViewById<ViewGroup>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom
      view.setPadding(0, 0, 0, maxOf(ime, bars))
      insets
    }
    ViewCompat.requestApplyInsets(content)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webViewRef = webView
  }
}
