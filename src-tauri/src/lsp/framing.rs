//! The base protocol's framing: `Content-Length: <bytes>`, a blank line, then that many bytes.

use std::io::{self, BufRead, Read, Write};

/// A larger message ends the session instead of filling memory.
pub const MAX_BODY: usize = 64 * 1024 * 1024;
/// The longest header line looked at in one piece.
const MAX_LINE: u64 = 8 * 1024;
/// How much a server may print between two messages before it counts as broken.
const MAX_NOISE: usize = 1024 * 1024;
const LENGTH: &[u8] = b"content-length:";

fn broken(what: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what)
}

/// The length a header line gives. Stray output without a line ending can sit in front of the
/// header on the same line, so the name is looked for anywhere in it.
fn content_length(line: &[u8]) -> Option<u64> {
    let at = line.windows(LENGTH.len()).rposition(|w| w.eq_ignore_ascii_case(LENGTH))?;
    let digits = line[at + LENGTH.len()..].trim_ascii();
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    // Too many digits for a u64 is simply too large.
    Some(std::str::from_utf8(digits).ok()?.parse().unwrap_or(u64::MAX))
}

/// The next message, its framing removed. `None` at the end of the stream, also in the middle of
/// a message. Lines that are no header (a server printing to stdout) are skipped.
pub fn read_message(reader: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    let mut length = None;
    let mut skipped = 0;
    loop {
        line.clear();
        let read = reader.by_ref().take(MAX_LINE).read_until(b'\n', &mut line)?;
        if read == 0 {
            return Ok(None);
        }
        skipped += read;
        if skipped > MAX_NOISE {
            return Err(broken("it printed too much that is not the protocol".into()));
        }
        let text = line.trim_ascii();
        if let Some(n) = content_length(text) {
            if n > MAX_BODY as u64 {
                return Err(broken(format!("it sent a message of {n} bytes, more than Mango accepts")));
            }
            length = Some(n);
        } else if text.is_empty() {
            if let Some(n) = length {
                // Grows as the bytes arrive: the header alone must not allocate 64 MB.
                let mut body = Vec::new();
                if (reader.by_ref().take(n).read_to_end(&mut body)? as u64) < n {
                    return Ok(None);
                }
                return Ok(Some(match String::from_utf8(body) {
                    Ok(text) => text,
                    Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
                }));
            }
        }
    }
}

pub fn write_message(writer: &mut impl Write, message: &str) -> io::Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n", message.len())?;
    writer.write_all(message.as_bytes())?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    /// Hands out what it holds a few bytes at a time, as a pipe may.
    struct Pieces {
        data: Vec<u8>,
        at: usize,
        size: usize,
    }

    impl Read for Pieces {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.size.min(buf.len()).min(self.data.len() - self.at);
            buf[..n].copy_from_slice(&self.data[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }

    fn read_all(data: &[u8], size: usize) -> io::Result<Vec<String>> {
        let mut reader = BufReader::new(Pieces { data: data.to_vec(), at: 0, size });
        let mut out = Vec::new();
        while let Some(message) = read_message(&mut reader)? {
            out.push(message);
        }
        Ok(out)
    }

    #[test]
    fn split_and_coalesced_reads() {
        let messages = ["{}", r#"{"text":"größer 🥭 € \r\n\r\n"}"#, "", "{\"a\":\n\"Content-Length: 9\"}"];
        let mut data = Vec::new();
        for m in messages {
            write_message(&mut data, m).unwrap();
        }
        // Every read size, down to single bytes and up to everything at once.
        for size in 1..=data.len() {
            assert_eq!(read_all(&data, size).unwrap(), messages, "reads of {size} bytes");
        }
    }

    #[test]
    fn lengths_are_bytes() {
        let mut data = Vec::new();
        write_message(&mut data, "🥭é").unwrap();
        assert_eq!(data, "Content-Length: 6\r\n\r\n🥭é".as_bytes());
    }

    #[test]
    fn header_forms() {
        let typed = b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length:  2 \r\n\r\n{}";
        assert_eq!(read_all(typed, 3).unwrap(), ["{}"]);
        assert_eq!(read_all(b"CONTENT-LENGTH:2\r\nContent-Type: x\r\n\r\n{}", 4).unwrap(), ["{}"]);
        // Bare line feeds, as some servers print.
        assert_eq!(read_all(b"Content-Length: 2\n\n{}", 4).unwrap(), ["{}"]);
        assert_eq!(content_length(b"Content-Length: -1"), None);
        assert_eq!(content_length(b"Content-Length: 1 2"), None);
        assert_eq!(content_length(b"Content-Length:"), None);
        assert_eq!(content_length(b"Content-Length: 99999999999999999999999"), Some(u64::MAX));
    }

    #[test]
    fn stray_output_is_skipped() {
        let data = b"warming up\n\n\xff\xfe\nContent-Length: soon\nreadyContent-Length: 2\r\n\r\n{}bye\nContent-Length: 4\r\n\r\ntrue";
        assert_eq!(read_all(data, 5).unwrap(), ["{}", "true"]);
        let mut long = vec![b'x'; 3 * MAX_LINE as usize];
        long.push(b'\n');
        long.extend_from_slice(b"Content-Length: 2\r\n\r\n{}");
        assert_eq!(read_all(&long, 4096).unwrap(), ["{}"]);
    }

    #[test]
    fn limits() {
        let huge = format!("Content-Length: {}\r\n\r\n", MAX_BODY + 1);
        assert_eq!(read_all(huge.as_bytes(), 64).unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert!(read_all(b"Content-Length: 99999999999999999999999\r\n\r\n", 64).is_err());
        assert!(read_all(&vec![b'x'; MAX_NOISE + 2], 64 * 1024).is_err(), "endless output without a message");
        assert!(read_all(&b"\n".repeat(MAX_NOISE + 2), 64 * 1024).is_err(), "endless blank lines");
        // The count starts again after each message.
        let mut many = Vec::new();
        for _ in 0..3 {
            many.extend_from_slice(&b"log\n".repeat(MAX_NOISE / 5));
            write_message(&mut many, "{}").unwrap();
        }
        assert_eq!(read_all(&many, 64 * 1024).unwrap().len(), 3);
    }

    #[test]
    fn a_cut_off_message_is_the_end() {
        assert!(read_all(b"Content-Length: 10\r\n\r\n{}", 4).unwrap().is_empty());
        assert!(read_all(b"Content-Length: 10\r\n", 4).unwrap().is_empty());
        assert_eq!(read_all(b"Content-Length: 1\r\n\r\n\xff", 4).unwrap(), ["\u{FFFD}"]);
    }
}
