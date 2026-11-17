import CryptoKit
import Foundation
import Security

/// The OpenSSH text forms of Ed25519 keys, byte for byte what the desktop writes
/// (`src-tauri/src/envs/token.rs`) and what `ssh-keygen -lf` prints.
enum SshKeyFormat {
  static let ed25519 = "ssh-ed25519"

  /// The SSH wire blob of an `ssh-ed25519` public key: two length-prefixed strings.
  static func publicBlob(_ publicKey: Data) -> Data {
    var blob = Data()
    putString(&blob, Data(ed25519.utf8))
    putString(&blob, publicKey)
    return blob
  }

  /// `ssh-ed25519 AAAA… comment`, for `authorized_keys`.
  static func publicLine(_ publicKey: Data, comment: String) -> String {
    var line = "\(ed25519) \(publicBlob(publicKey).base64EncodedString()) \(comment)"
    while line.last?.isWhitespace == true { line.removeLast() }
    return line
  }

  /// `SHA256:…`: the blob's SHA-256 in base64 without padding.
  static func fingerprint(_ blob: Data) -> String {
    let digest = Data(SHA256.hash(data: blob)).base64EncodedString()
    return "SHA256:" + digest.replacingOccurrences(of: "=", with: "")
  }

  /// The 32-byte Ed25519 key inside a blob, nil unless the blob is exactly an `ssh-ed25519` key.
  static func ed25519Key(inBlob blob: Data) -> Data? {
    let bytes = [UInt8](blob)
    guard bytes.count == 51, bytes[0..<4] == [0, 0, 0, 11], Data(bytes[4..<15]) == Data(ed25519.utf8),
      bytes[15..<19] == [0, 0, 0, 32]
    else { return nil }
    return Data(bytes[19..<51])
  }

  /// base64url without padding (a share link's `k`), forgiving of padding and whitespace.
  static func base64url(_ text: String) -> Data? {
    var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    while s.count % 4 != 0 { s += "=" }
    return Data(base64Encoded: s)
  }

  private static func putString(_ out: inout Data, _ s: Data) {
    var length = UInt32(s.count).bigEndian
    withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
    out.append(s)
  }
}

/// Ed25519 seeds in the iOS Keychain, this device only, readable once it was first
/// unlocked (so a chat can keep streaming with the screen locked). The seed never goes
/// back to JavaScript: only public lines do.
enum SshKeychain {
  static let service = "dev.mango.mobile.ssh"

  /// Stores a seed, replacing any key under the same id. `comment` ends its public line.
  static func save(_ keyId: String, seed: Data, comment: String) throws {
    guard seed.count == 32 else { throw SshFailure("That key is damaged (an Ed25519 key is 32 bytes).") }
    let item = query(keyId)
    SecItemDelete(item as CFDictionary)
    var add = item
    add[kSecValueData as String] = seed
    add[kSecAttrComment as String] = comment
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else { throw keychainFailure(status) }
  }

  static func load(_ keyId: String) throws -> (seed: Data, comment: String)? {
    var q = query(keyId)
    q[kSecReturnData as String] = true
    q[kSecReturnAttributes as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let item = out as? [String: Any], let seed = item[kSecValueData as String] as? Data
    else { throw keychainFailure(status) }
    return (seed, item[kSecAttrComment as String] as? String ?? "")
  }

  static func delete(_ keyId: String) throws {
    let status = SecItemDelete(query(keyId) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw keychainFailure(status) }
  }

  /// The signing key for a stored seed.
  static func privateKey(_ keyId: String) throws -> Curve25519.Signing.PrivateKey {
    guard let seed = try load(keyId)?.seed else {
      throw SshFailure("This device has no key for that environment any more. Join it again from its share link.")
    }
    return try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
  }

  private static func query(_ keyId: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: keyId,
      kSecUseDataProtectionKeychain as String: true,
    ]
  }

  private static func keychainFailure(_ status: OSStatus) -> SshFailure {
    let detail = SecCopyErrorMessageString(status, nil) as String? ?? "error \(status)"
    return SshFailure("The Keychain refused to store or read the key (\(detail)).")
  }
}
