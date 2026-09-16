package com.nyx.android;

import android.content.Context;
import android.content.res.AssetManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.zip.GZIPInputStream;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * ══ Assist 引擎的原生一半（D-404①）════════════════════════════
 *
 * 无障碍服务自己的**无头 WebView**：跑 assets/assist-engine.js
 * （= src/db/* 与 core 的同一份判据，端口换成下面这些）。
 *
 * ★★★ 为什么要有它：在这之前，气泡的查词/保存是 RPC 打给 App 主进程的
 *   WebView，而那个 WebView 只活在 MainActivity 里 —— 叫醒它就得
 *   `startActivity`，于是「选个词」把人从 Reddit 拽回 Nyx。
 *   把大脑搬到服务这边之后，**整条链路一次 Activity 都不用起**。
 *
 * ══ 四个端口 ══════════════════════════════════════════════
 *   sql       同一个 nyxSQLite.db（读写都在**一条**专用线程上 ——
 *             SQLite 的事务是线程绑定的，last_insert_rowid() 也是连接绑定的）
 *   dictRead  SAF content:// 的**真随机读**（只读索引与命中的块，
 *             不再整本进内存）
 *   secret    插件自己那张 WSSecureStorageSharedPreferences + AndroidKeyStore
 *             （同一处密文，不是第二个 key 仓库）
 *   httpStart 原生 HTTP：显式 UTF-8 解码 + 显式 gzip —— 编码不留想象空间
 *
 * ★ WebView 是无头的：挂 1×1 透明窗口只为让 Chromium 认它「可见」，
 *   免得渲染进程被系统降级冻住（后台 WebView 会被冻，2026-08-30 实证）。
 */
final class AssistEngine {
    private static final String TAG = "NyxAssistEngine";
    private static final String PREFS = "WSSecureStorageSharedPreferences";
    /** 插件把密文与 IV 用这个控制字符拼在一起（SecureStorage.DATA_IV_SEPARATOR） */
    private static final char IV_SEP = '\u0010';

    interface Cb {
        /** ok=false 时 json 是 {title,detail,kind} */
        void done(boolean ok, String json);
    }

    private final Context ctx;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private WebView web;
    private boolean ready = false;
    private final java.util.ArrayList<String> queued = new java.util.ArrayList<>();
    private final Map<Integer, Cb> waiting = new HashMap<>();
    private int seq = 0;
    /** T-6.5 · 这个 WebView 是什么时候建的 / 什么时候真的活过来的（怀疑点 ⑤） */
    private long warmedAt = 0;
    private final Map<Integer, Long> callAt = new HashMap<>();

    /** SQLite 只在这条线程上被碰（事务与 last_insert_rowid 的前提） */
    private final ExecutorService dbThread = Executors.newSingleThreadExecutor();
    private SQLiteDatabase db;
    /** 网络各走各的 —— 一次查词在跑时另一次点击不该排队 */
    private final ExecutorService net = Executors.newCachedThreadPool();

    AssistEngine(Context c) {
        ctx = c;
    }

    // ── 生命周期 ────────────────────────────────────────────────

    /** 第一次要用时建（进取词模式时预热，省掉首查的冷启动） */
    void warm() {
        if (web != null) {
            Probe.write(ctx, "engine warm (already) ready=" + ready);
            return;
        }
        Probe.write(ctx, "engine warm (creating)");
        warmedAt = System.currentTimeMillis();
        try {
            /**
             * ══ 调试口：无头 WebView 也要能被 DevTools 看见（T-6.5 · 任务 B）══
             *
             * `WebView.setWebContentsDebuggingEnabled` 是**静态**的、按进程生效。
             * Capacitor 会调它（`Bridge.java:622`，默认值 = APK 的 debuggable 标志，
             * `CapConfig.java:247/288`）—— **但那要 `MainActivity` 起来过**。
             * 而无障碍服务与它的无头 WebView **可以在 MainActivity 从未创建过的情况下运行**
             * （系统在他打开无障碍开关时就绑定它，App 被划掉也照旧活着）。
             * 那种时候进程里一次都没人调过这个开关 → 整个进程没有 devtools socket →
             * `adb forward` 看着通，`curl :9222/json` 是空的。T-9.2 撞到的就是这一下。
             *
             * ★ 判据与 Capacitor 用的是**同一条**（`ApplicationInfo.FLAG_DEBUGGABLE`），
             *   不用 `BuildConfig.DEBUG`：本仓没开 `buildFeatures.buildConfig`，
             *   而且照抄框架那条判据比自己发明一条稳。**release 包永远进不来这一支。**
             */
            try {
                boolean debuggable =
                    (ctx.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
                if (debuggable) WebView.setWebContentsDebuggingEnabled(true);
                Probe.write(ctx, "engine devtools debuggable=" + debuggable);
            } catch (Exception e) {
                Probe.write(ctx, "engine devtools failed " + e);
            }
            WebView w = new WebView(ctx);
            w.getSettings().setJavaScriptEnabled(true);
            w.getSettings().setDomStorageEnabled(false);
            w.setBackgroundColor(0x00000000);
            w.addJavascriptInterface(new Host(), "nyxHost");
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                w.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            }
            web = w;
            String js = readAsset("assist-engine.js");
            String html = "<!doctype html><meta charset=\"utf-8\"><body><script>" + js + "</script>";
            w.loadDataWithBaseURL("http://nyx.assist/", html, "text/html", "utf-8", null);
        } catch (Exception e) {
            Log.e(TAG, "engine boot failed", e);
            web = null;
        }
    }

    WebView view() {
        return web;
    }

    void destroy() {
        ready = false;
        waiting.clear();
        if (web != null) {
            try { web.destroy(); } catch (Exception ignored) {}
            web = null;
        }
        dbThread.execute(this::closeDb);
    }

    private String readAsset(String name) throws Exception {
        AssetManager am = ctx.getAssets();
        try (InputStream in = am.open(name); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    // ── 调用 ────────────────────────────────────────────────────

    /** op = "lookup" | "save"；args 是 JSON。回调在主线程。 */
    void call(String op, JSONObject args, Cb cb) {
        warm();
        if (web == null) {
            cb.done(false, err("Assist 引擎起不来", "WebView 创建失败 —— 系统 WebView 可能正在更新"));
            return;
        }
        final int id = ++seq;
        waiting.put(id, cb);
        callAt.put(id, System.currentTimeMillis());
        String js = "nyxEngine.call(" + id + ",'" + op + "'," + quote(args.toString()) + ")";
        /**
         * ★★ T-6.5 怀疑点 ⑤ · **没预热 / 被冻着的样子就是 `ready=false`**。
         *   `ready` 为假时这一句进队列，要等 WebView 里的 JS 真的跑起来喊 `ready()`
         *   才发出去 —— 那一段等待在使用者那里就是「点了喇叭没反应」。
         *   `queued` 的长度与 `sinceWarm` 一起，能分清「刚建还没活过来」与「建好很久却被冻住」。
         */
        Probe.write(ctx, "engine call " + op + " id=" + id + " ready=" + ready
            + " queued=" + queued.size()
            + " sinceWarm=" + (warmedAt == 0 ? -1 : System.currentTimeMillis() - warmedAt) + "ms");
        if (ready) evalJs(js);
        else queued.add(js);
    }

    private void evalJs(final String js) {
        ui.post(() -> {
            if (web != null) web.evaluateJavascript(js, null);
        });
    }

    /** JS 字符串字面量（引擎收到的是一整段 JSON 文本） */
    private static String quote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c == '\n') b.append("\\n");
            else if (c == '\r') b.append("\\r");
            else if (c < 0x20 || c == 0x2028 || c == 0x2029) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    static String err(String title, String detail) {
        try {
            JSONObject o = new JSONObject();
            o.put("title", title);
            o.put("detail", detail);
            return o.toString();
        } catch (Exception e) {
            return "{\"title\":\"出错了\",\"detail\":\"\"}";
        }
    }

    // ── 端口实现（JS 那侧叫 nyxHost）──────────────────────────────

    private final class Host {
        @JavascriptInterface
        public void ready() {
            ui.post(() -> {
                AssistEngine.this.ready = true;
                // ★ T-6.5 · 从建 WebView 到 JS 真的活过来用了多久 + 这期间攒了几条
                Probe.write(ctx, "engine ready boot="
                    + (warmedAt == 0 ? -1 : System.currentTimeMillis() - warmedAt) + "ms"
                    + " queued=" + queued.size());
                for (String js : queued) evalJs(js);
                queued.clear();
            });
        }

        @JavascriptInterface
        public void log(String msg) {
            Log.d(TAG, "js: " + msg);
        }

        /**
         * T-6.6 · 引擎自己那几行探针（现在只有 `dict prewarm …`）。
         *
         * ★ **不走上面那个 `log()`**：这台 ROM 限流吞 `Log.d`（CLAUDE.md 七），
         *   诊断只认文件。写的是与服务同一个文件、同一个格式、同一个上限、
         *   同一个开关 —— `Probe` 那一份，这里一行都不重写。
         */
        @JavascriptInterface
        public void probe(String msg) {
            Probe.write(ctx, msg);
        }

        @JavascriptInterface
        public void result(final int id, final boolean ok, final String json) {
            ui.post(() -> {
                // ★ T-6.5 · 这一趟在引擎里（含 JS + 端口回原生）总共用了多久
                Long at = callAt.remove(id);
                if (at != null) {
                    Probe.write(ctx, "engine done id=" + id + " ok=" + ok
                        + " " + (System.currentTimeMillis() - at) + "ms");
                }
                Cb cb = waiting.remove(id);
                if (cb != null) cb.done(ok, json);
            });
        }

        /** 同步 —— JS 那侧的 Db 接口是异步的，但底下这一步就该是直的 */
        @JavascriptInterface
        public String sql(final String kind, final String text, final String params) {
            try {
                return onDb(() -> runSql(kind, text, params));
            } catch (Exception e) {
                return sqlErr(e.getMessage() != null ? e.getMessage() : String.valueOf(e));
            }
        }

        @JavascriptInterface
        public long dictSize(String uri) {
            return DictFiles.size(ctx, uri);
        }

        @JavascriptInterface
        public String dictRead(String uri, long at, int len) {
            byte[] b = DictFiles.read(ctx, uri, at, len);
            return Base64.encodeToString(b, Base64.NO_WRAP);
        }

        @JavascriptInterface
        public String secret(String name) {
            return readSecret(name);
        }

        // ── F-003 · 后台同步要的文件面（2026-09-01）────────────────
        //
        // ★ 同步引擎的 backup / audio 两个端口在 App 那侧走 Capacitor Filesystem，
        //   而这个 WebView **没有 Capacitor 桥**。所以补一组原生的，
        //   路径口径与 Capacitor 的 Directory.Data 一致（都是 filesDir）。
        //   判据仍然只有一份 —— 这里只是第四套**端口**，不是第二份逻辑。

        /** Capacitor 的 Directory.Data 就是它 —— 两处装配指向同一个目录 */
        @JavascriptInterface
        public String filesDir() {
            return ctx.getFilesDir().getAbsolutePath();
        }

        /** 列一个相对目录下的文件名（目录不存在就现建）。返回 JSON 数组 */
        @JavascriptInterface
        public String dirList(String rel) {
            try {
                File d = new File(ctx.getFilesDir(), rel);
                if (!d.exists() && !d.mkdirs()) return "[]";
                String[] names = d.list();
                JSONArray a = new JSONArray();
                if (names != null) for (String n : names) a.put(n);
                return a.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        /** 读一个相对路径的文件，base64；读不到返回 null（不抛 —— 缺文件是正常情况） */
        @JavascriptInterface
        public String fileRead(String rel) {
            try (FileInputStream in = new FileInputStream(new File(ctx.getFilesDir(), rel));
                 ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            } catch (Exception e) {
                return null;
            }
        }

        /** 写一个相对路径的文件（父目录现建）。失败返回一句人话，成功返回 null */
        @JavascriptInterface
        public String fileWrite(String rel, String b64) {
            try {
                File f = new File(ctx.getFilesDir(), rel);
                File p = f.getParentFile();
                if (p != null && !p.exists() && !p.mkdirs()) return "建不了目录：" + p.getPath();
                try (OutputStream out = new java.io.FileOutputStream(f)) {
                    out.write(Base64.decode(b64, Base64.DEFAULT));
                }
                return null;
            } catch (Exception e) {
                return e.getMessage() != null ? e.getMessage() : String.valueOf(e);
            }
        }

        /** 删一个相对路径的文件。删不掉不算错（备份滚动就靠它，缺了也没关系） */
        @JavascriptInterface
        public void fileDelete(String rel) {
            try {
                //noinspection ResultOfMethodCallIgnored
                new File(ctx.getFilesDir(), rel).delete();
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void httpStart(final int id, final String url, final String method,
                              final String headers, final String body) {
            net.execute(() -> {
                String[] r = http(url, method, headers, body);
                String js = "nyxEngine.httpDone(" + id + "," + r[0] + "," + quote(r[1]) + ","
                    + quote(r[2] == null ? "" : r[2]) + ")";
                evalJs(js);
            });
        }

    }

    // ── SQLite（单线程）─────────────────────────────────────────

    private <T> T onDb(Callable<T> c) throws Exception {
        Future<T> f = dbThread.submit(c);
        return f.get();
    }

    /**
     * 三条连接里的**第二条**（T-2.3 · 审计 R-012）—— 无障碍服务这一侧的读写直连。
     * 另外两条：App 的 Capacitor 插件（`src/db/open.ts`）· 服务读开关的只读直连
     * （`NyxAssistService.readConfig`）。三条的对照表在
     * `docs/nyx-system/android/ANDROID_ARCHITECTURE.md`。
     */
    private static final int BUSY_TIMEOUT_MS = 15000;

    private SQLiteDatabase db() throws Exception {
        if (db != null && db.isOpen()) return db;
        File f = ctx.getDatabasePath("nyxSQLite.db");
        if (!f.exists()) throw new Exception("Nyx 还没建过库 —— 先打开一次 Nyx");
        db = SQLiteDatabase.openDatabase(f.getPath(), null, SQLiteDatabase.OPEN_READWRITE);
        /*
         * ★ 撞上库锁时等多久 —— **显式写下来，不吃默认值**。
         *
         * 这个库不是 WAL（真机实测 journal_mode = delete），三条连接里任何一处
         * 在写，另外两处连读都会撞 SQLITE_BUSY。不设的话拿到的是 AOSP 的原生
         * 默认 2500 ms（android_database_SQLiteConnection.cpp 里
         * `static const int BUSY_TIMEOUT_MS = 2500;`）—— 挡得住毫秒级的小写入，
         * 挡不住同步引擎一批 5000 行的写事务（手机上是秒级）。
         *
         * 15 秒与 `src/db/open.ts::BUSY_TIMEOUT_MS` 同值，理由写在那边：
         * 下界 = 长过最长的一个写事务；上界 = 远短于后台 5 分钟硬超时与租约 6 分钟。
         *
         * ★ 等这 15 秒不卡界面：这一条连接上的每一句 SQL 都跑在 `dbThread`
         *   这个单线程执行器上（`onDb`），不是服务的主线程。
         * ★ 不是业务 SQL：pragma 只设这条连接自己的等待时长，不碰任何表。
         *
         * ★★ **走 rawQuery，不许走 execSQL** —— 和 `journal_mode = WAL` 那个经典坑同一形状。
         *    `pragma busy_timeout = N` 是**有回值**的语句，而 `execSQL` 那条路是：
         *      execSQL → executeSql → SQLiteStatement.executeUpdateDelete()
         *      → SQLiteSession.executeForChangedRowCount → nativeExecuteForChangedRowCount
         *      → executeNonQuery(env, conn, stmt, false)   ← 第四个参数就是 isPragmaStmt
         *    而 `android_database_SQLiteConnection.cpp` 里那个函数是：
         *      只有 isPragmaStmt 为真才 `while (rc == SQLITE_ROW) rc = sqlite3_step(...)`
         *      把行排干；传 false 时 `SQLITE_ROW` 直接抛
         *      「Queries can be performed using SQLiteDatabase query or rawQuery methods only.」
         *    —— `nativeExecuteForChangedRowCount` 传的正是**硬编码的 false**。
         *
         *    最阴的地方：值**其实已经设上了**（`pragma busy_timeout = N` 在 sqlite3 的
         *    解析期就调 `sqlite3_busy_timeout`，实测「只 prepare 不 step」读回来就已生效），
         *    抛的是它之后的那一步。于是 catch 里那句「设失败了」是**假话**，
         *    而这条连接又没有读回值可看 —— 正好凑成一个查不出来的坑。
         *    rawQuery 走的是查询路径，行是要读的，不抛；而且顺手把生效值带回来。
         *
         * ★ 设不上只该**降级**（退回原生的 2500），不许把整条 Assist 打死 ——
         *   所以单独包一层。真机验收看的是这行日志里的数，不是这里没抛异常。
         */
        try {
            Cursor bt = db.rawQuery("pragma busy_timeout = " + BUSY_TIMEOUT_MS, null);
            int got = bt.moveToFirst() ? bt.getInt(0) : -1;
            bt.close();
            // ★★ T-2.3 ② 的可读出口（2026-09-07）：只进 `Log.i` 的话这台 ROM 会吞掉，
            //   真机上读不到 = 没有验收面。`Probe` 那条通道是验过的（T-6.5 / T-6.6）。
            //   这里 `Probe.on` 早已由服务的 `readConfig()` 赋过值，直接写即可。
            Log.i(TAG, "busy_timeout=" + got);
            Probe.write(ctx, "db busy_timeout=" + got + " conn=engine");
        } catch (Exception e) {
            Log.i(TAG, "busy_timeout set failed, native default stands: " + e);
            Probe.write(ctx, "db busy_timeout=-1 conn=engine（没设上，用原生默认）");
        }
        return db;
    }

    private void closeDb() {
        if (db != null) {
            try { db.close(); } catch (Exception ignored) {}
            db = null;
        }
    }

    private static String sqlErr(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("err", msg);
            return o.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"err\":\"SQL\"}";
        }
    }

    private String runSql(String kind, String text, String paramsJson) {
        try {
            SQLiteDatabase d = db();
            JSONArray p = new JSONArray(paramsJson == null || paramsJson.isEmpty() ? "[]" : paramsJson);
            JSONObject out = new JSONObject();
            out.put("ok", true);
            switch (kind) {
                case "begin":
                    d.beginTransaction();
                    return out.toString();
                case "commit":
                    d.setTransactionSuccessful();
                    d.endTransaction();
                    return out.toString();
                case "rollback":
                    d.endTransaction();
                    return out.toString();
                case "exec":
                    d.execSQL(text);
                    return out.toString();
                case "run":
                    d.execSQL(text, bindArgs(p));
                    return out.toString();
                default: {
                    // get / all —— rawQuery 只吃 String[]，靠 SQLite 的列亲和性
                    // 完成 '5' → 5 的比较转换（写入那侧用 execSQL 的真类型绑定）
                    String[] args = new String[p.length()];
                    for (int i = 0; i < p.length(); i++) {
                        Object v = p.isNull(i) ? null : p.get(i);
                        args[i] = v == null ? null : String.valueOf(v);
                    }
                    Cursor c = d.rawQuery(text, args);
                    JSONArray rows = new JSONArray();
                    int limit = "get".equals(kind) ? 1 : Integer.MAX_VALUE;
                    while (c.moveToNext() && rows.length() < limit) {
                        JSONObject row = new JSONObject();
                        for (int i = 0; i < c.getColumnCount(); i++) {
                            String nm = c.getColumnName(i);
                            switch (c.getType(i)) {
                                case Cursor.FIELD_TYPE_NULL: row.put(nm, JSONObject.NULL); break;
                                case Cursor.FIELD_TYPE_INTEGER: row.put(nm, c.getLong(i)); break;
                                case Cursor.FIELD_TYPE_FLOAT: row.put(nm, c.getDouble(i)); break;
                                case Cursor.FIELD_TYPE_BLOB:
                                    row.put(nm, Base64.encodeToString(c.getBlob(i), Base64.NO_WRAP));
                                    break;
                                default: row.put(nm, c.getString(i));
                            }
                        }
                        rows.put(row);
                    }
                    c.close();
                    out.put("rows", rows);
                    return out.toString();
                }
            }
        } catch (Exception e) {
            return sqlErr(e.getMessage() != null ? e.getMessage() : String.valueOf(e));
        }
    }

    /** JSON 值 → SQLite 真类型（数字进数字列，null 是 null —— 不靠字符串蒙混） */
    private static Object[] bindArgs(JSONArray p) throws Exception {
        Object[] a = new Object[p.length()];
        for (int i = 0; i < p.length(); i++) {
            if (p.isNull(i)) { a[i] = null; continue; }
            Object v = p.get(i);
            if (v instanceof Boolean) a[i] = ((Boolean) v) ? 1L : 0L;
            else if (v instanceof Integer) a[i] = ((Integer) v).longValue();
            else if (v instanceof Long || v instanceof Double) a[i] = v;
            else a[i] = String.valueOf(v);
        }
        return a;
    }

    // ── API key（插件那张加密表，同一处）───────────────────────

    private String readSecret(String name) {
        String prefixed = "capacitor-storage_" + name;
        try {
            String blob = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(prefixed, null);
            if (blob == null) return null;
            String[] parts = blob.split(String.valueOf(IV_SEP));
            if (parts.length != 2) return null;
            int flags = Base64.NO_PADDING | Base64.NO_WRAP;
            byte[] data = Base64.decode(parts[0], flags);
            byte[] iv = Base64.decode(parts[1], flags);
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            KeyStore.SecretKeyEntry e = (KeyStore.SecretKeyEntry) ks.getEntry(prefixed, null);
            if (e == null) return null;
            SecretKey key = e.getSecretKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(data), StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.d(TAG, "secret read failed " + e);
            return null;
        }
    }

    // ── HTTP（编码不留想象空间）─────────────────────────────────

    /**
     * 建连接、装请求头、写请求体。
     *
     * ★ D-466 之前这里还有一条**字节通道**（音频），与这一条共用同一份 open；
     *   语音收成两档之后引擎不再走网络，那一半连同 Java 的 `httpStartBase64`
     *   一起拆了。现在只剩这一条文本通道，给 AI 用。
     */
    private HttpURLConnection open(String url, String method, String headersJson, String body)
            throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method == null || method.isEmpty() ? "GET" : method);
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.setInstanceFollowRedirects(true);
        // ★ 自己声明 gzip 就得自己解 —— 否则拿到的是压缩字节按文本读（经典乱码）
        c.setRequestProperty("Accept-Encoding", "gzip");
        c.setRequestProperty("Accept-Charset", "UTF-8");
        JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
        for (java.util.Iterator<String> it = h.keys(); it.hasNext(); ) {
            String k = it.next();
            c.setRequestProperty(k, h.optString(k, ""));
        }
        if (body != null && !body.isEmpty()) {
            c.setDoOutput(true);
            byte[] out = body.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(out.length);
            try (OutputStream os = c.getOutputStream()) {
                os.write(out);
            }
        }
        return c;
    }

    /** @return [status, bodyText, errOrNull] */
    private String[] http(String url, String method, String headersJson, String body) {
        HttpURLConnection c = null;
        try {
            c = open(url, method, headersJson, body);
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = in == null ? "" : readAll(in, c.getContentEncoding());
            return new String[]{String.valueOf(status), text, null};
        } catch (Exception e) {
            return new String[]{"0", "", (e.getMessage() != null ? e.getMessage() : String.valueOf(e))};
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String readAll(InputStream in, String encoding) throws Exception {
        InputStream s = "gzip".equalsIgnoreCase(encoding) ? new GZIPInputStream(in) : in;
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
            // ★ 显式 UTF-8：服务商几乎都是 UTF-8 JSON，而平台默认值不是判据
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            try { s.close(); } catch (Exception ignored) {}
        }
    }

    // ── 词典文件（SAF 真随机读）─────────────────────────────────
    //
    // ★ T-5.10：这段原来是这里的私有内部类，于是**只有引擎**有随机读，
    //   App 那一侧只能整本进内存（大书装不下 · 音频卷根本不可能）。
    //   现在搬去 `DictFiles.java`，引擎与 App 的 WebView 共用同一份原生实现，
    //   JS 那侧也共用同一个 `DictionaryIO`（`src/db/dict-io.ts`）。
    //   这里的调用一个字没改 —— 换的只是那份实现住在哪。
}
