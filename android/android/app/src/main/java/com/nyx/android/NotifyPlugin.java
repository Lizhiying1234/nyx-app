package com.nyx.android;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 数据安全通知（D-373）—— 手机通知**只有两类**：待上传积压 · 同步连败。
 *
 * 原生保持傻：**发不发、发哪类、说什么话，全在 JS 侧**（db/notify.ts 的判据）；
 * 这里只有「把一条通知摆出去」和「要权限」两件事。
 * 不发学习提醒（D-100/D-028「不催」哲学 —— 通知保护的是数据，不是自律）。
 */
@CapacitorPlugin(
    name = "NyxNotify",
    permissions = { @Permission(strings = { "android.permission.POST_NOTIFICATIONS" }, alias = "notif") }
)
public class NotifyPlugin extends Plugin {
    private static final String CHANNEL = "nyx-data-safety";

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "数据安全", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("只有两类：待上传积压 · 同步连续失败（D-373）");
        nm.createNotificationChannel(ch);
    }

    /** 权限状态（API 33 起才需要；老系统恒 granted） */
    @PluginMethod
    public void state(PluginCall call) {
        JSObject out = new JSObject();
        boolean granted = Build.VERSION.SDK_INT < 33
            || getPermissionState("notif") == PermissionState.GRANTED;
        out.put("granted", granted);
        call.resolve(out);
    }

    @PluginMethod
    public void ensurePermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notif") == PermissionState.GRANTED) {
            JSObject out = new JSObject();
            out.put("granted", true);
            call.resolve(out);
            return;
        }
        requestPermissionForAlias("notif", call, "permDone");
    }

    @PermissionCallback
    private void permDone(PluginCall call) {
        JSObject out = new JSObject();
        out.put("granted", getPermissionState("notif") == PermissionState.GRANTED);
        call.resolve(out);
    }

    /** 关总开关时把还挂着的两条收回来 —— 关了开关还留着旧警报是骗人 */
    @PluginMethod
    public void cancelAll(PluginCall call) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(getContext());
        nm.cancel(1);
        nm.cancel(2);
        call.resolve();
    }

    /** 摆一条出去。id 固定两个（积压=1 · 连败=2）—— 同类刷新不叠楼 */
    @PluginMethod
    public void post(PluginCall call) {
        try {
            ensureChannel();
            Intent open = new Intent(getContext(), MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(getContext(), 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), CHANNEL)
                .setSmallIcon(R.drawable.ic_assist_tile)
                .setContentTitle(call.getString("title", "Nyx"))
                .setContentText(call.getString("body", ""))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(call.getString("body", "")))
                .setContentIntent(pi)
                .setAutoCancel(true);
            NotificationManagerCompat.from(getContext())
                .notify(call.getInt("id", 1), b.build());
            JSObject out = new JSObject();
            out.put("ok", true);
            call.resolve(out);
        } catch (SecurityException e) {
            // 权限被收走了 —— 如实报，不炸
            JSObject out = new JSObject();
            out.put("ok", false);
            out.put("why", "通知权限没了");
            call.resolve(out);
        }
    }
}
