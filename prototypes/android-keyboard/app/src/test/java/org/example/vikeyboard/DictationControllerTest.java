package org.example.vikeyboard;

import static org.junit.Assert.*;
import android.text.InputType;
import android.view.inputmethod.EditorInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import org.junit.Before;
import org.junit.Test;

public final class DictationControllerTest {
    private final List<Session> sessions = new ArrayList<>();
    private final List<String> inserted = new ArrayList<>();
    private final List<String> messages = new ArrayList<>();
    private DictationController controller;
    private Runnable deadline;
    private boolean available;
    private boolean accepted;
    private boolean captureFails;
    private boolean providerFails;
    private final DictationController.Target target = new DictationController.Target() {
        @Override public boolean available() { return available; }
        @Override public boolean commit(String text) { inserted.add(text); return accepted; }
    };

    private static final class Session implements DictationController.Provider {
        DictationController.Events events;
        int audioBytes;
        int closes;
        boolean finish;
        boolean closeFails;
        @Override public void start(DictationController.Events listener) { events = listener; }
        @Override public void audio(byte[] pcm) { audioBytes += pcm.length; }
        @Override public void finish() { finish = true; }
        @Override public void close() {
            closes++;
            if (closeFails) throw new IllegalStateException("Fixture close failure");
        }
    }

    private int captureCloses;
    private Consumer<byte[]> audio;
    private Runnable captureFailure;

    @Before public void setup() {
        available = true;
        accepted = true;
        controller = new DictationController(new DictationController.Factory() {
            @Override public DictationController.Provider provider() {
                if (providerFails) throw new IllegalStateException("Fixture provider unavailable");
                Session session = new Session();
                sessions.add(session);
                return session;
            }
            @Override public DictationController.Capture capture() {
                return new DictationController.Capture() {
                    @Override public void start(Consumer<byte[]> listener, Runnable failure) {
                        audio = listener;
                        captureFailure = failure;
                        if (captureFails) throw new IllegalStateException("Fixture capture unavailable");
                        listener.accept(new byte[] { 0, 4, 0, -4 });
                    }
                    @Override public void close() { captureCloses++; }
                };
            }
        }, Runnable::run, (action, milliseconds) -> {
            assertTrue(milliseconds == 60_000 || milliseconds == 5_000);
            deadline = action;
            return () -> deadline = null;
        }, messages::add);
    }

    private void start() { controller.start(target, true, true, true); }
    private Session session() { return sessions.get(sessions.size() - 1); }

    @Test public void finalOnlyExactlyOnceAndResourcesReleased() {
        start();
        session().events.partial("not final");
        session().events.complete("premature");
        assertTrue(inserted.isEmpty());
        assertEquals(4, session().audioBytes);
        controller.stop();
        assertEquals(1, captureCloses);
        assertTrue(session().finish);
        session().events.complete("Final \u4f60\u597d");
        session().events.complete("duplicate");
        session().events.failure();
        assertEquals(List.of("Final \u4f60\u597d"), inserted);
        assertEquals(1, session().closes);
        assertNull(deadline);
        assertEquals(DictationController.State.COMMITTED, controller.state());
    }

    @Test public void cancelAndNewSessionRejectAllOldEvents() {
        start();
        Session old = session();
        controller.stop();
        controller.cancel("Editor switched");
        start();
        old.events.complete("stale");
        old.events.failure();
        controller.stop();
        session().events.complete("current");
        assertEquals(List.of("current"), inserted);
        assertEquals(1, old.closes);
        assertEquals(2, captureCloses);
    }

    @Test public void editorUnavailableDuringFinalDiscardsText() {
        start();
        controller.stop();
        available = false;
        session().events.complete("discard");
        assertTrue(inserted.isEmpty());
        assertEquals(DictationController.State.BLOCKED, controller.state());
        assertEquals(1, session().closes);
    }

    @Test public void consentPermissionAndMissingAdapterNeverStart() {
        controller.start(target, false, true, true);
        controller.start(target, true, false, true);
        controller.start(target, true, true, false);
        available = false;
        start();
        assertTrue(sessions.isEmpty());
        assertEquals(0, captureCloses);
        assertEquals(DictationController.State.BLOCKED, controller.state());
    }

    @Test public void recordingAndFinalDeadlinesReleaseAndDiscard() {
        start();
        deadline.run();
        session().events.complete("late");
        assertEquals(DictationController.State.ERROR, controller.state());
        assertEquals(1, captureCloses);
        start();
        controller.stop();
        deadline.run();
        session().events.complete("late final");
        assertTrue(inserted.isEmpty());
        assertEquals(1, session().closes);
    }

    @Test public void startErrorsAreVisibleAndReleaseAllocatedResources() {
        captureFails = true;
        start();
        assertEquals(DictationController.State.ERROR, controller.state());
        assertEquals(1, captureCloses);
        assertEquals(1, session().closes);
        assertTrue(messages.get(messages.size() - 1).contains("Session start failed"));
        captureFails = false;
        providerFails = true;
        start();
        assertEquals(DictationController.State.ERROR, controller.state());
    }

    @Test public void captureFailureAndInvalidPcmRelease() {
        start();
        captureFailure.run();
        assertEquals(DictationController.State.ERROR, controller.state());
        assertEquals(1, session().closes);
        start();
        audio.accept(new byte[] { 1 });
        assertEquals(DictationController.State.ERROR, controller.state());
        assertEquals(2, captureCloses);
        assertTrue(inserted.isEmpty());
    }

    @Test public void providerFailureAndEmptyFinalAreVisible() {
        start();
        session().events.failure();
        assertEquals(DictationController.State.ERROR, controller.state());
        start();
        controller.stop();
        session().events.complete(" ");
        assertEquals(DictationController.State.ERROR, controller.state());
        assertTrue(inserted.isEmpty());
    }

    @Test public void commitRejectionNeverRetries() {
        accepted = false;
        start();
        controller.stop();
        session().events.complete("once");
        session().events.complete("once");
        assertEquals(List.of("once"), inserted);
        assertEquals(DictationController.State.ERROR, controller.state());
        assertTrue(messages.get(messages.size() - 1).contains("Editor rejected final"));
    }

    @Test public void releaseFailureDoesNotCommitOrSkipCaptureCleanup() {
        start();
        session().closeFails = true;
        controller.stop();
        session().events.complete("discard");
        assertTrue(inserted.isEmpty());
        assertEquals(1, captureCloses);
        assertEquals(DictationController.State.ERROR, controller.state());
        assertTrue(messages.get(messages.size() - 1).contains("Resource release failed"));
    }

    @Test public void repeatedStartStopAndCancelAreHarmless() {
        start();
        start();
        controller.stop();
        controller.stop();
        controller.cancel("User cancelled");
        controller.cancel("Hidden");
        session().events.complete("discard");
        assertEquals(1, sessions.size());
        assertEquals(1, captureCloses);
        assertEquals(1, session().closes);
        assertTrue(inserted.isEmpty());
    }

    @Test public void secureAndUnsupportedFieldsAreBlocked() {
        int text = InputType.TYPE_CLASS_TEXT;
        assertTrue(EditorPolicy.allows(text | InputType.TYPE_TEXT_FLAG_MULTI_LINE, 0));
        assertFalse(EditorPolicy.allows(text | InputType.TYPE_TEXT_VARIATION_PASSWORD, 0));
        assertFalse(EditorPolicy.allows(text | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD, 0));
        assertFalse(EditorPolicy.allows(text | InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD, 0));
        assertFalse(EditorPolicy.allows(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD, 0));
        assertFalse(EditorPolicy.allows(InputType.TYPE_NULL, 0));
        assertFalse(EditorPolicy.allows(InputType.TYPE_CLASS_PHONE, 0));
        assertFalse(EditorPolicy.allows(text, EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING));
    }
}
