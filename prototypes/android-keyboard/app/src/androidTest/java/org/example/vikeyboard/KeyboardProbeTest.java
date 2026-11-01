package org.example.vikeyboard;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
import android.os.Process;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.io.File;
import java.io.FileWriter;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;

public final class KeyboardProbeTest {
    private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private final File evidence = new File(context.getExternalFilesDir(null), "evidence");

    @Test public void realImeCommitsOnceAndDiscardsOnLifecycleChanges() throws Exception {
        assertTrue(evidence.mkdirs() || evidence.isDirectory());
        String packageName = context.getPackageName();
        Intent editor = new Intent(context, OwnedEditorActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(editor);
        clickResource("owned_normal");
        waitState("CANCELLED:");
        screenshot("01-visible-keyboard.png");

        click("Start");
        waitState("BLOCKED: Explicit session consent required");
        assertReleased();
        consentAndStart();
        waitState("BLOCKED: Microphone permission denied");
        assertReleased();
        screenshot("05-permission-denied.png");
        device.executeShellCommand("pm grant " + packageName + " android.permission.RECORD_AUDIO");
        consentAndStart();
        waitState("RECORDING:");
        assertEquals(0, OwnedEditorActivity.COMMITS.get());
        assertEquals(1, CaptureFactory.OPEN_CAPTURES.get());
        screenshot("02-synthetic-recording.png");
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                OwnedEditorActivity.current.normal.setSelection(6, 13));
        click("Stop / final");
        waitState("COMMITTED:");
        assertEquals(1, OwnedEditorActivity.COMMITS.get());
        assertEquals("owned " + FakeProvider.FINAL + " tail", text(R.id.owned_normal));
        assertReleased();
        screenshot("03-final-only-commit.png");

        consentAndStart();
        waitState("RECORDING:");
        click("Stop / final");
        click("Cancel");
        device.waitForIdle();
        waitState("CANCELLED:");
        assertReleased();
        assertEquals(1, OwnedEditorActivity.COMMITS.get());

        consentAndStart();
        waitState("RECORDING:");
        click("Stop / final");
        clickResource("owned_other");
        waitState("CANCELLED:");
        assertReleased();
        assertEquals("", text(R.id.owned_other));
        assertEquals(1, OwnedEditorActivity.COMMITS.get());

        consentAndStart();
        waitState("RECORDING:");
        click("Stop / final");
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                context.getSystemService(android.view.inputmethod.InputMethodManager.class)
                        .restartInput(OwnedEditorActivity.current.other));
        waitState("CANCELLED:");
        assertReleased();
        assertEquals("", text(R.id.owned_other));
        screenshot("06-restart-cancelled.png");

        consentAndStart();
        waitState("RECORDING:");
        click("Stop / final");
        device.pressBack();
        assertTrue(device.wait(Until.gone(By.text("Stop / final")), 5_000));
        assertReleased();
        clickResource("owned_secure");
        waitState("CANCELLED:");
        consentAndStart();
        waitState("BLOCKED: Secure, unsupported or inaccessible editor");
        assertReleased();
        screenshot("04-secure-blocked.png");

        clickResource("owned_other");
        waitState("CANCELLED:");
        consentAndStart();
        waitState("RECORDING:");
        click("Stop / final");
        click("Switch keyboard");
        assertTrue(device.wait(Until.gone(By.text("Stop / final")), 5_000));
        assertReleased();
        String ime = packageName + "/org.example.vikeyboard.VoiceIme";
        long restoreDeadline = SystemClock.uptimeMillis() + 5_000;
        String selection = device.executeShellCommand("ime set " + ime);
        assertTrue("IME selection command did not confirm target: " + selection,
                selection.contains("Input method " + ime + " selected for user #0"));
        assertEquals(ime, Settings.Secure.getString(context.getContentResolver(),
                Settings.Secure.DEFAULT_INPUT_METHOD));
        long remaining = restoreDeadline - SystemClock.uptimeMillis();
        assertTrue("IME restore exceeded the existing deadline", remaining > 0);
        UiObject2 controls = device.wait(Until.findObject(By.pkg(packageName).text("Switch keyboard")),
                remaining);
        assertNotNull("Restored prototype IME view is not visible", controls);
        assertEquals(ime, Settings.Secure.getString(context.getContentResolver(),
                Settings.Secure.DEFAULT_INPUT_METHOD));
        UiObject2 restoredEditor = device.findObject(By.res(packageName, "owned_other"));
        assertNotNull("Missing editor: owned_other", restoredEditor);
        restoredEditor.click();
        remaining = restoreDeadline - SystemClock.uptimeMillis();
        assertTrue("IME restore exceeded the existing deadline", remaining > 0);
        waitState("CANCELLED:", remaining);
        assertEquals(1, OwnedEditorActivity.COMMITS.get());
        assertEquals(0, OwnedEditorActivity.ACTIONS.get());

        JSONObject report = new JSONObject();
        report.put("pid", Process.myPid());
        report.put("api", android.os.Build.VERSION.SDK_INT);
        report.put("input", "320 synthetic PCM16 samples, 16 kHz mono; no hardware or recognition");
        report.put("final", FakeProvider.FINAL);
        report.put("commits", OwnedEditorActivity.COMMITS.get());
        report.put("editorActions", OwnedEditorActivity.ACTIONS.get());
        report.put("openCaptures", CaptureFactory.OPEN_CAPTURES.get());
        report.put("openProviders", FakeProvider.OPEN_SESSIONS.get());
        report.put("lastSessionState", device.findObject(By.textStartsWith("CANCELLED:")).getText());
        report.put("cases", "visible IME; consent; selection replacement; duplicate final; cancel; target switch; same-editor restart; hide; password; keyboard switch; permission denied");
        try (FileWriter writer = new FileWriter(new File(evidence, "probe.json"))) {
            writer.write(report.toString(2));
        }
    }

    private void assertReleased() {
        assertEquals("Capture leak", 0, CaptureFactory.OPEN_CAPTURES.get());
        assertEquals("Provider leak", 0, FakeProvider.OPEN_SESSIONS.get());
    }

    private void consentAndStart() { click("I consent to audio for this session only"); click("Start"); }
    private void click(String text) {
        UiObject2 object = device.wait(Until.findObject(By.text(text)), 5_000);
        assertNotNull("Missing control: " + text, object);
        object.click();
    }
    private void clickResource(String id) {
        UiObject2 object = device.wait(Until.findObject(By.res(context.getPackageName(), id)), 5_000);
        assertNotNull("Missing editor: " + id, object);
        object.click();
    }
    private String text(int id) {
        AtomicReference<String> value = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> value.set(
                ((android.widget.EditText) OwnedEditorActivity.current.findViewById(id))
                        .getText().toString()));
        return value.get();
    }
    private void waitState(String prefix) {
        waitState(prefix, 5_000);
    }
    private void waitState(String prefix, long timeoutMilliseconds) {
        assertTrue("Missing state: " + prefix,
                device.wait(Until.hasObject(By.textStartsWith(prefix)), timeoutMilliseconds));
    }
    private void screenshot(String name) {
        assertTrue(device.takeScreenshot(new File(evidence, name)));
    }
}
