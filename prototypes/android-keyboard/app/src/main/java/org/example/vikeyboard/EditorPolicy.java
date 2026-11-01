package org.example.vikeyboard;

import android.text.InputType;
import android.view.inputmethod.EditorInfo;

final class EditorPolicy {
    private EditorPolicy() {}

    static boolean allows(int inputType, int imeOptions) {
        int type = inputType & InputType.TYPE_MASK_CLASS;
        int variation = inputType & InputType.TYPE_MASK_VARIATION;
        return type == InputType.TYPE_CLASS_TEXT
                && variation != InputType.TYPE_TEXT_VARIATION_PASSWORD
                && variation != InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                && variation != InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
                && (imeOptions & EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING) == 0;
    }
}
