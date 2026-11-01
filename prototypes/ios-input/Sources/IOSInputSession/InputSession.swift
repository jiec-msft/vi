import Foundation

public struct InputSession: Sendable {
    public enum Phase: Equatable, Sendable {
        case idle, opening, capturing, finalizing, review, delivered, cancelled, failed
    }

    public enum Effect: Equatable, Sendable {
        case openProvider(UUID)
        case startCapture(UUID)
        case stopCapture(UUID)
        case finishProvider(UUID)
        case cancelProvider(UUID)
        case closeProvider(UUID)
    }

    public enum SessionError: Error, Equatable, Sendable {
        case consentRequired, foregroundRequired, sessionBusy, invalidPhase
        case staleEditor, emptyFinal, providerFailed
    }

    public enum CallbackResult: Equatable, Sendable {
        case accepted([Effect])
        case ignoredStale
    }

    public private(set) var phase: Phase = .idle
    public private(set) var sessionID: UUID?
    public private(set) var preview = ""
    public private(set) var finalText: String?
    public private(set) var failure: SessionError?
    private var editorLease: UUID?

    public init() {}

    public mutating func begin(
        consentGranted: Bool, isForeground: Bool, editorLease: UUID
    ) throws -> [Effect] {
        guard consentGranted else { throw SessionError.consentRequired }
        guard isForeground else { throw SessionError.foregroundRequired }
        guard isTerminal else { throw SessionError.sessionBusy }
        let id = UUID()
        sessionID = id
        self.editorLease = editorLease
        preview = ""
        finalText = nil
        failure = nil
        phase = .opening
        return [.openProvider(id)]
    }

    public mutating func providerOpened(sessionID id: UUID) throws -> CallbackResult {
        guard accepts(id) else { return .ignoredStale }
        guard phase == .opening else { throw SessionError.invalidPhase }
        phase = .capturing
        return .accepted([.startCapture(id)])
    }

    public mutating func providerPartial(
        sessionID id: UUID, text: String
    ) throws -> CallbackResult {
        guard accepts(id) else { return .ignoredStale }
        guard phase == .capturing || phase == .finalizing else {
            throw SessionError.invalidPhase
        }
        preview = text
        return .accepted([])
    }

    public mutating func requestFinish() throws -> [Effect] {
        guard phase == .capturing, let id = sessionID else {
            throw SessionError.invalidPhase
        }
        phase = .finalizing
        return [.stopCapture(id), .finishProvider(id)]
    }

    public mutating func providerFinal(
        sessionID id: UUID, text: String
    ) throws -> CallbackResult {
        guard accepts(id) else { return .ignoredStale }
        guard phase == .finalizing else { throw SessionError.invalidPhase }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .accepted(terminate(as: .failed, failure: .emptyFinal))
        }
        finalText = text
        preview = ""
        phase = .review
        return .accepted([.closeProvider(id)])
    }

    public mutating func providerFailure(sessionID id: UUID) -> CallbackResult {
        guard accepts(id) else { return .ignoredStale }
        return .accepted(terminate(as: .failed, failure: .providerFailed))
    }

    // This lease protects an owned editor, not a text field in another app.
    public mutating func takeFinal(editorLease: UUID) throws -> String {
        guard phase == .review, let text = finalText else {
            throw SessionError.invalidPhase
        }
        guard self.editorLease == editorLease else {
            _ = terminate(as: .failed, failure: .staleEditor)
            throw SessionError.staleEditor
        }
        phase = .delivered
        finalText = nil
        self.editorLease = nil
        return text
    }

    public mutating func cancel() -> [Effect] {
        guard !isTerminal else { return [] }
        return terminate(as: .cancelled, failure: nil)
    }

    public mutating func leaveForeground() -> [Effect] {
        cancel()
    }

    public mutating func invalidateEditor() -> [Effect] {
        cancel()
    }

    private var isTerminal: Bool {
        switch phase {
        case .idle, .delivered, .cancelled, .failed: true
        case .opening, .capturing, .finalizing, .review: false
        }
    }

    private func accepts(_ id: UUID) -> Bool {
        sessionID == id && !isTerminal && phase != .review
    }

    private mutating func terminate(
        as phase: Phase, failure: SessionError?
    ) -> [Effect] {
        var effects: [Effect] = []
        if let id = sessionID, self.phase != .review, !isTerminal {
            if self.phase == .capturing {
                effects.append(.stopCapture(id))
            }
            effects += [.cancelProvider(id), .closeProvider(id)]
        }
        self.phase = phase
        self.failure = failure
        preview = ""
        finalText = nil
        editorLease = nil
        return effects
    }
}
