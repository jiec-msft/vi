package org.example.vikeyboard;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.provider.Settings;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class SetupActivity extends Activity {
    private TextView status;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(24, 24, 24, 24);
        TextView rationale = new TextView(this);
        rationale.setText(R.string.permission_rationale);
        layout.addView(rationale);
        status = new TextView(this);
        layout.addView(status);
        button(layout, R.string.permission_request, () -> requestPermissions(
                new String[] { Manifest.permission.RECORD_AUDIO }, 1));
        button(layout, R.string.input_settings, () -> startActivity(
                new Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)));
        button(layout, R.string.input_picker, () ->
                getSystemService(InputMethodManager.class).showInputMethodPicker());
        setContentView(layout);
        updatePermission();
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        updatePermission();
    }

    private void updatePermission() {
        status.setText(checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED ? R.string.permission_granted : R.string.permission_denied);
    }

    private void button(LinearLayout parent, int label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setOnClickListener(view -> action.run());
        parent.addView(button);
    }
}
