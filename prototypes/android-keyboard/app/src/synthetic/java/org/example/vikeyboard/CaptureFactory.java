package org.example.vikeyboard;

import android.os.Handler;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

final class CaptureFactory implements DictationController.Factory {
    static final boolean AVAILABLE = true;
    static final int LABEL = R.string.synthetic_capture;
    static final AtomicInteger OPEN_CAPTURES = new AtomicInteger();
    private final Handler handler;

    CaptureFactory(Handler handler) { this.handler = handler; }

    @Override public DictationController.Provider provider() { return new FakeProvider(handler); }

    @Override public DictationController.Capture capture() {
        return new DictationController.Capture() {
            private boolean closed;
            private boolean started;

            @Override public void start(Consumer<byte[]> audio, Runnable failure) {
                if (closed || started) throw new IllegalStateException("Capture not startable");
                started = true;
                OPEN_CAPTURES.incrementAndGet();
                byte[] pcm = new byte[640];
                for (int sample = 0; sample < 320; sample++) {
                    short value = (short) ((sample % 32 < 16) ? 1024 : -1024);
                    pcm[sample * 2] = (byte) value;
                    pcm[sample * 2 + 1] = (byte) (value >> 8);
                }
                audio.accept(pcm);
            }

            @Override public void close() {
                if (closed) return;
                closed = true;
                if (started) OPEN_CAPTURES.decrementAndGet();
            }
        };
    }
}
