// Generates the 1024×1024 watch app icon into a fixed-size, alpha-free bitmap
// (Apple rejects wrong-sized or alpha-carrying watch icons).
//
// Usage:
//   swift make-icon.swift <output.png> [sourceLogo.png]
// With a source logo (e.g. ../assets/icon.png), it composites the logo over the
// AO dark background so transparent corners become opaque. Without one, it draws
// an "AO" wordmark as a fallback.
import AppKit

let args = CommandLine.arguments
let outPath = args.count > 1 ? args[1] : "icon-1024.png"
let logoPath = args.count > 2 ? args[2] : nil

let size = 1024
let dim = CGFloat(size)
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
	data: nil, width: size, height: size,
	bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
	bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue // opaque, no alpha
) else { exit(1) }

// AO dark background fill (#0a0b0d) so the flattened icon has no transparency.
ctx.setFillColor(NSColor(srgbRed: 0.039, green: 0.043, blue: 0.051, alpha: 1).cgColor)
ctx.fill(CGRect(x: 0, y: 0, width: dim, height: dim))

let nsCtx = NSGraphicsContext(cgContext: ctx, flipped: false)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = nsCtx

if let logoPath, let logo = NSImage(contentsOfFile: logoPath) {
	// Full-bleed: the AO icon already fills its frame; drawing it edge-to-edge
	// keeps the artwork centered under the watch's circular mask.
	logo.draw(in: NSRect(x: 0, y: 0, width: dim, height: dim),
	          from: .zero, operation: .sourceOver, fraction: 1.0)
} else {
	let para = NSMutableParagraphStyle()
	para.alignment = .center
	let attrs: [NSAttributedString.Key: Any] = [
		.font: NSFont.systemFont(ofSize: 440, weight: .bold),
		.foregroundColor: NSColor.white,
		.paragraphStyle: para,
	]
	let text = NSAttributedString(string: "AO", attributes: attrs)
	let ts = text.size()
	text.draw(in: NSRect(x: 0, y: (dim - ts.height) / 2, width: dim, height: ts.height))
}

NSGraphicsContext.restoreGraphicsState()

guard let cgImage = ctx.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: cgImage)
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath) (\(size)x\(size), opaque)\(logoPath.map { ", from \($0)" } ?? "")")
