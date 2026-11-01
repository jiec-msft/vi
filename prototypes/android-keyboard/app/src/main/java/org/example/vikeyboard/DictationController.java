package org.example.vikeyboard;

import java.util.concurrent.Executor;
import java.util.function.Consumer;

final class DictationController {
    enum State { IDLE, BLOCKED, RECORDING, FINALIZING, COMMITTED, CANCELLED, ERROR }

    interface Events {
        void partial(String text);
        void complete(String text);
        void failure();
    }

    interface Provider extends AutoCloseable {
        void start(Events events);
        void audio(byte[] pcm16Mono16Khz);
        void finish();
        @Override void close();
    }

    interface Capture extends AutoCloseable {
        void start(Consumer<byte[]> audio, Runnable failure);
        @Override void close();
    }

    interface Factory {
        Provider provider();
        Capture capture();
    }

    interface Target {
        boolean available();
        boolean commit(String finalText);
    }

    interface Timer {
        Runnable schedule(Runnable action, long milliseconds);
    }

    private final Factory factory;
    private final Executor dispatch;
    private final Timer timer;
    private final Consumer<String> observer;
    private Provider provider;
    private Capture capture;
    private Target target;
    private Runnable cancelDeadline;
    private long generation;
    private State state = State.IDLE;

    DictationController(Factory factory, Executor dispatch, Timer timer, Consumer<String> observer) {
        this.factory = factory;
        this.dispatch = dispatch;
        this.timer = timer;
        this.observer = observer;
    }

    State state() { return state; }
    long generation() { return generation; }

    void start(Target editor, boolean consent, boolean permission, boolean captureAvailable) {
        if (state == State.RECORDING || state == State.FINALIZING) return;
        if (!release()) return;
        long session = ++generation;
        if (!editor.available()) {
            publish(State.BLOCKED, "Secure, unsupported or inaccessible editor");
            return;
        }
        if (!consent) {
            publish(State.BLOCKED, "Explicit session consent required");
            return;
        }
        if (!permission) {
            publish(State.BLOCKED, "Microphone permission denied; open Setup");
            return;
        }
        if (!captureAvailable) {
            publish(State.BLOCKED, "Hardware capture unavailable: adapter not installed");
            return;
        }
        target = editor;
        try {
            provider = factory.provider();
            capture = factory.capture();
            publish(State.RECORDING, "Synthetic capture / fake provider");
            provider.start(new Events() {
                @Override public void partial(String text) {
                    // Partial results are intentionally never delivered to the editor.
                }
                @Override public void complete(String text) {
                    dispatch.execute(() -> finalResult(session, text));
                }
                @Override public void failure() {
                    dispatch.execute(() -> fail(session, "Provider failed"));
                }
            });
            if (generation != session || state != State.RECORDING) return;
            capture.start(pcm -> {
                byte[] owned = pcm == null ? null : pcm.clone();
                dispatch.execute(() -> audio(session, owned));
            },
                    () -> dispatch.execute(() -> fail(session, "Capture unavailable")));
            if (generation == session && state == State.RECORDING) {
                cancelDeadline = timer.schedule(() -> fail(session, "Recording deadline exceeded"), 60_000);
            }
        } catch (RuntimeException error) {
            fail(session, "Session start failed");
        }
    }

    void stop() {
        if (state != State.RECORDING) return;
        long session = generation;
        try {
            cancelTimer();
            Capture owned = capture;
            capture = null;
            owned.close();
            publish(State.FINALIZING, "Waiting for fake final");
            cancelDeadline = timer.schedule(() -> fail(session, "Final result deadline exceeded"), 5_000);
            provider.finish();
        } catch (RuntimeException error) {
            fail(session, "Finalization failed");
        }
    }

    void cancel(String reason) {
        ++generation;
        if (release()) publish(State.CANCELLED, reason);
    }

    private void audio(long session, byte[] pcm) {
        if (session != generation || state != State.RECORDING) return;
        if (pcm == null || pcm.length == 0 || pcm.length % 2 != 0) {
            fail(session, "Invalid PCM16 input");
            return;
        }
        try {
            provider.audio(pcm);
        } catch (RuntimeException error) {
            fail(session, "Provider audio failed");
        }
    }

    private void finalResult(long session, String text) {
        if (session != generation || state != State.FINALIZING) return;
        Target editor = target;
        // Invalidate before commit: reentrant and repeated callbacks cannot insert twice.
        ++generation;
        if (!release()) return;
        if (text == null || text.trim().isEmpty()) {
            publish(State.ERROR, "Empty final result; nothing inserted");
            return;
        }
        if (editor == null || !editor.available()) {
            publish(State.BLOCKED, "Editor changed; final discarded");
            return;
        }
        try {
            boolean accepted = editor.commit(text);
            publish(accepted ? State.COMMITTED : State.ERROR, accepted
                    ? "Final-only commit; resources released (no retry)"
                    : "Editor rejected final; resources released (no retry)");
        } catch (RuntimeException error) {
            publish(State.ERROR, "Editor commit failed; no retry");
        }
    }

    private void fail(long session, String reason) {
        if (session != generation) return;
        ++generation;
        if (release()) publish(State.ERROR, reason);
    }

    private boolean release() {
        cancelTimer();
        Capture ownedCapture = capture;
        Provider ownedProvider = provider;
        capture = null;
        provider = null;
        target = null;
        boolean released = true;
        if (ownedCapture != null) {
            try { ownedCapture.close(); }
            catch (RuntimeException error) { released = false; }
        }
        if (ownedProvider != null) {
            try { ownedProvider.close(); }
            catch (RuntimeException error) { released = false; }
        }
        if (!released) publish(State.ERROR, "Resource release failed; final discarded");
        return released;
    }

    private void cancelTimer() {
        if (cancelDeadline != null) {
            cancelDeadline.run();
            cancelDeadline = null;
        }
    }

    private void publish(State next, String message) {
        state = next;
        observer.accept(next.name() + ": " + message + " / session " + generation);
    }
}
