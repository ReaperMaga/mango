import Foundation
import NIOCore
import NIOSSH
import Network

/// An error whose message is meant for a person (it reaches the app's UI as is).
struct SshFailure: Error, CustomStringConvertible {
  let message: String
  init(_ message: String) { self.message = message }
  var description: String { message }
}

/// Failures the connection code raises itself, turned into words by `explain`.
enum SshProblem: Error {
  /// The server showed a host key other than the pinned one.
  case hostKeyMismatch(shown: String)
  /// The server turned down the key (or accepts no keys at all).
  case authRejected
  /// Not an error: the probe has read the host key and stops there.
  case probed(NIOSSHPublicKey)
  /// The connection ended before it was usable.
  case closedEarly
  /// TCP, key exchange and sign-in took longer than `SshLoop.connectTimeout`.
  case connectTimedOut
  case timedOut(String)
  case outputTooLarge(Int)
  case execRefused
}

/// A message a person can act on, for anything thrown while talking to `host:port`. The
/// wording keeps OpenSSH's key phrases ("connection refused", "host key does not match",
/// "authentication failed"…), which `src/remote/sshBackend.ts` recognises as it does the desktop's.
func explain(_ error: Error, host: String, port: Int) -> SshFailure {
  if let failure = error as? SshFailure { return failure }
  let address = host.isEmpty ? "the server" : port == 22 ? host : "\(host):\(port)"

  if let problem = error as? SshProblem {
    switch problem {
    case .hostKeyMismatch:
      return SshFailure(
        "The server's identity changed: the host key of \(address) does not match the one this device trusts. "
          + "The environment may have been rebuilt, or someone is in between. Join it again from a fresh share link.")
    case .authRejected:
      return SshFailure(
        "Signing in to \(address) failed: authentication failed with this device's key. The access may have been revoked or expired: ask for a new share link.")
    case .probed:
      return SshFailure("Could not read the server's host key.")
    case .closedEarly:
      return SshFailure("The connection was closed by \(address) before signing in. Check that it is an SSH server and try again.")
    case .connectTimedOut:
      return explain(ChannelError.connectTimeout(SshLoop.connectTimeout), host: host, port: port)
    case .timedOut(let what):
      return SshFailure("\(what) timed out. Check your connection and that \(address) is up.")
    case .outputTooLarge(let limit):
      let size = limit >= 1 << 20 ? "\(limit >> 20) MiB" : "\(limit) bytes"
      return SshFailure("The command printed more than \(size), so it was stopped.")
    case .execRefused:
      return SshFailure("\(address) refused to run the command.")
    }
  }

  if case ChannelError.connectTimeout = error {
    return SshFailure("Connecting to \(address) timed out. Check your connection and that the server is up.")
  }
  if let nw = error as? NWError {
    switch nw {
    case .posix(let code): return explain(posix: code, address: address)
    case .dns: return SshFailure("Could not resolve hostname \(host). Check the address and your connection.")
    default: return SshFailure("Could not connect to \(address): \(nw.localizedDescription)")
    }
  }
  if let io = error as? IOError, let code = POSIXErrorCode(rawValue: io.errnoCode) {
    return explain(posix: code, address: address)
  }
  if let ssh = error as? NIOSSHError {
    if ssh.type == .keyExchangeNegotiationFailure {
      return SshFailure("\(address) and this app have no encryption method in common.")
    }
    if ssh.type == .channelSetupRejected {
      return SshFailure("\(address) refused to open another session. Close some chats and try again.")
    }
    if ssh.type == .tcpShutdown || ssh.type == .creatingChannelAfterClosure {
      return SshFailure("The connection was closed by \(address).")
    }
    return SshFailure("The SSH connection to \(address) failed (\(ssh.type)).")
  }
  if let channel = error as? ChannelError {
    switch channel {
    case .ioOnClosedChannel, .alreadyClosed, .eof, .outputClosed, .inputClosed:
      return SshFailure("The connection was closed by \(address).")
    default:
      break
    }
  }
  return SshFailure("The SSH connection to \(address) failed: \(error)")
}

private func explain(posix code: POSIXErrorCode, address: String) -> SshFailure {
  switch code {
  case .ECONNREFUSED:
    return SshFailure("Connection refused by \(address): the server may be down, or SSH is not running on that port.")
  case .ETIMEDOUT:
    return SshFailure("Connecting to \(address) timed out. Check your connection and that the server is up.")
  case .ENETUNREACH, .EHOSTUNREACH, .ENETDOWN, .EHOSTDOWN:
    return SshFailure("Could not reach \(address): the network is unreachable from here. Check your connection (and VPN, if the server needs one).")
  case .ECONNRESET, .EPIPE, .ECONNABORTED:
    return SshFailure("The connection to \(address) was reset.")
  default:
    return SshFailure("Could not connect to \(address): \(String(cString: strerror(code.rawValue))).")
  }
}
