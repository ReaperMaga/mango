import CryptoKit
import Foundation
import NIOConcurrencyHelpers
import NIOCore
import NIOSSH
import NIOTransportServices
import Network

/// Where to connect and as whom. Everything is part of the key, so a different key or a
/// re-pinned host never reuses a connection made under the old one.
struct SshTarget: Hashable, Sendable {
  let host: String
  let port: Int
  let user: String
  let keyId: String
  /// The pinned host key: base64 of the `ssh-ed25519` blob.
  let hostKey: String
}

/// The one event loop every connection runs on, off the main thread. Network.framework
/// (through NIO Transport Services) rather than BSD sockets: on iOS it wakes the cellular
/// radio, follows VPN on demand and reports when a path goes away.
enum SshLoop {
  static let group = NIOTSEventLoopGroup(loopCount: 1, defaultQoS: .userInitiated)

  static let connectTimeout = TimeAmount.seconds(15)
  static let sessionTimeout = TimeAmount.seconds(10)

  static func bootstrap(_ loop: EventLoop) -> NIOTSConnectionBootstrap {
    // Keepalives find a connection that died silently (the phone changed networks or slept)
    // within about half a minute, much like the desktop's ServerAliveInterval.
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.enableKeepalive = true
    tcp.keepaliveIdle = 15
    tcp.keepaliveInterval = 5
    tcp.keepaliveCount = 3
    return NIOTSConnectionBootstrap(group: loop)
      .connectTimeout(connectTimeout)
      .tcpOptions(tcp)
      // Fail at once (refused, no route) instead of waiting for the network to come back.
      .channelOption(NIOTSChannelOptions.waitForActivity, value: false)
  }
}

/// One authenticated connection. Sessions (exec channels) are opened on it; OpenSSH allows
/// ten per connection (`MaxSessions`), so the pool opens another one past `capacity`.
final class SshConnection: @unchecked Sendable {
  let channel: Channel
  /// `sessions` counts slots taken (opening or open), `open` the sessions the server accepted.
  private let state = NIOLockedValueBox((sessions: 0, open: 0, capacity: 8))

  init(channel: Channel) { self.channel = channel }

  var isActive: Bool { channel.isActive }

  /// Takes a session slot, false when there is none left.
  func reserve() -> Bool {
    state.withLockedValue { s in
      guard s.sessions < s.capacity else { return false }
      s.sessions += 1
      return true
    }
  }

  func release() { state.withLockedValue { $0.sessions = max(0, $0.sessions - 1) } }

  var sessions: Int { state.withLockedValue { $0.sessions } }

  /// The server turned a session down while the connection is fine: it takes no more than
  /// it has open now.
  func markFull() { state.withLockedValue { $0.capacity = max(1, $0.open) } }

  /// Opens a session channel; `setup` adds its handlers before it becomes active.
  /// The caller must hold a slot (`reserve`), which is given back when the channel closes.
  func openSession(_ setup: @escaping (Channel) -> EventLoopFuture<Void>) async throws -> Channel {
    let loop = channel.eventLoop
    let created = loop.makePromise(of: Channel.self)
    let parent = channel
    loop.execute {
      do {
        let ssh = try parent.pipeline.syncOperations.handler(type: NIOSSHHandler.self)
        ssh.createChannel(created, channelType: .session) { child, type in
          guard type == .session else { return child.eventLoop.makeFailedFuture(SshProblem.execRefused) }
          return setup(child)
        }
      } catch {
        created.fail(error)
      }
    }
    // A connection that died silently never answers: give up on it after a while, and
    // close the session should it open after all (its command must not run unwatched).
    let opened = loop.makePromise(of: Channel.self)
    let timeout = loop.scheduleTask(in: SshLoop.sessionTimeout) {
      opened.fail(SshProblem.timedOut("Opening a session"))
    }
    created.futureResult.whenComplete { result in
      timeout.cancel()
      opened.completeWith(result)
    }
    opened.futureResult.whenFailure { _ in
      created.futureResult.whenSuccess { $0.close(promise: nil) }
    }
    do {
      let child = try await opened.futureResult.get()
      state.withLockedValue { $0.open += 1 }
      child.closeFuture.whenComplete { [weak self] _ in
        self?.state.withLockedValue { $0.open -= 1 }
        self?.release()
      }
      return child
    } catch {
      release()
      throw error
    }
  }

  func close() { channel.close(promise: nil) }
}

/// Keeps one connection per endpoint (more only when one runs out of sessions), shared by
/// every command and stream, and replaces a dead one on the next use.
actor SshPool {
  static let shared = SshPool()

  private(set) var connections: [SshTarget: [SshConnection]] = [:]
  private var connecting: [SshTarget: Task<SshConnection, Error>] = [:]

  /// Opens a session for `target`. A failure on a reused connection (it may have died since
  /// its last use) is retried once on a fresh one; a server that refuses more sessions on a
  /// connection gets another connection.
  func openSession(
    _ target: SshTarget, key: @escaping @Sendable () throws -> Curve25519.Signing.PrivateKey,
    setup: @escaping (Channel) -> EventLoopFuture<Void>
  ) async throws -> Channel {
    var (connection, reused) = try await slot(target, key: key)
    var attempts = 1
    while true {
      do {
        return try await connection.openSession(setup)
      } catch {
        let refused = connection.isActive && (error as? NIOSSHError)?.type == .channelSetupRejected
        if refused {
          connection.markFull()
        } else {
          drop(connection, of: target)
        }
        guard refused ? attempts < 5 : reused else { throw error }
        attempts += 1
        (connection, reused) = try await slot(target, key: key)
      }
    }
  }

  /// Closes every connection to `target`.
  func disconnect(_ target: SshTarget) {
    connections.removeValue(forKey: target)?.forEach { $0.close() }
  }

  /// A connection with a free session slot (reserved for the caller), and whether it was
  /// already open before this call.
  private func slot(
    _ target: SshTarget, key: @escaping @Sendable () throws -> Curve25519.Signing.PrivateKey
  ) async throws -> (SshConnection, Bool) {
    while true {
      prune(target)
      if let open = connections[target]?.first(where: { $0.reserve() }) {
        return (open, true)
      }
      if let running = connecting[target] {
        // Someone is connecting already: wait for it, then look again.
        _ = try await running.value
        continue
      }
      let pending = Task {
        defer { self.connecting[target] = nil }
        let connection = try await SshConnection.connect(target, key: try key())
        _ = connection.reserve()  // the first slot is the caller's
        self.connections[target, default: []].append(connection)
        return connection
      }
      connecting[target] = pending
      return (try await pending.value, false)
    }
  }

  /// Forgets closed connections, and extra ones nobody uses any more.
  private func prune(_ target: SshTarget) {
    guard var list = connections[target] else { return }
    list.removeAll { !$0.isActive }
    while list.count > 1, let idle = list.lastIndex(where: { $0.sessions == 0 }), idle > 0 {
      list.remove(at: idle).close()
    }
    connections[target] = list.isEmpty ? nil : list
  }

  private func drop(_ connection: SshConnection, of target: SshTarget) {
    connections[target]?.removeAll { $0 === connection }
    connection.close()
  }
}

// MARK: - Connecting

extension SshConnection {
  /// Connects and signs in with `key`, accepting only the pinned host key.
  static func connect(_ target: SshTarget, key: Curve25519.Signing.PrivateKey) async throws -> SshConnection {
    guard let blob = Data(base64Encoded: target.hostKey.trimmingCharacters(in: .whitespaces)),
      SshKeyFormat.ed25519Key(inBlob: blob) != nil
    else {
      throw SshFailure("The saved host key for \(target.host) is not an ssh-ed25519 key. Join the environment again.")
    }
    let pinned = blob.base64EncodedString()
    let user = target.user
    let channel = try await handshake(host: target.host, port: target.port) {
      .init(
        userAuthDelegate: KeyAuthentication(user: user, key: NIOSSHPrivateKey(ed25519Key: key)),
        serverAuthDelegate: PinnedHostKey(blob: pinned))
    }
    return SshConnection(channel: channel)
  }

  /// Connects only to read the server's host key, trusting and authenticating nothing.
  static func probeHostKey(host: String, port: Int) async throws -> NIOSSHPublicKey {
    do {
      let channel = try await handshake(host: host, port: port) {
        .init(userAuthDelegate: KeyAuthentication.none, serverAuthDelegate: HostKeyProbe())
      }
      channel.close(promise: nil)
    } catch SshProblem.probed(let key) {
      return key
    }
    throw SshProblem.closedEarly
  }

  /// TCP, key exchange and sign-in, within `SshLoop.connectTimeout` all together.
  private static func handshake(
    host: String, port: Int, configuration: @escaping @Sendable () -> SSHClientConfiguration
  ) async throws -> Channel {
    guard (1...65535).contains(port), let port = NWEndpoint.Port(rawValue: UInt16(port)) else {
      throw SshFailure("\(port) is not a valid SSH port.")
    }
    let loop = SshLoop.group.next()
    let ready = loop.makePromise(of: Channel.self)
    let deadline = loop.scheduleTask(in: SshLoop.connectTimeout) {
      ready.fail(SshProblem.connectTimedOut)
    }
    ready.futureResult.whenComplete { _ in deadline.cancel() }

    SshLoop.bootstrap(loop)
      .channelInitializer { channel in
        channel.eventLoop.makeCompletedFuture {
          let ssh = NIOSSHHandler(
            role: .client(configuration()), allocator: channel.allocator, inboundChildChannelInitializer: nil)
          try channel.pipeline.syncOperations.addHandlers(ssh, HandshakeWatcher(ready: ready))
        }
      }
      .connect(endpoint: .hostPort(host: NWEndpoint.Host(host), port: port))
      .whenComplete { result in
        switch result {
        case .failure(let error):
          ready.fail(error)
        case .success(let channel):
          // Timed out or refused after the TCP connection was made: do not leave it open.
          ready.futureResult.whenFailure { _ in channel.close(promise: nil) }
        }
      }
    return try await ready.futureResult.get()
  }
}

/// Reports when sign-in succeeded, or the first error that ended the connection.
/// After sign-in, any error closes the connection: its sessions end and the pool replaces it.
private final class HandshakeWatcher: ChannelInboundHandler {
  typealias InboundIn = Any

  private let ready: EventLoopPromise<Channel>
  private var failure: Error?

  init(ready: EventLoopPromise<Channel>) { self.ready = ready }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if event is UserAuthSuccessEvent {
      ready.succeed(context.channel)
    }
    context.fireUserInboundEventTriggered(event)
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) {
    if failure == nil { failure = error }
    ready.fail(error)
    context.close(promise: nil)
  }

  func channelInactive(context: ChannelHandlerContext) {
    ready.fail(failure ?? SshProblem.closedEarly)
    context.fireChannelInactive()
  }
}

/// Offers the one key, once. A second request means the server turned it down.
private final class KeyAuthentication: NIOSSHClientUserAuthenticationDelegate {
  private let user: String
  private let key: NIOSSHPrivateKey?
  private var offered = false

  init(user: String, key: NIOSSHPrivateKey?) {
    self.user = user
    self.key = key
  }

  /// For the probe, which never gets as far as signing in.
  static var none: KeyAuthentication { KeyAuthentication(user: "", key: nil) }

  func nextAuthenticationType(
    availableMethods: NIOSSHAvailableUserAuthenticationMethods,
    nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>
  ) {
    guard let key, !offered, availableMethods.contains(.publicKey) else {
      nextChallengePromise.fail(SshProblem.authRejected)
      return
    }
    offered = true
    nextChallengePromise.succeed(
      NIOSSHUserAuthenticationOffer(username: user, serviceName: "", offer: .privateKey(.init(privateKey: key))))
  }
}

/// Accepts exactly the pinned `ssh-ed25519` key and nothing else, like the desktop's
/// `StrictHostKeyChecking=yes` with a one-line known_hosts.
private final class PinnedHostKey: NIOSSHClientServerAuthenticationDelegate {
  private let blob: String

  init(blob: String) { self.blob = blob }

  func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
    let shown = String(openSSHPublicKey: hostKey)
    if shown == "\(SshKeyFormat.ed25519) \(blob)" {
      validationCompletePromise.succeed(())
    } else {
      validationCompletePromise.fail(SshProblem.hostKeyMismatch(shown: shown))
    }
  }
}

/// Records the host key and stops the handshake right there.
private final class HostKeyProbe: NIOSSHClientServerAuthenticationDelegate {
  func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
    validationCompletePromise.fail(SshProblem.probed(hostKey))
  }
}
