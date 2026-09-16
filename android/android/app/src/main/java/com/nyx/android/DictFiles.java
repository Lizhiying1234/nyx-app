package com.nyx.android;

import android.content.Context;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * ══ 词典文件的真随机读（T-5.10）══════════════════════════════════
 *
 * SAF 的 `content://` 打开成 `ParcelFileDescriptor` → `FileChannel`，
 * **按偏移读那几块**：几十～几百 MB 的 `.mdx` 只读索引与命中的块，
 * 1 GB 级的音频卷只读一条 mp3。这是「首查从等整本变成等几 KB」的全部秘密。
 *
 * ── 为什么它从 AssistEngine 里搬出来 ★★ ─────────────────────────
 *
 * 这条通道原来是 `AssistEngine` 的私有内部类，只有 Assist 引擎那个无头
 * WebView 用得到。于是 **App 这一侧（Lookup / 设置）根本没有随机读**：
 * 词典字节只能 `fetch(convertFileSrc)` 整本进内存，最多驻 2 本 ——
 *   · 大书装不下 → 查词失败，而失败又被吞成「这本里没有」
 *   · 音频卷 1 GB 级 → 不可能进内存 → Lookup 里的 `sound://` 永远播不了
 * 两条病同一个根（审计 T-5.10 的 (a) 与 (d)）。所以通道搬到这里，
 * 两个消费者共用**同一份原生实现**：
 *   · `AssistEngine.Host.dictSize/dictRead`（无障碍服务的无头 WebView）
 *   · `DictPlugin.DictHost.dictSize/dictRead`（App 的 Capacitor WebView）
 * JS 那一侧也只有一份 `DictionaryIO`（`src/db/dict-io.ts`）。
 *
 * ── 为什么是 LRU 而不是「一次只开一本」★ ────────────────────────
 *
 * 原来只留**一个**句柄：换一个 uri 就 close 再 open。以前只有引擎一个
 * 消费者、而且它是逐本顺序查的，所以够用。现在 App 与服务**在同一个进程里**
 * （Manifest 没有 android:process），两边会交替读不同的卷 ——
 * 单槽会让每一次读都先关一个再开一个（SAF 的 openFileDescriptor 不便宜）。
 * 那正是「Assist 引擎那条随机读变慢」的形状，所以这里改成小 LRU：
 * 同一本仍然命中（和以前一样快），交替读也不再来回开关。
 */
final class DictFiles {
    private static final String TAG = "NyxDictFiles";

    /** 同时开着的文件数上限（词条卷 + 资源卷 + 音频卷，交替读也够） */
    private static final int MAX_OPEN = 4;

    private static final class Handle {
        final ParcelFileDescriptor pfd;
        final FileInputStream fis;

        Handle(ParcelFileDescriptor p, FileInputStream f) {
            pfd = p;
            fis = f;
        }

        void close() {
            try { fis.close(); } catch (Exception ignored) {}
            try { pfd.close(); } catch (Exception ignored) {}
        }
    }

    /** accessOrder = true → 真 LRU（读一次就排到最新） */
    private static final LinkedHashMap<String, Handle> OPEN =
        new LinkedHashMap<String, Handle>(8, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Handle> eldest) {
                if (size() <= MAX_OPEN) return false;
                eldest.getValue().close();
                return true;
            }
        };

    private DictFiles() {}

    /** 文件多大；读不到返回 -1（权限丢了 / 文件挪走了 —— 上层如实说，不当成「没这个词」） */
    static synchronized long size(Context ctx, String uri) {
        try {
            return handle(ctx, uri).fis.getChannel().size();
        } catch (Exception e) {
            Log.d(TAG, "size err " + e);
            return -1;
        }
    }

    /** 从 at 读 len 字节。读到尾就返回短的 —— 与 core 的 DictionaryIO 契约同一条 */
    static synchronized byte[] read(Context ctx, String uri, long at, int len) {
        try {
            FileChannel ch = handle(ctx, uri).fis.getChannel();
            long size = ch.size();
            if (at >= size) return new byte[0];
            int want = (int) Math.min(len, size - at);
            ByteBuffer buf = ByteBuffer.allocate(want);
            ch.position(at);
            while (buf.hasRemaining() && ch.read(buf) > 0) { /* 读满或到尾 */ }
            byte[] out = new byte[buf.position()];
            buf.flip();
            buf.get(out);
            return out;
        } catch (Exception e) {
            Log.d(TAG, "read err " + e);
            return new byte[0];
        }
    }

    private static Handle handle(Context ctx, String uri) throws Exception {
        Handle h = OPEN.get(uri);
        if (h != null) return h;
        ParcelFileDescriptor pfd =
            ctx.getContentResolver().openFileDescriptor(Uri.parse(uri), "r");
        if (pfd == null) throw new Exception("打不开：" + uri);
        h = new Handle(pfd, new FileInputStream(pfd.getFileDescriptor()));
        OPEN.put(uri, h);
        return h;
    }
}
