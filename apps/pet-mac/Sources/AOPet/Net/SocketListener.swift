import Foundation
import Darwin

/// Listens for line-delimited JSON envelopes on a Unix domain socket.
/// Reconnects with backoff if the socket file goes away or the peer closes.
final class SocketListener {
    static let defaultPath: String = {
        let home = NSHomeDirectory()
        return "\(home)/.agent-orchestrator/pet.sock"
    }()

    private let socketPath: String
    private let onEvent: (SocketEnvelope) -> Void
    private let queue = DispatchQueue(label: "dev.composio.aopet.socket")
    private var fd: Int32 = -1
    private var stopped = true
    private var buffer = Data()
    private var backoff: TimeInterval = 1

    init(
        path: String = SocketListener.defaultPath,
        onEvent: @escaping (SocketEnvelope) -> Void
    ) {
        self.socketPath = path
        self.onEvent = onEvent
    }

    func start() {
        stopped = false
        queue.async { [weak self] in self?.connectLoop() }
    }

    func stop() {
        stopped = true
        if fd >= 0 {
            Darwin.close(fd)
            fd = -1
        }
    }

    // MARK: - Internals

    private func connectLoop() {
        while !stopped {
            guard FileManager.default.fileExists(atPath: socketPath) else {
                OneShotLogger.shared.once("sock.missing", "Socket \(socketPath) does not exist; will keep checking")
                sleep(UInt32(min(30, backoff * 2)))
                backoff = min(30, backoff * 2)
                continue
            }

            let s = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            if s < 0 {
                OneShotLogger.shared.once("sock.create", "socket() failed: \(String(cString: strerror(errno)))")
                sleep(5)
                continue
            }

            var addr = sockaddr_un()
            addr.sun_family = sa_family_t(AF_UNIX)
            let pathBytes = Array(socketPath.utf8)
            // sockaddr_un.sun_path is a fixed-size C array. Copy in safely.
            withUnsafeMutablePointer(to: &addr.sun_path) { tuplePtr in
                tuplePtr.withMemoryRebound(to: CChar.self, capacity: 104) { cPtr in
                    let maxLen = min(pathBytes.count, 103)
                    for i in 0..<maxLen {
                        cPtr[i] = CChar(bitPattern: pathBytes[i])
                    }
                    cPtr[maxLen] = 0
                }
            }

            let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
            let connectResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    Darwin.connect(s, sockPtr, addrLen)
                }
            }

            if connectResult != 0 {
                OneShotLogger.shared.once("sock.connect", "connect(\(socketPath)) failed: \(String(cString: strerror(errno)))")
                Darwin.close(s)
                sleep(UInt32(min(30, backoff * 2)))
                backoff = min(30, backoff * 2)
                continue
            }

            // Success — reset backoff and clear failure tags so we'd notice
            // any future flap.
            OneShotLogger.shared.clear("sock.missing")
            OneShotLogger.shared.clear("sock.connect")
            OneShotLogger.shared.clear("sock.create")
            backoff = 1
            fd = s
            readLoop()
            // readLoop returned — peer closed or error. Loop back and reconnect.
            if fd >= 0 { Darwin.close(fd); fd = -1 }
            buffer.removeAll(keepingCapacity: true)
        }
    }

    private func readLoop() {
        let bufSize = 4096
        var rawBuf = [UInt8](repeating: 0, count: bufSize)
        while !stopped, fd >= 0 {
            let n = rawBuf.withUnsafeMutableBufferPointer { ptr -> Int in
                Darwin.read(fd, ptr.baseAddress, bufSize)
            }
            if n <= 0 {
                if n < 0 {
                    OneShotLogger.shared.once("sock.read", "read() failed: \(String(cString: strerror(errno)))")
                }
                return
            }
            buffer.append(rawBuf, count: n)
            drainLines()
        }
    }

    private func drainLines() {
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: 0..<nl)
            buffer.removeSubrange(0...nl)
            guard !line.isEmpty else { continue }
            do {
                let env = try WireDecoder.decodeEvent(line)
                guard env.kind == "event" else { continue }
                DispatchQueue.main.async {
                    self.onEvent(env)
                }
            } catch {
                OneShotLogger.shared.once("sock.parse", "Failed to decode socket line: \(error)")
            }
        }
    }
}
