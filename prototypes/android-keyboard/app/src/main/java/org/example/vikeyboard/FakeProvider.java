package org.example.vikeyboard;

import android.os.Handler;
import java.util.concurrent.atomic.AtomicInteger;

final class FakeProvider implements DictationController.Provider {
    static final String FINAL = "Synthetic final \u4f60\u597d";
    static final AtomicInteger OPEN_SESSIONS = new AtomicInteger();
    private final Handler handler;
    private DictationController.Events events;
    private int bytes;
    private boolean closed;
    private Runnable pending;

    FakeProvider(Handler handler) {
        this.handler = handler;
        OPEN_SESSIONS.incrementAndGet();
    }

    @Override public void start(DictationController.Events listener) {
        events = listener;
        events.partial("Synthetic partial (never inserted)");
    }

    @Override public void audio(byte[] pcm) {
        if (closed) throw new IllegalStateException("Closed provider");
        bytes += pcm.length;
    }

    @Override public void finish() {
        if (closed || bytes == 0) throw new IllegalStateException("No synthetic PCM");
        DictationController.Events listener = events;
        pending = () -> {
            listener.complete(FINAL);
            listener.complete(FINAL);
        };
        handler.postDelayed(pending, 3_000);
    }

    @Override public void close() {
        if (closed) return;
        closed = true;
        if (pending != null) handler.removeCallbacks(pending);
        events = null;
        bytes = 0;
        OPEN_SESSIONS.decrementAndGet();
    }
}
