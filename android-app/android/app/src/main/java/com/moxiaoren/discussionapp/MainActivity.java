package com.moxiaoren.discussionapp;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends BridgeActivity {
    static { System.loadLibrary("native-lib"); }
    public native Integer startNodeWithArguments(String[] arguments);

    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        startHostServer();
    }

    private void startHostServer() {
        new Thread(() -> {
            try {
                File dir = new File(getFilesDir(), "nodejs-project");
                copyAssetFolder("nodejs-project", dir);
                final File flag = new File(getFilesDir(), "node-ok.txt");
                if (flag.exists()) flag.delete();
                // 阻塞线程：node 事件循环在此运行，服务器监听 8788
                startNodeWithArguments(new String[]{
                        "node",
                        new File(dir, "index.js").getAbsolutePath(),
                        flag.getAbsolutePath()
                });
            } catch (Throwable t) {
                showToast("手机主机启动失败: " + (t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage()));
            }
        }).start();

        // 轮询标志文件几秒，给用户明确成功/失败反馈
        new Thread(() -> {
            File flag = new File(getFilesDir(), "node-ok.txt");
            for (int i = 0; i < 12; i++) {
                if (flag.exists()) {
                    showToast("✅ 手机主机服务器已启动 (端口8788)");
                    return;
                }
                try { Thread.sleep(1000); } catch (InterruptedException ignored) {}
            }
            showToast("手机主机未启动(node加载失败)");
        }).start();
    }

    private void showToast(String msg) {
        handler.post(() -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show());
    }

    private void copyAssetFolder(String assetPath, File destDir) {
        if (!destDir.exists()) destDir.mkdirs();
        try {
            String[] children = getAssets().list(assetPath);
            if (children == null) return;
            for (String child : children) {
                String full = assetPath + "/" + child;
                File out = new File(destDir, child);
                String[] sub = getAssets().list(full);
                if (sub != null && sub.length > 0) {
                    if (!out.exists()) out.mkdirs();
                    copyAssetFolder(full, out);
                } else {
                    try (InputStream is = getAssets().open(full); OutputStream os = new FileOutputStream(out)) {
                        byte[] buf = new byte[16384]; int n;
                        while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
                    }
                }
            }
        } catch (IOException e) {
            showToast("拷贝node项目失败: " + e.getMessage());
        }
    }
}
