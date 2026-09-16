package com.nyx.android;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.TileService;

/**
 * 快捷设置磁贴「Nyx Assist」—— D-394 三通道之②（剪贴板通道的系统级唤起标志）。
 * 任何 App 里复制文字 → 下拉快捷设置 → 点它 → Nyx 前台拿焦点读剪贴板 → 浮层。
 * Android 10+ 只许前台焦点读剪贴板 —— 磁贴点开的正是自己的前台窗，合规。
 */
public class AssistTileService extends TileService {
    @Override
    public void onClick() {
        Intent i = new Intent(this, MainActivity.class);
        i.setAction(MainActivity.ACTION_ASSIST_CLIP);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (Build.VERSION.SDK_INT >= 34) {
            PendingIntent pi = PendingIntent.getActivity(
                this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            startActivityAndCollapse(pi);
        } else {
            startActivityAndCollapse(i);
        }
    }
}
