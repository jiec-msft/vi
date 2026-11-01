package org.example.vikeyboard;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.inputmethodservice.InputMethodService;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class VoiceIme extends InputMethodService {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private DictationController controller;
    private CheckBox consent;
    private TextView status;
    private Button start;
    private Button stop;
    private boolean visible;
    private long editorEpoch;
    private String lastStatus = "IDLE";

    @Override public void onCreate() {
        super.onCreate();
        controller = new DictationController(new CaptureFactory(handler), handler::post,
                (action, milliseconds) -> {
                    handler.postDelayed(action, milliseconds);
                    return () -> handler.removeCallbacks(action);
                }, this::render);
    }

    @Override public View onCreateInputView() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(12, 8, 12, 8);
        layout.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(12, 8, 12, 8 + insets.getSystemWindowInsetBottom());
            return insets;
        });
        TextView warning = new TextView(this);
        warning.setText(R.string.prototype_warning);
        layout.addView(warning);
        TextView captureLabel = new TextView(this);
        captureLabel.setText(CaptureFactory.LABEL);
        layout.addView(captureLabel);
        status = new TextView(this);
        status.setText(lastStatus);
        layout.addView(status);
        consent = new CheckBox(this);
        consent.setText(R.string.consent);
        layout.addView(consent);
        LinearLayout controls = new LinearLayout(this);
        start = button(controls, R.string.start, this::startSession);
        stop = button(controls, R.string.stop, controller::stop);
        button(controls, R.string.cancel, () -> invalidate("User cancelled"));
        layout.addView(controls);
        LinearLayout settings = new LinearLayout(this);
        button(settings, R.string.switch_keyboard, () -> {
            invalidate("Keyboard switched");
            if (!switchToNextInputMethod(false)) {
                getSystemService(InputMethodManager.class).showInputMethodPicker();
            }
        });
        button(settings, R.string.setup, () -> {
            invalidate("Permission setup opened");
            startActivity(new Intent(this, SetupActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        });
        layout.addView(settings);
        render(lastStatus);
        return layout;
    }

    @Override public boolean onEvaluateFullscreenMode() { return false; }

    @Override public void onStartInput(EditorInfo info, boolean restarting) {
        invalidate("Editor started or restarted; old final discarded");
        super.onStartInput(info, restarting);
    }

    @Override public void onStartInputView(EditorInfo info, boolean restarting) {
        super.onStartInputView(info, restarting);
        visible = true;
        invalidate("Ready; consent required");
    }

    @Override public void onFinishInputView(boolean finishingInput) {
        visible = false;
        invalidate("Input view hidden; final discarded");
        super.onFinishInputView(finishingInput);
    }

    @Override public void onFinishInput() {
        invalidate("Editor finished; final discarded");
        super.onFinishInput();
    }

    @Override public void onUnbindInput() {
        invalidate("Input unbound; final discarded");
        super.onUnbindInput();
    }

    @Override public void onWindowHidden() {
        visible = false;
        invalidate("Keyboard hidden; final discarded");
        super.onWindowHidden();
    }

    @Override public void onDestroy() {
        visible = false;
        invalidate("Service destroyed; final discarded");
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private boolean allowed(InputConnection connection, long epoch) {
        EditorInfo info = getCurrentInputEditorInfo();
        return visible && isInputViewShown() && epoch == editorEpoch
                && connection != null && getCurrentInputConnection() == connection
                && info != null && EditorPolicy.allows(info.inputType, info.imeOptions);
    }

    private void startSession() {
        InputConnection connection = getCurrentInputConnection();
        long epoch = editorEpoch;
        boolean approved = consent.isChecked();
        consent.setChecked(false);
        controller.start(new DictationController.Target() {
            @Override public boolean available() { return allowed(connection, epoch); }
            @Override public boolean commit(String text) {
                return allowed(connection, epoch)
                        && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                        && connection.commitText(text, 1);
            }
        }, approved, checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED, CaptureFactory.AVAILABLE);
    }

    private void invalidate(String reason) {
        ++editorEpoch;
        if (consent != null) consent.setChecked(false);
        if (controller != null) controller.cancel(reason);
    }

    private void render(String message) {
        lastStatus = message;
        if (status == null) return;
        status.setText(message);
        boolean busy = controller.state() == DictationController.State.RECORDING
                || controller.state() == DictationController.State.FINALIZING;
        start.setEnabled(!busy);
        stop.setEnabled(controller.state() == DictationController.State.RECORDING);
        consent.setEnabled(!busy);
    }

    private Button button(LinearLayout parent, int label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setOnClickListener(view -> action.run());
        parent.addView(button, new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        return button;
    }
}
