package de.multiview.tv;

import android.app.ActivityManager;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * App-Log fuer die Website (js/logger.js schickt alles automatisch weg):
 * - Abstuerze der App und des WebView-Renderers landen in einer Datei und werden beim naechsten
 *   Start an die Seite gegeben (window.MultiViewLog.takeCrash()).
 * - Konsolenmeldungen aus den Twitch-Player-iframes, die die Seite selbst nicht sieht, werden an
 *   window.mvLog weitergereicht.
 * - window.MultiViewLog.device() nennt Geraet, Fire OS / Android und WebView-Version.
 */
public final class CrashLog {
    private static final String FILE = "crash.txt";
    private static final int MAX_FRAME_MSGS_PER_MIN = 30;

    private final Context ctx;
    private long frameWindow = 0;
    private int frameCount = 0;

    CrashLog(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    /** Fangt Abstuerze der App ab (danach stuerzt sie wie gewohnt ab). */
    void install() {
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, ex) -> {
            try {
                StringWriter sw = new StringWriter();
                try (PrintWriter pw = new PrintWriter(sw)) {
                    ex.printStackTrace(pw);
                }
                write("App-Absturz im Thread " + thread.getName() + ":\n" + sw);
            } catch (Throwable ignored) {
            }
            if (prev != null) prev.uncaughtException(thread, ex);
        });
    }

    /** Merkt sich, dass der WebView-Renderer beendet wurde (Speicher voll oder Absturz). */
    void rendererGone(boolean didCrash) {
        write(didCrash ? "WebView-Renderer abgestuerzt" : "WebView-Renderer von Android beendet (Speicher knapp)");
    }

    private synchronized void write(String text) {
        String stamp = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(new Date());
        try (FileOutputStream out = new FileOutputStream(new File(ctx.getFilesDir(), FILE), true)) {
            out.write(("[" + stamp + "] " + text + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (Throwable ignored) {
        }
    }

    private synchronized String take() {
        File f = new File(ctx.getFilesDir(), FILE);
        if (!f.exists()) return "";
        try {
            byte[] data = new byte[(int) Math.min(f.length(), 20000)];
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                int n = 0;
                while (n < data.length) {
                    int r = in.read(data, n, data.length - n);
                    if (r < 0) break;
                    n += r;
                }
            }
            return new String(data, StandardCharsets.UTF_8);
        } catch (Throwable e) {
            return "";
        } finally {
            if (!f.delete()) f.deleteOnExit();
        }
    }

    String device() {
        StringBuilder sb = new StringBuilder();
        sb.append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
            .append(" (").append(Build.DEVICE).append(')')
            .append(", Android ").append(Build.VERSION.RELEASE).append(" / API ").append(Build.VERSION.SDK_INT);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                PackageInfo wv = WebView.getCurrentWebViewPackage();
                if (wv != null) sb.append(", WebView ").append(wv.versionName);
            }
        } catch (Throwable ignored) {
        }
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return sb.toString();
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            sb.append(", RAM ").append(mi.totalMem / (1024 * 1024)).append(" MB (frei ")
                .append(mi.availMem / (1024 * 1024)).append(" MB)")
                .append(", App-Speicher ").append(am.getLargeMemoryClass()).append(" MB");
        } catch (Throwable ignored) {
        }
        return sb.toString();
    }

    /**
     * Konsole aus fremden Frames (Twitch-Player) an die Seite geben. Meldungen der eigenen Seite
     * faengt js/logger.js selbst ab. Gibt false zurueck, damit Android sie weiter ins Logcat schreibt.
     */
    boolean console(WebView web, ConsoleMessage m) {
        String src = m.sourceId() == null ? "" : m.sourceId();
        if (src.startsWith(BuildConfig.START_URL) || src.isEmpty()) return false;
        // Nur Warnungen und Fehler: das Plaudern des Twitch-Players kostet den Stick sonst
        // jedes Mal einen Sprung in die Seite.
        ConsoleMessage.MessageLevel lvl = m.messageLevel();
        if (lvl != ConsoleMessage.MessageLevel.ERROR && lvl != ConsoleMessage.MessageLevel.WARNING) return false;
        long now = System.currentTimeMillis();
        if (now - frameWindow > 60000) {
            frameWindow = now;
            frameCount = 0;
        }
        if (++frameCount > MAX_FRAME_MSGS_PER_MIN) return false;
        String type = lvl == ConsoleMessage.MessageLevel.ERROR ? "error" : "warn";
        String text = "[" + shortSource(src) + ":" + m.lineNumber() + "] " + m.message();
        web.evaluateJavascript("window.mvLog && window.mvLog(" + JSONObject.quote(type) + ","
            + JSONObject.quote(text) + ")", null);
        return false;
    }

    /** Jede Taste der Fernbedienung, so wie die App sie bekommt (zum Vergleich mit KEY im Seiten-Log). */
    void key(WebView web, int code) {
        String name = android.view.KeyEvent.keyCodeToString(code).replace("KEYCODE_", "");
        web.evaluateJavascript("window.mvLog && window.mvLog('remote'," + JSONObject.quote(name) + ")", null);
    }

    private static String shortSource(String src) {
        int q = src.indexOf('?');
        if (q >= 0) src = src.substring(0, q);
        return src.length() > 80 ? "..." + src.substring(src.length() - 77) : src;
    }

    /** Fuer die Website: window.MultiViewLog */
    public final class Bridge {
        @JavascriptInterface
        public String device() {
            return CrashLog.this.device();
        }

        @JavascriptInterface
        public String takeCrash() {
            return take();
        }
    }
}
