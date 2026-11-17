/// Cuts a byte stream into lines: split on `\n`, a trailing `\r` dropped, each line
/// decoded as UTF-8 only once it is whole (so a character split across reads stays intact).
///
/// Agents print single JSON lines of several megabytes, so nothing here is capped and a
/// long line is scanned once: `scanned` remembers how far the search for `\n` got.
struct LineSplitter {
  private var buffer: [UInt8] = []
  private var scanned = 0

  /// Bytes waiting for their line to end.
  var pending: Int { buffer.count }

  /// Adds bytes and returns the lines they complete.
  mutating func push<Bytes: Collection>(_ bytes: Bytes) -> [String] where Bytes.Element == UInt8 {
    buffer.append(contentsOf: bytes)
    var lines: [String] = []
    var start = 0
    var i = scanned
    while i < buffer.count {
      if buffer[i] == 0x0A {
        lines.append(Self.decode(buffer[start..<i]))
        start = i + 1
      }
      i += 1
    }
    if start > 0 {
      buffer.removeFirst(start)
    }
    scanned = buffer.count
    return lines
  }

  /// The last line when the stream ended without a `\n`, if any.
  mutating func finish() -> String? {
    defer {
      buffer = []
      scanned = 0
    }
    return buffer.isEmpty ? nil : Self.decode(buffer[...])
  }

  private static func decode(_ line: ArraySlice<UInt8>) -> String {
    let body = line.last == 0x0D ? line.dropLast() : line
    return String(decoding: body, as: UTF8.self)
  }
}
