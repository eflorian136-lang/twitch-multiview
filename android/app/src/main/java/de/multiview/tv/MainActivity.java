package de.multiview.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Fullscreen WebView that shows the MultiView website.
 * Remote: arrows/OK are passed to the page; Menu and Back call JS hooks.
 */
public class MainActivity extends Activity {
    private WebView web;
    private boolean showingError = false;

    private static final String ERROR_PAGE =
        "<html><body style='background:#0e0e10;color:#efeff1;font:28px sans-serif;display:flex;"
        + "align-items:center;justify-content:center;height:100vh;margin:0;text-align:center'>"
        + "<div>Keine Verbindung zum Internet.<br><br>OK druecken zum Neuladen.</div></body></html>";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // keeps the channel list (localStorage)
        s.setMediaPlaybackRequiresUserGesture(false); // streams start with sound
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showError();
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int code, String desc, String url) {
                if (url != null && url.equals(view.getUrl())) showError();
            }
        });

        setContentView(web);
        hideSystemUi();

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(BuildConfig.START_URL);
        web.requestFocus();
    }

    private void showError() {
        showingError = true;
        web.loadDataWithBaseURL(null, ERROR_PAGE, "text/html", "utf-8", null);
    }

    private void reload() {
        showingError = false;
        web.loadUrl(BuildConfig.START_URL);
    }

    private void hideSystemUi() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        if (e.getAction() != KeyEvent.ACTION_DOWN) {
            return (code == KeyEvent.KEYCODE_MENU || code == KeyEvent.KEYCODE_BACK) || super.dispatchKeyEvent(e);
        }
        if (showingError && (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER)) {
            reload();
            return true;
        }
        if (code == KeyEvent.KEYCODE_MENU) {
            web.evaluateJavascript("window.toggleMenu && window.toggleMenu()", null);
            return true;
        }
        if (code == KeyEvent.KEYCODE_BACK) {
            if (showingError) {
                finish();
                return true;
            }
            web.evaluateJavascript("window.handleBack ? window.handleBack() : 'exit'", result -> {
                if (result == null || result.contains("exit")) finish();
            });
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        hideSystemUi();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
