package org.example.vikeyboard;

import android.os.Handler;

final class CaptureFactory implements DictationController.Factory {
    static final boolean AVAILABLE = false;
    static final int LABEL = R.string.device_capture;
    private final Handler handler;

    CaptureFactory(Handler handler) { this.handler = handler; }

    @Override public DictationController.Provider provider() { return new FakeProvider(handler); }

    @Override public DictationController.Capture capture() {
        throw new UnsupportedOperationException("Hardware adapter not installed");
    }
}
