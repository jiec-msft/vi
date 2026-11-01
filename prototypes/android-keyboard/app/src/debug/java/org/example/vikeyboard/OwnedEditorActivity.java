package org.example.vikeyboard;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import android.view.inputmethod.TextAttribute;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.concurrent.atomic.AtomicInteger;

public final class OwnedEditorActivity extends Activity {
    static OwnedEditorActivity current;
    static final AtomicInteger COMMITS = new AtomicInteger();
    static final AtomicInteger ACTIONS = new AtomicInteger();
    EditText normal;
    EditText other;
    EditText secure;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        current = this;
        COMMITS.set(0);
        ACTIONS.set(0);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(24, 96, 24, 24);
        TextView title = new TextView(this);
        title.setText("CI OWNED EDITOR / SYNTHETIC INPUT ONLY");
        layout.addView(title);
        normal = editor(layout, R.id.owned_normal, "owned replace tail", InputType.TYPE_CLASS_TEXT);
        other = editor(layout, R.id.owned_other, "", InputType.TYPE_CLASS_TEXT);
        other.setHint("Second owned editor");
        secure = editor(layout, R.id.owned_secure, "", InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        secure.setHint("Owned password field (must block)");
        setContentView(layout);
    }

    @Override public void onDestroy() {
        current = null;
        super.onDestroy();
    }

    private EditText editor(LinearLayout parent, int id, String text, int inputType) {
        EditText editor = new EditText(this) {
            @Override public InputConnection onCreateInputConnection(EditorInfo info) {
                InputConnection real = super.onCreateInputConnection(info);
                if (real == null) return null;
                return new InputConnectionWrapper(real, false) {
                    @Override public boolean commitText(CharSequence value, int cursor) {
                        COMMITS.incrementAndGet();
                        return super.commitText(value, cursor);
                    }
                    @android.annotation.TargetApi(33)
                    @Override public boolean commitText(CharSequence value, int cursor, TextAttribute attribute) {
                        COMMITS.incrementAndGet();
                        return super.commitText(value, cursor, attribute);
                    }
                    @Override public boolean performEditorAction(int action) {
                        ACTIONS.incrementAndGet();
                        return super.performEditorAction(action);
                    }
                };
            }
        };
        editor.setId(id);
        editor.setInputType(inputType);
        editor.setImeOptions(EditorInfo.IME_ACTION_SEND);
        editor.setText(text);
        parent.addView(editor);
        return editor;
    }
}
