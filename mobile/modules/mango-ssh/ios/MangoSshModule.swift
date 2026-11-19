import CryptoKit
import ExpoModulesCore
import Foundation
import NIOConcurrencyHelpers
import NIOCore

/// The SSH transport behind `src/ssh/native.ts` (contract: `src/ssh/types.ts`).
///
/// Promises are settled by hand (`Promise.reject(code, message)`) rather than by throwing
/// from async closures, so JavaScript gets the plain message and not Expo's
/// "Call to function … has been rejected" wrapper.
public final class MangoSshModule: Module {
  /// Streams started by `exec`, by the id JavaScript gave them.
  private let processes = NIOLockedValueBox([String: SshSession]())

  public func definition() -> ModuleDefinition {
    Name("MangoSsh")

    /// `{ id, stream: "stdout" | "stderr", lines: string[], sizes: number[], partial?: true }`: whole
    /// lines, in order, with the bytes each took (`\n` included); `partial`: the stream ended in the
    /// middle of this (single) last line.
    /// `{ id, code: number | null }`: once, after the last lines.
    Events("onLines", "onExit")

    OnDestroy {
      self.processes.withLockedValue { all in
        all.values.forEach { $0.kill() }
        all.removeAll()
      }
    }

    AsyncFunction("importKey") { (keyId: String, seed: String, promise: Promise) in
      settle(promise) {
        guard let raw = SshKeyFormat.base64url(seed), raw.count == 32 else {
          throw SshFailure("That key is damaged. Copy the whole share link again.")
        }
        try SshKeychain.save(keyId, seed: raw, comment: "")
        return nil
      }
    }

    AsyncFunction("generateKey") { (keyId: String, comment: String, promise: Promise) in
      settle(promise) {
        let key = Curve25519.Signing.PrivateKey()
        try SshKeychain.save(keyId, seed: key.rawRepresentation, comment: comment)
        return SshKeyFormat.publicLine(key.publicKey.rawRepresentation, comment: comment)
      }
    }

    AsyncFunction("publicKey") { (keyId: String, promise: Promise) in
      settle(promise) {
        guard let stored = try SshKeychain.load(keyId) else { return nil }
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: stored.seed)
        return SshKeyFormat.publicLine(key.publicKey.rawRepresentation, comment: stored.comment)
      }
    }

    AsyncFunction("deleteKey") { (keyId: String, promise: Promise) in
      settle(promise) {
        try SshKeychain.delete(keyId)
        return nil
      }
    }

    AsyncFunction("probeHostKey") { (host: String, port: Int, promise: Promise) in
      settleAsync(promise, host: host, port: port) {
        let key = try await SshConnection.probeHostKey(host: host, port: port)
        let parts = String(openSSHPublicKey: key).split(separator: " ")
        let type = parts.first.map(String.init) ?? ""
        let blob = parts.count > 1 ? String(parts[1]) : ""
        return [
          "type": type,
          "key": blob,
          "fingerprint": SshKeyFormat.fingerprint(Data(base64Encoded: blob) ?? Data()),
        ]
      }
    }

    AsyncFunction("run") { (endpoint: EndpointRecord, command: String, options: RunOptionsRecord, promise: Promise) in
      let target = endpoint.target
      settleAsync(promise, host: target.host, port: target.port) {
        let timeout = options.timeoutMs.map { max(1, $0) } ?? 30_000
        let out = try await SshSession.run(
          target, command: command, stdin: options.stdin, timeout: .milliseconds(Int64(timeout)),
          maxBytes: options.maxBytes.map { max(0, $0) } ?? 64 << 20, key: signingKey(target.keyId))
        return [
          "code": out.code.map { $0 as Any } ?? NSNull(),
          "stdout": out.stdout,
          "stderr": out.stderr,
        ]
      }
    }

    AsyncFunction("exec") { (id: String, endpoint: EndpointRecord, command: String, promise: Promise) in
      let target = endpoint.target
      settleAsync(promise, host: target.host, port: target.port) {
        let session = try await SshSession.start(
          target, command: command, sink: self.streamSink(id), key: signingKey(target.keyId))
        // Forgotten when it closes, which may have happened already for a short command.
        let processes = self.processes
        processes.withLockedValue { $0[id] = session }
        session.channel.closeFuture.whenComplete { _ in
          processes.withLockedValue { _ = $0.removeValue(forKey: id) }
        }
        return nil
      }
    }

    AsyncFunction("write") { (id: String, data: String, promise: Promise) in
      settleAsync(promise, host: "", port: 0) {
        try await self.process(id).write(data)
        return nil
      }
    }

    AsyncFunction("closeStdin") { (id: String, promise: Promise) in
      settleAsync(promise, host: "", port: 0) {
        try await self.process(id).closeStdin()
        return nil
      }
    }

    AsyncFunction("kill") { (id: String, promise: Promise) in
      let session = self.processes.withLockedValue { $0.removeValue(forKey: id) }
      session?.kill()
      promise.resolve(nil)
    }

    AsyncFunction("disconnect") { (endpoint: EndpointRecord, promise: Promise) in
      let target = endpoint.target
      Task {
        await SshPool.shared.disconnect(target)
        promise.resolve(nil)
      }
    }
  }

  private func process(_ id: String) throws -> SshSession {
    guard let session = processes.withLockedValue({ $0[id] }) else {
      throw SshFailure("That command has already finished.")
    }
    return session
  }

  /// Turns a stream's output into `onLines` events (one per read, not per line, to keep
  /// the bridge quiet) and its end into one `onExit`. Each event carries the bytes every line
  /// took (`sizes`, `\n` included); the unfinished last line of a stream that ended is sent on
  /// its own, marked `partial`.
  private func streamSink(_ id: String) -> SessionSink {
    let lines = StreamLines()
    let emit = { [weak self] (stream: String, batch: (lines: [String], sizes: [Int]), partial: Bool) in
      if !batch.lines.isEmpty {
        var event: [String: Any] = ["id": id, "stream": stream, "lines": batch.lines, "sizes": batch.sizes]
        if partial { event["partial"] = true }
        self?.sendEvent("onLines", event)
      }
    }
    let rest = { (last: (line: String, size: Int)?) -> (lines: [String], sizes: [Int]) in
      last.map { ([$0.line], [$0.size]) } ?? ([], [])
    }
    let flush = {
      emit("stdout", rest(lines.stdout.finish()), true)
      emit("stderr", rest(lines.stderr.finish()), true)
    }
    return SessionSink(
      stdout: { bytes in emit("stdout", lines.stdout.push(bytes.readableBytesView), false) },
      stderr: { bytes in emit("stderr", lines.stderr.push(bytes.readableBytesView), false) },
      eof: flush,
      exit: { [weak self] code in
        flush()
        self?.sendEvent("onExit", ["id": id, "code": code.map { $0 as Any } ?? NSNull()])
      })
  }
}

/// An endpoint as JavaScript passes it (`SshEndpoint`).
struct EndpointRecord: Record {
  @Field var host: String = ""
  @Field var port: Int = 22
  @Field var user: String = ""
  @Field var keyId: String = ""
  @Field var hostKey: String = ""

  var target: SshTarget {
    SshTarget(host: host, port: port, user: user, keyId: keyId, hostKey: hostKey)
  }
}

struct RunOptionsRecord: Record {
  @Field var stdin: String?
  @Field var timeoutMs: Int?
  @Field var maxBytes: Int?
}

/// The line splitters of one stream, used only on its event loop.
private final class StreamLines: @unchecked Sendable {
  var stdout = LineSplitter()
  var stderr = LineSplitter()
}

/// Reads the key from the Keychain when a connection needs it, never earlier.
private func signingKey(_ keyId: String) -> @Sendable () throws -> Curve25519.Signing.PrivateKey {
  { try SshKeychain.privateKey(keyId) }
}

private func settle(_ promise: Promise, _ body: () throws -> Any?) {
  do {
    promise.resolve(try body())
  } catch {
    promise.reject("ERR_SSH", explain(error, host: "", port: 0).message)
  }
}

private func settleAsync(_ promise: Promise, host: String, port: Int, _ body: @escaping @Sendable () async throws -> Any?)
{
  Task {
    do {
      promise.resolve(try await body())
    } catch {
      promise.reject("ERR_SSH", explain(error, host: host, port: port).message)
    }
  }
}
