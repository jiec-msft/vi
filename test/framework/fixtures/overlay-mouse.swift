import AppKit
import ApplicationServices
import Foundation

func run() throws {
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true",
          CommandLine.arguments.count == 5,
          let pid = Int32(CommandLine.arguments[1]),
          let x = Double(CommandLine.arguments[3]), let y = Double(CommandLine.arguments[4]),
          NSRunningApplication(processIdentifier: pid) != nil else {
        throw NSError(domain: "Owned CI application unavailable.", code: 1)
    }
    let mode = CommandLine.arguments[2], point = CGPoint(x: x, y: y)
    if mode == "down" || mode == "click" {
        let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
        guard windows.contains(where: { window in
            guard window[kCGWindowOwnerPID as String] as? Int32 == pid,
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
            return rect.contains(point)
        }) else { throw NSError(domain: "Mouse press is not over an owned window.", code: 2) }
    }
    func post(_ type: CGEventType) throws {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                                  mouseCursorPosition: point, mouseButton: .left) else {
            throw NSError(domain: "OS mouse event unavailable.", code: 3)
        }
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.12)
    }
    switch mode {
    case "hover": try post(.mouseMoved)
    case "move": try post(.leftMouseDragged)
    case "down": try post(.leftMouseDown)
    case "up": try post(.leftMouseUp)
    case "click": try post(.mouseMoved); try post(.leftMouseDown); try post(.leftMouseUp)
    default: throw NSError(domain: "Invalid OS mouse action.", code: 4)
    }
    print("{\"input\":\"CGEvent\",\"ownerVerified\":true}")
}
do { try run() }
catch { fputs("Owned overlay OS mouse input failed: \(error)\n", stderr); exit(1) }
