/// Cuts a byte stream into lines: split on `\n`, a trailing `\r` dropped, each line
/// decoded as UTF-8 only once it is whole (so a character split across reads stays intact).
///
/// Each line comes with the number of bytes it took in the stream, its `\n` included (before
/// the `\r` is dropped or bad UTF-8 is replaced): a remote run that is reattached after a dropped
/// connection resumes from the byte count of the whole lines it got (`src/remote/sshBackend.ts`).
///
/// Agents print single JSON lines of several megabytes, so nothing here is capped and a
/// long line is scanned once: `scanned` remembers how far the search for `\n` got.
struct LineSplitter {
  private var buffer: [UInt8] = []
  private var scanned = 0

  /// Bytes waiting for their line to end.
  var pending: Int { buffer.count }

  /// Adds bytes and returns the lines they complete, with the bytes each took (its `\n` included).
  mutating func push<Bytes: Collection>(_ bytes: Bytes) -> (lines: [String], sizes: [Int]) where Bytes.Element == UInt8 {
    buffer.append(contentsOf: bytes)
    var lines: [String] = []
    var sizes: [Int] = []
    var start = 0
    var i = scanned
    while i < buffer.count {
      if buffer[i] == 0x0A {
        lines.append(Self.decode(buffer[start..<i]))
        sizes.append(i + 1 - start)
        start = i + 1
      }
      i += 1
    }
    if start > 0 {
      buffer.removeFirst(start)
    }
    scanned = buffer.count
    return (lines, sizes)
  }

  /// The last line when the stream ended without a `\n`, if any, and its size in bytes.
  mutating func finish() -> (line: String, size: Int)? {
    defer {
      buffer = []
      scanned = 0
    }
    return buffer.isEmpty ? nil : (Self.decode(buffer[...]), buffer.count)
  }

  private static func decode(_ line: ArraySlice<UInt8>) -> String {
    let body = line.last == 0x0D ? line.dropLast() : line
    return String(decoding: body, as: UTF8.self)
  }
}
