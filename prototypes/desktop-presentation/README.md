# Desktop presentation prototype

An isolated, dependency-free policy model, not an application feature. It never
reads target text, pastes, changes another application's caret, changes taskbar
settings, installs an Explorer extension, activates a window or grants permissions.
Floating mode is left unchanged. No service provider or audio is involved.

## Capability boundary

| Surface | Verified contract | Not established |
| --- | --- | --- |
| Windows caret | `GetGUIThreadInfo` in User32, Windows 2000+ (`winuser.h`). Set `cbSize`; missing handles and losing activation are explicitly possible. `rcCaret` is caret-window logical/client geometry, includes direction/padding, and is not an exact insertion point. | Real editor geometry, custom controls, mixed-DPI mapping and cross-application target identity. |
| Windows UIA | `IUIAutomationTextPattern2::GetCaretRange`, Windows 8+ / Server 2012+ (`UIAutomation.h`), supplies `isActive` and a zero-length range. UIA screen coordinates are physical. `GetBoundingRectangles` may return an empty array for an empty/off-screen/obscured range. | A nonempty caret rectangle from every provider. Never expand into surrounding text to manufacture caret geometry. |
| macOS AX | `AXUIElementCopyAttributeValue`, macOS 10.2+; `AXUIElementCopyParameterizedAttributeValue`, 10.3+ (`ApplicationServices`, `AXUIElement.h`); trust-with-options is 10.9+. Focused element, selected range and bounds-for-range attributes are provider-dependent. | Cross-process access without Accessibility trust, bounds for all zero-length ranges, secure-field recognition for every custom control. |
| Windows 11 taskbar | Microsoft's Windows 11 specifications explicitly say apps can no longer customize taskbar areas. No supported tray-left persistent-control slot is established. | Native embedding on Windows 11, including 21H2 onward. No Explorer injection, `SetParent`, private shell class traversal or substitute tray icon. |
| Independent Windows appbar | `SHAppBarMessage` (`shellapi.h`, Shell32; documented minimum XP). `ABM_NEW`, `QUERYPOS`, `SETPOS`, `REMOVE` manage a separate screen-edge window; same-edge taskbar stays outermost. | An appbar is **not** a taskbar child or a reserved area left of the tray. No appbar is registered by this prototype. |
| Docked-window alternative | Pure geometry inside the selected monitor's work area, labelled **Docked window (not taskbar embedded)**. | Actual interactive control, tray-relative alignment, window rendering or OS focus/accessibility acceptance. Choosing this alternative is a separate product decision. |

Direct official references, checked 2026-11-01:

- [GetGUIThreadInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getguithreadinfo)
- [GetCaretRange](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationtextpattern2-getcaretrange)
- [GetBoundingRectangles](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationtextrange-getboundingrectangles)
- [UIA screen scaling](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-screenscaling)
- [LogicalToPhysicalPointForPerMonitorDPI](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-logicaltophysicalpointforpermonitordpi) (Windows 8.1+)
- [SetThreadDpiAwarenessContext](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddpiawarenesscontext) (Windows 10 1607+; per-monitor v2 requires 1703+)
- [UIA integrity boundaries](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)
- [Windows 11 feature removals](https://www.microsoft.com/en-us/windows/windows-11-specifications) (Taskbar row)
- [Application desktop toolbars](https://learn.microsoft.com/en-us/windows/win32/shell/application-desktop-toolbars)
- [SHAppBarMessage](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shappbarmessage) (`GETTASKBARPOS` is system-taskbar-only; `GetMonitorInfo` supplies monitor work areas)
- [Legacy band objects](https://learn.microsoft.com/en-us/windows/win32/shell/band-objects) (historical deskband documentation is not a Windows 11 support guarantee)
- [Apple AX trust](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions)
- [Apple attribute reads](https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue)
- [Apple parameterized reads](https://developer.apple.com/documentation/applicationservices/1461203-axuielementcopyparameterizedattr)
- [Apple top-left AX screen coordinates](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition)

Apple's machine-readable reference is available under
`https://developer.apple.com/tutorials/data/documentation/applicationservices/`
with the same numeric symbol name and `.json` suffix. It supplies availability
and declarations without depending on the documentation site's JavaScript.

## Adapter input contract

`presentation.cjs` accepts only validated, explicitly tagged geometry.
Windows adapters must map **both corners** of caret-window client coordinates
through the owning HWND's coordinate/DPI context, handle Win32 failures and
revalidate HWND/process/focus identity after the read. Do not multiply desktop
positions by `dpi / 96`, apply the caller's DPI to another window, or relabel
`rcCaret` as physical. `physicalRect` deliberately rejects logical/client input.
UIA adapters must require active focus and exactly one valid rectangle, release
COM/SAFEARRAY resources, and use bounded off-UI-thread queries. A hung provider
must expire/hide the marker rather than block recording/final delivery.

AX adapters must first check trust **without prompting**, verify focus, plain
editable-field eligibility and secure subrole, then request
`kAXSelectedTextRangeAttribute` and `kAXBoundsForRangeParameterizedAttribute`
without fetching `AXValue` or surrounding text. A nonzero selection is not an
insertion point: the adapter must supply an independently verified insertion
anchor or mark unavailable. Missing attributes, denied access and `AXError`
failures are explicit blockers. AX screen points use a top-left origin; AppKit
window placement uses a different coordinate convention. `axCaretRect` maps
through an independently verified **display-local** AX-point/pixel pair; it
rejects cross-display rectangles and inconsistent scale. It does not discover
that mapping or claim real mixed-Retina correctness.

Adapters assign opaque `targetKey` identities including process/window/field
and lifetime generation, never window titles or text. `focusRevision` changes
for every observed focus switch, even switching away and back. `topologyRevision`
changes for monitor/DPI/work-area changes. `observedAt` and `now` share a
monotonic clock; samples expire at **more than 250ms**. Unknown permission,
security, integrity, visibility, delivery eligibility or capability hides the
marker. Elevated/secure/inaccessible fields are excluded; this phase makes no
UIAccess, elevation, TCC or signing changes.

## Lifecycle and geometry

`CaretPresentation.begin(targetKey)` pins an already-authorized delivery target;
it is not target discovery or authorization. `request()` issues a generation/
sequence ticket; `accept()` consumes only the latest outstanding ticket and
copies its sample. Late, duplicate and stopped-session results cannot restore
old geometry. Invalid/latest target reads clear the old sample. Call
`invalidate(reason)` synchronously on selection movement, focus/window change,
permission loss, screen lock, monitor/DPI change or provider failure. Re-query
the **same** pinned target; never implicitly follow a different foreground field.
New-target selection belongs to the final-delivery owner.

Call `plan(context)` on a bounded timer as well as on notifications, so expiration
actually hides the UI even when notifications stop. A hidden result invalidates
the cached sample; it cannot reappear without a fresh query. `stop()`/`dispose()`
invalidate all tickets; disposal is terminal. The adapter must cancel its query
workers, remove observers/hooks/timers and destroy its own overlay in `finally`.
This pure model owns no OS resources and does not assert that adapter cleanup
already exists.

Marker geometry is a separate blue microphone status window, not another app's
caret. It chooses a nearby below/above/side position wholly inside the destination
monitor work area, scaled from 24x28 DIP with a 6 DIP gap. It never clamps the
marker to an unrelated distant corner. No fitting adjacent position means hide.
The model disables animation, so reduced-motion settings cannot be ignored.

`planDock` requires explicit nonactivation capability, fresh physical taskbar/
monitor data, consistent edge/work-area geometry and minimum 44 DIP status size.
All four edges are tested as geometry (not a claim Windows 11 supports all edges).
It uses an 8 DIP inset inside the work-area corner, never covers the taskbar or
assumes a tray width. Fullscreen, **any** auto-hide state (including temporarily
revealed), unknown shell state and topology changes hide the alternative.
Fresh geometry recomputes after resize/monitor changes; no stale position sticks.

Both presentation plans require no activation/focus, pointer pass-through and
status-only accessibility. A real actionable button needs separately accepted
keyboard/screen-reader access through the application's existing controls, not
an inaccessible focus-stealing overlay. No action dispatcher exists here.

## CI and evidence classification

All validation runs only in `desktop-presentation.yml`, scoped to this directory.
Each **entire job** has a 180-second limit, including checkout, setup, compilation,
execution and artifact upload; no dependencies or paid runners are installed.

| Output | Runner coverage | Meaning |
| --- | --- | --- |
| Node 24 tests + `demo.json` | Windows x64, Windows ARM64, macOS ARM64 | Synthetic geometry/capability/lifecycle tests; no native GUI. |
| `native.json` + SDK/OS/run/head identity | Windows x64, macOS ARM64 | Native SDK declaration compilation and limited metadata calls only. No native Windows ARM64 probe. |

The Windows console probe queries only its **own thread** via
`GetGUIThreadInfo`, records missing owned-editor capability/error, and restores
its temporary DPI context. UIA/appbar contracts are compile-checked, not queried.
The macOS console probe checks Accessibility trust with prompting disabled,
releases its options dictionary and does **not** read any application's field,
even if already trusted. Untrusted status is a recorded cross-process blocker,
not a false claim of successful accessibility.
The ARM64 compile uses a macOS 11.0 deployment target; API introduction versions
above come from Apple's reference, not from running on those older systems.

The demo emits anonymous JSON decisions, not rendered screenshots. There is no
GUI screenshot, SVG, GIF or video and **no real caret/taskbar UI evidence**.
Console/SDK probe success does not satisfy native UI acceptance.

Next isolated boundary: after a supported owned-desktop runtime is available,
an adapter can exercise synthetic owned editors and an owned nonactivating
marker, with real native caret/focus/DPI measurements, forced failure cleanup
and identified native desktop recordings within a 600-second entire-job limit.
Do not duplicate desktop infrastructure or integrate this policy into the app
before that runtime and independent review are ready.
