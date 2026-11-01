#include <cstdio>
#include <type_traits>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <ole2.h>
#include <shellapi.h>
#include <UIAutomation.h>

static_assert(std::is_member_function_pointer_v<decltype(&IUIAutomationTextPattern2::GetCaretRange)>);
static_assert(std::is_member_function_pointer_v<decltype(&IUIAutomationTextRange::GetBoundingRectangles)>);
static_assert(std::is_pointer_v<decltype(&LogicalToPhysicalPointForPerMonitorDPI)>);
static_assert(std::is_pointer_v<decltype(&SHAppBarMessage)>);

int main() {
    const auto previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (!previous) {
        std::fprintf(stderr, "DPI context setup failed: %lu\n", GetLastError());
        return 1;
    }
    GUITHREADINFO info{};
    info.cbSize = static_cast<DWORD>(sizeof(info));
    SetLastError(ERROR_SUCCESS);
    const BOOL available = GetGUIThreadInfo(GetCurrentThreadId(), &info);
    const DWORD error = available ? ERROR_SUCCESS : GetLastError();
    const auto restored = SetThreadDpiAwarenessContext(previous);
    if (!restored || !AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), previous)) {
        std::fprintf(stderr, "DPI context restoration failed: %lu\n", GetLastError());
        return 1;
    }
    if (info.hwndCaret || info.hwndFocus) {
        std::fprintf(stderr, "Unexpected UI target on the probe's own console thread.\n");
        return 1;
    }
    std::printf("{\"schemaVersion\":1,\"evidenceKind\":\"native-contract-metadata\","
        "\"platform\":\"windows\",\"nativeUiExercised\":false,"
        "\"queryScope\":\"own-thread-only\",\"guiThreadInfoAvailable\":%s,"
        "\"guiThreadInfoError\":%lu,\"caretStatus\":\"unavailable-no-owned-editor\","
        "\"dpiContextRestored\":true,\"uiaContractCompiled\":true,"
        "\"appbarContractCompiled\":true,\"shellQueried\":false,"
        "\"targetTextRead\":false,\"windowsTargetVersion\":%u}\n",
        available ? "true" : "false", error, static_cast<unsigned int>(_WIN32_WINNT));
    return 0;
}
#elif defined(__APPLE__)
#include <ApplicationServices/ApplicationServices.h>

static_assert(std::is_pointer_v<decltype(&AXUIElementCopyAttributeValue)>);
static_assert(std::is_pointer_v<decltype(&AXUIElementCopyParameterizedAttributeValue)>);
static_assert(std::is_pointer_v<decltype(&AXObserverCreate)>);

int main() {
    const void* keys[] = { kAXTrustedCheckOptionPrompt };
    const void* values[] = { kCFBooleanFalse };
    const auto options = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (!options) {
        std::fprintf(stderr, "Accessibility trust options allocation failed.\n");
        return 1;
    }
    const bool trusted = AXIsProcessTrustedWithOptions(options);
    CFRelease(options);
    // Compile the provider-dependent attributes; never query another application's fields.
    const CFStringRef attributes[] = {
        kAXFocusedUIElementAttribute, kAXSelectedTextRangeAttribute,
        kAXBoundsForRangeParameterizedAttribute, kAXSubroleAttribute, kAXSecureTextFieldSubrole,
        kAXFocusedUIElementChangedNotification, kAXSelectedTextChangedNotification,
    };
    std::printf("{\"schemaVersion\":1,\"evidenceKind\":\"native-contract-metadata\","
        "\"platform\":\"macos\",\"nativeUiExercised\":false,"
        "\"accessibilityTrusted\":%s,\"permissionPrompted\":false,"
        "\"caretStatus\":\"unavailable-not-queried\",\"axContractCompiled\":true,"
        "\"attributeCount\":%zu,\"optionsReleased\":true,\"targetTextRead\":false}\n",
        trusted ? "true" : "false", sizeof(attributes) / sizeof(attributes[0]));
    return 0;
}
#else
#error Unsupported native contract probe platform.
#endif
