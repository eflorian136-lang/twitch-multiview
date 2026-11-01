package de.multiview.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Checks version.json of the GitHub release and installs a newer APK.
 * Android always asks the user to confirm an install; silent updates are not possible.
 */
public class Updater {
    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean busy = false;

    public Updater(Activity activity) {
        this.activity = activity;
    }

    /** manual=true shows "no update" / error messages too. */
    public void check(final boolean manual) {
        if (busy || BuildConfig.UPDATE_URL.isEmpty()) return;
        busy = true;
        new Thread(() -> {
            try {
                JSONObject info = new JSONObject(new String(download(BuildConfig.UPDATE_URL), "UTF-8"));
                final int latest = info.getInt("versionCode");
                final String apkUrl = info.getString("apk");
                main.post(() -> {
                    busy = false;
                    if (latest > BuildConfig.VERSION_CODE) ask(latest, apkUrl);
                    else if (manual) toast("App ist aktuell (Version " + BuildConfig.VERSION_CODE + ")");
                });
            } catch (Exception e) {
                main.post(() -> {
                    busy = false;
                    if (manual) toast("Update-Pruefung fehlgeschlagen");
                });
            }
        }).start();
    }

    private void ask(int latest, String apkUrl) {
        if (activity.isFinishing()) return;
        new AlertDialog.Builder(activity)
            .setTitle("Update verfuegbar")
            .setMessage("Neue Version " + latest + " (installiert: " + BuildConfig.VERSION_CODE + "). Jetzt aktualisieren?")
            .setPositiveButton("Aktualisieren", (d, w) -> downloadAndInstall(apkUrl))
            .setNegativeButton("Spaeter", null)
            .show();
    }

    private void downloadAndInstall(final String apkUrl) {
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            toast("Bitte MultiView erlauben, Apps zu installieren, dann erneut versuchen");
            try {
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())));
            } catch (ActivityNotFoundException e) {
                toast("Einstellungen > Mein Fire TV > Entwickleroptionen > Apps unbekannter Herkunft > MultiView");
            }
            return;
        }
        toast("Lade Update...");
        busy = true;
        new Thread(() -> {
            try {
                File dir = new File(activity.getCacheDir(), ApkProvider.DIR);
                dir.mkdirs();
                File apk = new File(dir, ApkProvider.FILE);
                try (OutputStream out = new FileOutputStream(apk)) {
                    out.write(download(apkUrl));
                }
                main.post(() -> {
                    busy = false;
                    install();
                });
            } catch (Exception e) {
                main.post(() -> {
                    busy = false;
                    toast("Download fehlgeschlagen");
                });
            }
        }).start();
    }

    private void install() {
        Uri uri = Uri.parse("content://" + activity.getPackageName() + ".apk/" + ApkProvider.FILE);
        Intent i = new Intent(Intent.ACTION_INSTALL_PACKAGE);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            activity.startActivity(i);
        } catch (ActivityNotFoundException e) {
            toast("Installation nicht moeglich");
        }
    }

    private static byte[] download(String url) throws Exception {
        // follow redirects manually (GitHub release -> CDN)
        for (int i = 0; i < 6; i++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(60000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", "MultiViewTV");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                c.disconnect();
                continue;
            }
            if (code != 200) throw new Exception("HTTP " + code);
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] b = new byte[16384];
                int n;
                while ((n = in.read(b)) > 0) buf.write(b, 0, n);
                return buf.toByteArray();
            } finally {
                c.disconnect();
            }
        }
        throw new Exception("too many redirects");
    }

    private void toast(String s) {
        Toast.makeText(activity, s, Toast.LENGTH_LONG).show();
    }
}
