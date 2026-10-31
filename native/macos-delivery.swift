import AppKit
import ApplicationServices
import Foundation

enum DeliveryError: String, Error {
    case target = "target-changed"
    case secure = "secure-field"
    case noInput = "no-input"
    case permission
    case clipboard = "clipboard-unavailable"
    case changed = "clipboard-changed"
    case restore = "restore-failed"
    case modifiers = "modifiers-held"
    case invalid = "invalid-request"
}

func capture() throws -> [String: Any] {
    guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier, pid > 0 else {
        throw DeliveryError.target
    }
    return ["pid": Int(pid)]
}

func checkTarget(_ target: [String: Any]) throws {
    guard let pid = target["pid"] as? Int, pid > 0,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(pid) else {
        throw DeliveryError.target
    }
    guard AXIsProcessTrusted() else { throw DeliveryError.permission }
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid_t(pid)),
        kAXFocusedUIElementAttribute as CFString, &focused) == .success,
        let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else {
        throw DeliveryError.target
    }
    let element = unsafeBitCast(focused, to: AXUIElement.self)
    var role: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success,
          let name = role as? String, ["AXTextField", "AXTextArea", "AXComboBox"].contains(name) else {
        throw DeliveryError.noInput
    }
    var subrole: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole)
    if result == .success, let name = subrole as? String, name.lowercased().contains("secure") {
        throw DeliveryError.secure
    }
}

func paste(_ text: String, _ target: [String: Any]) throws -> [String: Any] {
    guard !text.isEmpty, text.utf16.count <= 262144, !text.contains("\0") else { throw DeliveryError.invalid }
    let deadline = Date().addingTimeInterval(2)
    while !CGEventSource.flagsState(.combinedSessionState)
        .intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty ||
        CGEventSource.buttonState(.combinedSessionState, button: .left) ||
        CGEventSource.buttonState(.combinedSessionState, button: .right) {
        guard Date() < deadline else { throw DeliveryError.modifiers }
        Thread.sleep(forTimeInterval: 0.02)
    }
    try checkTarget(target)
    let board = NSPasteboard.general
    let before = board.changeCount
    var saved: [NSPasteboardItem] = []
    for item in board.pasteboardItems ?? [] {
        let copy = NSPasteboardItem()
        for type in item.types {
            guard let data = item.data(forType: type) else { throw DeliveryError.clipboard }
            guard copy.setData(data, forType: type) else { throw DeliveryError.clipboard }
        }
        saved.append(copy)
    }
    guard board.changeCount == before else { throw DeliveryError.changed }
    let transcript = NSPasteboardItem()
    guard transcript.setString(text, forType: .string),
          transcript.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")) else {
        throw DeliveryError.clipboard
    }
    var owned = board.clearContents()
    var failure: Error?
    do {
        guard board.changeCount == owned else { throw DeliveryError.changed }
        guard board.writeObjects([transcript]) else { throw DeliveryError.clipboard }
        owned = board.changeCount
        try checkTarget(target)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: false) else {
            throw DeliveryError.permission
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 1)
    } catch { failure = error }
    // Never replace a newer copy made by the user or another application.
    if board.changeCount == owned {
        board.clearContents()
        if !saved.isEmpty && !board.writeObjects(saved) { throw DeliveryError.restore }
    }
    if let failure { throw failure }
    return ["requested": true]
}

while let line = readLine() {
    var id = 0
    do {
        guard line.utf8.count <= 1_600_000,
              let data = line.data(using: .utf8),
              let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let number = request["id"] as? Int, let action = request["action"] as? String else {
            throw DeliveryError.invalid
        }
        id = number
        let value: [String: Any]
        switch action {
        case "ready": value = ["ready": true]
        case "capture": value = try capture()
        case "held":
            guard AXIsProcessTrusted() else { throw DeliveryError.permission }
            guard let keys = request["keys"] as? [Int], !keys.isEmpty, keys.count <= 6,
                  keys.allSatisfy({ (0...127).contains($0) }) else { throw DeliveryError.invalid }
            let modifiers = [55: 54, 56: 60, 59: 62, 58: 61]
            value = ["held": keys.allSatisfy {
                CGEventSource.keyState(.combinedSessionState, key: CGKeyCode($0)) ||
                    modifiers[$0].map { CGEventSource.keyState(.combinedSessionState, key: CGKeyCode($0)) } == true
            }]
        case "paste":
            guard let text = request["text"] as? String,
                  let target = request["target"] as? [String: Any] else { throw DeliveryError.invalid }
            value = try paste(text, target)
        default: throw DeliveryError.invalid
        }
        let output = try JSONSerialization.data(withJSONObject: ["id": id, "ok": true, "value": value])
        print(String(decoding: output, as: UTF8.self))
    } catch {
        let code = (error as? DeliveryError)?.rawValue ?? "native-error"
        let output = try! JSONSerialization.data(withJSONObject: ["id": id, "ok": false, "code": code])
        print(String(decoding: output, as: UTF8.self))
    }
    fflush(stdout)
}
