import CryptoKit
import Foundation
import NIOCore
import NIOSSH

/// What a session reports. Every callback runs on the connection's event loop, in order.
struct SessionSink {
  var stdout: (ByteBuffer) -> Void
  var stderr: (ByteBuffer) -> Void
  /// The server sent EOF: no more output will come.
  var eof: () -> Void = {}
  /// Once, when the channel of a command that ran has closed: the exit status, nil when it
  /// was killed by a signal or none was sent. A command that never started reports nothing
  /// here: its `start` fails instead.
  var exit: (Int?) -> Void
}

/// Runs one command on an exec channel and passes its output on.
final class SessionHandler: ChannelInboundHandler {
  typealias InboundIn = SSHChannelData

  private let command: String
  private let started: EventLoopPromise<Void>
  private let sink: SessionSink
  private var code: Int?
  /// Only a session the server opened reports anything: one it turned down is retried
  /// elsewhere with a new handler, and must not end the command it never ran.
  private var active = false
  /// The server runs the command: only then does its end count as an exit.
  private var running = false

  init(command: String, started: EventLoopPromise<Void>, sink: SessionSink) {
    self.command = command
    self.started = started
    self.sink = sink
  }

  func channelActive(context: ChannelHandlerContext) {
    active = true
    // wantReply, so a refusal is reported instead of the channel just closing; stdin is
    // only written once the command is running.
    let exec = SSHChannelRequestEvent.ExecRequest(command: command, wantReply: true)
    context.triggerUserOutboundEvent(exec, promise: nil)
    context.fireChannelActive()
  }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    let message = unwrapInboundIn(data)
    guard case .byteBuffer(let bytes) = message.data else { return }
    if message.type == .channel {
      sink.stdout(bytes)
    } else if message.type == .stdErr {
      sink.stderr(bytes)
    }
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    switch event {
    case is ChannelSuccessEvent:
      running = true
      started.succeed(())
    case is ChannelFailureEvent:
      started.fail(SshProblem.execRefused)
      context.close(promise: nil)
    case let status as SSHChannelRequestEvent.ExitStatus:
      code = status.exitStatus
    case is SSHChannelRequestEvent.ExitSignal:
      code = nil
    case let event as ChannelEvent where event == .inputClosed:
      sink.eof()
    default:
      context.fireUserInboundEventTriggered(event)
    }
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) {
    if active { started.fail(error) }
    context.close(promise: nil)
  }

  func channelInactive(context: ChannelHandlerContext) {
    guard active else {
      context.fireChannelInactive()
      return
    }
    started.fail(ChannelError.ioOnClosedChannel)
    if running { sink.exit(code) }
    context.fireChannelInactive()
  }
}

/// A running exec channel.
struct SshSession: Sendable {
  let channel: Channel

  /// Opens a session on the pool's connection for `target` and starts `command` in it.
  /// Resolves once the server runs it; output may reach `sink` before that.
  static func start(
    _ target: SshTarget, command: String, sink: SessionSink,
    key: @escaping @Sendable () throws -> Curve25519.Signing.PrivateKey
  ) async throws -> SshSession {
    let started = SshLoop.group.next().makePromise(of: Void.self)
    let channel: Channel
    do {
      channel = try await SshPool.shared.openSession(target, key: key) { child in
        child.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).flatMapThrowing {
          try child.pipeline.syncOperations.addHandler(SessionHandler(command: command, started: started, sink: sink))
        }
      }
    } catch {
      started.fail(error)
      throw error
    }
    do {
      try await started.futureResult.get()
    } catch {
      channel.close(promise: nil)
      throw error
    }
    return SshSession(channel: channel)
  }

  func write(_ text: String) async throws {
    let data = SSHChannelData(type: .channel, data: .byteBuffer(ByteBuffer(string: text)))
    try await channel.writeAndFlush(data).get()
  }

  /// Sends EOF: the command sees its stdin end.
  func closeStdin() async throws {
    do {
      try await channel.close(mode: .output).get()
    } catch ChannelError.alreadyClosed {
      // The command is gone already: nothing left to close.
    }
  }

  /// Asks the command to stop, then closes the channel.
  func kill() {
    channel.triggerUserOutboundEvent(SSHChannelRequestEvent.SignalRequest(signal: "TERM"), promise: nil)
    channel.close(promise: nil)
  }
}

/// What `run` returns.
struct RunOutput: Sendable {
  let code: Int?
  let stdout: String
  let stderr: String
}

extension SshSession {
  /// Runs a command to its end and captures its output (`run` in the JS API).
  static func run(
    _ target: SshTarget, command: String, stdin: String?, timeout: TimeAmount, maxBytes: Int,
    key: @escaping @Sendable () throws -> Curve25519.Signing.PrivateKey
  ) async throws -> RunOutput {
    let loop = SshLoop.group.next()
    let result = loop.makePromise(of: RunOutput.self)
    let collected = Collected()
    let sink = SessionSink(
      stdout: { bytes in
        collected.stdout.writeImmutableBuffer(bytes)
        if collected.stdout.readableBytes > maxBytes {
          result.fail(SshProblem.outputTooLarge(maxBytes))
        }
      },
      stderr: { bytes in
        // stderr only explains failures: keep its last part should it run on and on.
        collected.stderr.writeImmutableBuffer(bytes)
        if collected.stderr.readableBytes > 1 << 20 {
          collected.stderr.moveReaderIndex(forwardBy: collected.stderr.readableBytes - (1 << 19))
          collected.stderr.discardReadBytes()
        }
      },
      exit: { code in
        result.succeed(
          RunOutput(
            code: code, stdout: String(buffer: collected.stdout), stderr: String(buffer: collected.stderr)))
      })
    // The deadline covers connecting too.
    let deadline = loop.scheduleTask(in: timeout) { result.fail(SshProblem.timedOut("The command")) }
    result.futureResult.whenComplete { _ in deadline.cancel() }

    let work = Task {
      do {
        let session = try await start(target, command: command, sink: sink, key: key)
        result.futureResult.whenFailure { _ in session.channel.close(promise: nil) }
        if let stdin, !stdin.isEmpty {
          try await session.write(stdin)
        }
        try await session.closeStdin()
      } catch {
        result.fail(error)
      }
    }
    defer { work.cancel() }
    return try await result.futureResult.get()
  }
}

/// Output gathered on the event loop.
private final class Collected: @unchecked Sendable {
  var stdout = ByteBuffer()
  var stderr = ByteBuffer()
}
