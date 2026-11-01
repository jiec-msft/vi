import Foundation
import XCTest
@testable import IOSInputSession

final class InputSessionTests: XCTestCase {
    private let editor = UUID()

    private func openedSession() throws -> (InputSession, UUID) {
        var session = InputSession()
        _ = try session.begin(consentGranted: true, isForeground: true, editorLease: editor)
        let id = try XCTUnwrap(session.sessionID)
        XCTAssertEqual(try session.providerOpened(sessionID: id), .accepted([.startCapture(id)]))
        return (session, id)
    }

    private func reviewedSession() throws -> (InputSession, UUID) {
        var (session, id) = try openedSession()
        _ = try session.requestFinish()
        XCTAssertEqual(
            try session.providerFinal(sessionID: id, text: "Synthetic final text."),
            .accepted([.closeProvider(id)])
        )
        return (session, id)
    }

    func testConsentAndForegroundRequiredBeforeProviderOpen() throws {
        var session = InputSession()
        for (consent, foreground, expected) in [
            (false, true, InputSession.SessionError.consentRequired),
            (true, false, .foregroundRequired)
        ] {
            XCTAssertThrowsError(try session.begin(
                consentGranted: consent, isForeground: foreground, editorLease: editor
            )) { XCTAssertEqual($0 as? InputSession.SessionError, expected) }
            XCTAssertEqual(session.phase, .idle)
            XCTAssertNil(session.sessionID)
        }
        let effects = try session.begin(
            consentGranted: true, isForeground: true, editorLease: editor
        )
        let id = try XCTUnwrap(session.sessionID)
        XCTAssertEqual(effects, [.openProvider(id)])
        XCTAssertEqual(session.phase, .opening)
        XCTAssertThrowsError(try session.begin(
            consentGranted: true, isForeground: true, editorLease: editor
        )) { XCTAssertEqual($0 as? InputSession.SessionError, .sessionBusy) }
        XCTAssertEqual(session.sessionID, id)
    }

    func testPartialNeverDeliversAndFinalRequiresStopAndExplicitTake() throws {
        var (session, id) = try openedSession()
        XCTAssertEqual(
            try session.providerPartial(sessionID: id, text: "Synthetic preview"),
            .accepted([])
        )
        XCTAssertEqual(session.preview, "Synthetic preview")
        XCTAssertNil(session.finalText)
        XCTAssertThrowsError(try session.takeFinal(editorLease: editor))
        XCTAssertThrowsError(try session.providerFinal(sessionID: id, text: "Too early"))
        XCTAssertEqual(session.phase, .capturing)
        XCTAssertEqual(try session.requestFinish(), [.stopCapture(id), .finishProvider(id)])
        XCTAssertThrowsError(try session.requestFinish())
        XCTAssertEqual(
            try session.providerPartial(sessionID: id, text: "Finalizing preview"),
            .accepted([])
        )
        XCTAssertThrowsError(try session.takeFinal(editorLease: editor))
        XCTAssertEqual(
            try session.providerFinal(sessionID: id, text: "  Synthetic final text.\n"),
            .accepted([.closeProvider(id)])
        )
        XCTAssertEqual(session.phase, .review)
        XCTAssertEqual(session.preview, "")
        XCTAssertEqual(
            try session.takeFinal(editorLease: editor), "  Synthetic final text.\n"
        )
        XCTAssertEqual(session.phase, .delivered)
        XCTAssertNil(session.finalText)
        XCTAssertThrowsError(try session.takeFinal(editorLease: editor))
        XCTAssertEqual(try session.providerFinal(sessionID: id, text: "Late"), .ignoredStale)
    }

    func testCancelAtEveryActivePhaseDiscardsAndClosesExactlyOnce() throws {
        for phase in [InputSession.Phase.opening, .capturing, .finalizing, .review] {
            var session = InputSession()
            _ = try session.begin(consentGranted: true, isForeground: true, editorLease: editor)
            let id = try XCTUnwrap(session.sessionID)
            if phase != .opening {
                _ = try session.providerOpened(sessionID: id)
                _ = try session.providerPartial(sessionID: id, text: "Synthetic preview")
            }
            if phase == .finalizing || phase == .review {
                _ = try session.requestFinish()
            }
            if phase == .review {
                _ = try session.providerFinal(sessionID: id, text: "Synthetic final")
            }
            let expected: [InputSession.Effect]
            switch phase {
            case .capturing:
                expected = [.stopCapture(id), .cancelProvider(id), .closeProvider(id)]
            case .review:
                expected = []
            default:
                expected = [.cancelProvider(id), .closeProvider(id)]
            }
            XCTAssertEqual(session.cancel(), expected)
            XCTAssertEqual(session.cancel(), [])
            XCTAssertEqual(session.phase, .cancelled)
            XCTAssertEqual(session.preview, "")
            XCTAssertNil(session.finalText)
            XCTAssertThrowsError(try session.takeFinal(editorLease: editor))
            XCTAssertEqual(try session.providerOpened(sessionID: id), .ignoredStale)
            XCTAssertEqual(try session.providerPartial(sessionID: id, text: "Late"), .ignoredStale)
            XCTAssertEqual(try session.providerFinal(sessionID: id, text: "Late"), .ignoredStale)
            XCTAssertEqual(session.providerFailure(sessionID: id), .ignoredStale)
        }
    }

    func testOldCallbacksCannotAffectNewSession() throws {
        var (session, oldID) = try openedSession()
        _ = session.cancel()
        _ = try session.begin(consentGranted: true, isForeground: true, editorLease: editor)
        let newID = try XCTUnwrap(session.sessionID)
        XCTAssertNotEqual(oldID, newID)
        XCTAssertEqual(try session.providerOpened(sessionID: oldID), .ignoredStale)
        XCTAssertEqual(try session.providerPartial(sessionID: oldID, text: "Old"), .ignoredStale)
        XCTAssertEqual(try session.providerFinal(sessionID: oldID, text: "Old"), .ignoredStale)
        XCTAssertEqual(session.providerFailure(sessionID: oldID), .ignoredStale)
        XCTAssertEqual(session.phase, .opening)
        XCTAssertEqual(try session.providerOpened(sessionID: newID), .accepted([.startCapture(newID)]))
        XCTAssertNil(session.failure)
    }

    func testEditorLeaseMismatchFailsClosed() throws {
        var (session, _) = try reviewedSession()
        XCTAssertThrowsError(try session.takeFinal(editorLease: UUID())) {
            XCTAssertEqual($0 as? InputSession.SessionError, .staleEditor)
        }
        XCTAssertEqual(session.phase, .failed)
        XCTAssertEqual(session.failure, .staleEditor)
        XCTAssertNil(session.finalText)
        XCTAssertThrowsError(try session.takeFinal(editorLease: editor))
    }

    func testBackgroundAndEditorChangesCancelInsteadOfResuming() throws {
        var (backgroundSession, id) = try openedSession()
        XCTAssertEqual(backgroundSession.leaveForeground(), [
            .stopCapture(id), .cancelProvider(id), .closeProvider(id)
        ])
        XCTAssertThrowsError(try backgroundSession.requestFinish())
        XCTAssertThrowsError(try backgroundSession.begin(
            consentGranted: false, isForeground: true, editorLease: editor
        ))
        var (changedEditorSession, _) = try reviewedSession()
        XCTAssertEqual(changedEditorSession.invalidateEditor(), [])
        XCTAssertThrowsError(try changedEditorSession.takeFinal(editorLease: editor))
        XCTAssertEqual(changedEditorSession.phase, .cancelled)
    }

    func testProviderFailureAndEmptyFinalAreExplicitNotSuccess() throws {
        var (session, id) = try openedSession()
        XCTAssertEqual(session.providerFailure(sessionID: id), .accepted([
            .stopCapture(id), .cancelProvider(id), .closeProvider(id)
        ]))
        XCTAssertEqual(session.phase, .failed)
        XCTAssertEqual(session.failure, .providerFailed)
        XCTAssertNil(session.finalText)
        XCTAssertEqual(session.providerFailure(sessionID: id), .ignoredStale)

        for text in ["", " \n\t "] {
            var (emptySession, emptyID) = try openedSession()
            _ = try emptySession.requestFinish()
            XCTAssertEqual(
                try emptySession.providerFinal(sessionID: emptyID, text: text),
                .accepted([.cancelProvider(emptyID), .closeProvider(emptyID)])
            )
            XCTAssertEqual(emptySession.phase, .failed)
            XCTAssertEqual(emptySession.failure, .emptyFinal)
            XCTAssertNil(emptySession.finalText)
            XCTAssertThrowsError(try emptySession.takeFinal(editorLease: editor))
        }
    }

    func testCurrentSessionInvalidTransitionsAreErrors() throws {
        var session = InputSession()
        XCTAssertThrowsError(try session.requestFinish())
        XCTAssertThrowsError(try session.takeFinal(editorLease: editor))
        _ = try session.begin(consentGranted: true, isForeground: true, editorLease: editor)
        let id = try XCTUnwrap(session.sessionID)
        XCTAssertThrowsError(try session.providerPartial(sessionID: id, text: "Early"))
        XCTAssertThrowsError(try session.providerFinal(sessionID: id, text: "Early"))
        XCTAssertEqual(session.phase, .opening)
        _ = try session.providerOpened(sessionID: id)
        XCTAssertThrowsError(try session.providerOpened(sessionID: id))
        _ = try session.requestFinish()
        _ = try session.providerFinal(sessionID: id, text: "Synthetic")
        XCTAssertEqual(try session.providerPartial(sessionID: id, text: "Late"), .ignoredStale)
        XCTAssertEqual(session.providerFailure(sessionID: id), .ignoredStale)
        XCTAssertEqual(session.finalText, "Synthetic")
        XCTAssertThrowsError(try session.begin(
            consentGranted: true, isForeground: true, editorLease: editor
        ))
    }
}
