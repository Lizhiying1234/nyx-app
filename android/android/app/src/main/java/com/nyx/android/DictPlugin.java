package com.nyx.android;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 本地词典的文件面（D-336 / D-401 词典批）：
 *   pickFolder  · SAF 选文件夹（ACTION_OPEN_DOCUMENT_TREE），树权限持久化 ——
 *                 现代 Android 用户可达的文件夹只有这条正路（Android/data 已封）
 *   listFolder  · 列这棵树第一层里的 .mdx / .mdd / .css（名字 / 文档 uri / 大小）
 *
 * ★ T-5.10 · 字节走 `nyxDictHost`（见下面 DictHost），**不是** plugin 方法，
 *   也不再是 `convertFileSrc + fetch` 整本读。理由写在 DictHost 的说明里。
 */
@CapacitorPlugin(name = "NyxDict")
public class DictPlugin extends Plugin {

    private static final String TAG = "NyxDictPlugin";

    /**
     * ══ App 这一侧的真随机读通道（T-5.10）════════════════════════
     *
     * ── 为什么不是一个 plugin 方法 ★★★ ───────────────────────────
     *
     * core 的 `DictionaryIO.read(h, at, len)` 是**同步**的，而且是**故意**同步的
     * （`core/dict/contract.ts` 第三节：「便宜的同步，昂贵的异步」——
     * 读头部与索引块是几百字节到几 KB，异步在这里买不到任何东西，
     * 却会把所有调用点染成 await）。
     * 而 Capacitor 的 plugin 调用**永远是异步的**（消息过桥 + 回调兑现 Promise）。
     * 也就是说 `NyxDict.read()` 这种 plugin 方法**实现不了那个接口** ——
     * 要么改 core 的契约（那是 core，越界），要么在 JS 侧再写一个异步的第二份
     * MDict 读取器（那正是「两份判据」）。两条都不行。
     *
     * 所以走和 Assist 引擎**同一条路**：`addJavascriptInterface`。
     * 它是同步的 JS→Java 调用，引擎那侧（`AssistEngine.Host.dictRead`）已经在
     * 真机上跑了几个月。方法名与引擎那侧**逐字相同**，于是 JS 那边
     * `src/db/dict-io.ts` 一份 `DictionaryIO` 同时喂两个 WebView。
     *
     * ── 为什么不是「引擎托管词典服务」（另一个候选）★★ ────────────
     *
     * 那要让 Lookup 的每一次查词 RPC 进无障碍服务的无头 WebView。
     * ① 词典是 App 的能力（D-336），不该依赖无障碍服务被授权且活着 ——
     *    ColorOS 装一次包就可能掉一次授权（CLAUDE.md 七），那时整个词典就没了；
     * ② 形状上正是 D-404 那次事故的镜像（跨进程 RPC 到一个你管不住生命周期的
     *    WebView），只是方向反过来；
     * ③ 大块字节还要多过一次 IPC。
     *
     * ── 边界 ────────────────────────────────────────────────────
     * 只读、只按 uri + 偏移取字节，不认识词典格式、不碰库。
     * 暴露面与引擎那侧一样，宿主页面只有我们自己的 bundle。
     */
    public static final class DictHost {
        private final Context ctx;

        DictHost(Context c) {
            ctx = c;
        }

        /** 文件多大；-1 = 读不到（权限丢了 / 挪走了）——上层如实说，不吞成「没这个词」 */
        @JavascriptInterface
        public long dictSize(String uri) {
            return DictFiles.size(ctx, uri);
        }

        /** base64（同步 —— DictionaryIO 契约就是同步的），与引擎那侧同名同形 */
        @JavascriptInterface
        public String dictRead(String uri, long at, int len) {
            return Base64.encodeToString(DictFiles.read(ctx, uri, at, len), Base64.NO_WRAP);
        }
    }

    /**
     * 插件装载时把通道挂上去。
     * ★ 时机：Capacitor 在 Bridge 构造期注册插件并调 load()，**早于**载入我们的
     *   页面，所以 JS 一开始就看得见 `window.nyxDictHost`。
     *   万一某天顺序变了，JS 那侧会退回整本进内存，并且
     *   `globalThis.nyxDb.dictIo` 会报 `memory` —— ③ 档验收一眼看得出来，不静默。
     */
    @Override
    public void load() {
        try {
            getBridge().getWebView().addJavascriptInterface(new DictHost(getContext()), "nyxDictHost");
        } catch (Exception e) {
            Log.d(TAG, "dict host attach failed " + e);
        }
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject out = new JSObject();
            out.put("uri", (String) null); // 用户取消 —— 不是错误
            call.resolve(out);
            return;
        }
        Uri tree = data.getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {
            // 个别 ROM 不给持久化 —— 本次会话仍可用；下次要重选，listFolder 会如实失败
        }
        JSObject out = new JSObject();
        out.put("uri", tree.toString());
        call.resolve(out);
    }

    /**
     * 一次最多回多少条。超了**如实说**「只看了前 N 项」，不静默少看（T-5.16）。
     * 词典夹是几十条的量级；这个数只防「他指了个几万文件的夹子」把桥撑爆。
     */
    private static final int MAX_ENTRIES = 20000;
    /** 最多往下走几层。超了把那个目录**如实带回去**，不静默不进去 */
    private static final int MAX_DEPTH = 8;

    /**
     * ══ 列夹子（T-5.16 起**递归**，且**不做任何筛选**）════════════════
     *
     * ★★ 为什么改：真机批（C，2026-09-06）查明使用者「有些词典没显示出来」——
     *   `/sdcard/Eudic dictionary/` 顶层 16 本全在，**四个子目录里的 6 本
     *   （合计约 1.1 GB 数字卷）一本都没被扫到，也没有任何一句话说它们被跳过了**。
     *   这里原来只列第一层、不查 MIME、把子目录和 `config.ini` 一起静默 `continue`。
     *
     * ★★ 为什么这里**一条都不筛**（连 `config.ini` 都回去）：
     *   「什么算词典文件 / 什么算跳过 / 跳过了怎么跟人说」是**判据与话术** ——
     *   放在 JS（`db/dict.ts::classifyDictFiles`）才有用例、才做得了负向对照，
     *   与 T-6.1 把 L0 判据从 Java 收回引擎是同一课。而且「跳过 M 项」这个数
     *   只有在这里全给回去时才对得上目录里的真实文件。
     *   ★ 这一层只回答一件事：**这棵树上有些什么**（名字 · 大小 · 相对目录）。
     *
     * ★ 没看全的三种情形都**带着事实回去**，由 JS 说成人话：
     *   `truncated`（条数到顶）· `tooDeep`（层数到顶，没进去的目录）·
     *   `unreadable`（读不了的目录，多半是权限）。
     */
    @PluginMethod
    public void listFolder(PluginCall call) {
        String treeStr = call.getString("uri");
        if (treeStr == null || treeStr.isEmpty()) {
            call.reject("没有文件夹 uri");
            return;
        }
        try {
            Uri tree = Uri.parse(treeStr);
            JSArray files = new JSArray();
            JSArray tooDeep = new JSArray();
            JSArray unreadable = new JSArray();
            // 一个格子的可变旗标 —— 递归里要能往上传「到顶了」
            boolean[] full = new boolean[]{false};
            walk(tree, DocumentsContract.getTreeDocumentId(tree), "", 0,
                files, tooDeep, unreadable, full);
            JSObject limits = new JSObject();
            limits.put("maxDepth", MAX_DEPTH);
            limits.put("maxEntries", MAX_ENTRIES);
            limits.put("truncated", full[0]);
            limits.put("tooDeep", tooDeep);
            limits.put("unreadable", unreadable);
            JSObject out = new JSObject();
            out.put("files", files);
            out.put("limits", limits);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("读不了这个文件夹：" + e.getMessage());
        }
    }

    /** 走一层：目录就下去，文件就记下来（带相对目录）。判据一条都没有 */
    private void walk(Uri tree, String docId, String dir, int depth,
                      JSArray files, JSArray tooDeep, JSArray unreadable, boolean[] full) {
        if (full[0]) return;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        Cursor c = null;
        try {
            c = getContext().getContentResolver().query(children,
                new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_MIME_TYPE
                }, null, null, null);
            if (c == null) {
                unreadable.put(dir);
                return;
            }
            while (c.moveToNext()) {
                if (files.length() >= MAX_ENTRIES) {
                    full[0] = true;
                    return;
                }
                String name = c.getString(1);
                if (name == null) continue;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(3))) {
                    if (depth + 1 > MAX_DEPTH) {
                        tooDeep.put(dir + name + "/");
                        continue;
                    }
                    walk(tree, c.getString(0), dir + name + "/", depth + 1,
                        files, tooDeep, unreadable, full);
                    if (full[0]) return;
                    continue;
                }
                Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0));
                JSObject f = new JSObject();
                f.put("name", name);
                f.put("uri", doc.toString());
                f.put("size", c.getLong(2));
                // 相对目录（顶层 = 空串）—— 伴生文件归谁**只能靠它分**：
                // 递归之后夹子里会有同名的书，跨目录同名匹配会让一本书拿到别家的卷
                f.put("dir", dir);
                files.put(f);
            }
        } catch (Exception e) {
            // 这一层读不了不该挡别的层 —— 但也**不许无声**：如实带回去，JS 说给人听
            Log.d(TAG, "listFolder 读不了 " + dir + " " + e);
            unreadable.put(dir);
        } finally {
            if (c != null) c.close();
        }
    }
}
