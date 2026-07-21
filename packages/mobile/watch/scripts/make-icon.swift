// Generates the 1024×1024 watch app icon. Renders into a fixed-size, alpha-free
// bitmap context because Apple rejects watch icons that are the wrong size or
// carry an alpha channel.
// Usage: swift make-icon.swift <output.png>
import AppKit

let size = 1024
let outPath = CommandLine.arguments.count > 1
	? CommandLine.arguments[1]
	: "icon-1024.png"

let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
	data: nil,
	width: size,
	height: size,
	bitsPerComponent: 8,
	bytesPerRow: 0,
	space: colorSpace,
	// noneSkipLast → opaque, no alpha channel in the output.
	bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
) else { exit(1) }

let dim = CGFloat(size)

// Dark-to-blue diagonal gradient (AO dark bg + refined-blue accent).
let colors = [
	NSColor(srgbRed: 0.04, green: 0.043, blue: 0.051, alpha: 1).cgColor,
	NSColor(srgbRed: 0.298, green: 0.553, blue: 1.0, alpha: 1).cgColor,
] as CFArray
if let grad = CGGradient(colorsSpace: colorSpace, colors: colors, locations: [0, 1]) {
	ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: dim), end: CGPoint(x: dim, y: 0), options: [])
}

// Draw the "AO" wordmark via AppKit text into the same context.
let nsCtx = NSGraphicsContext(cgContext: ctx, flipped: false)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = nsCtx
let para = NSMutableParagraphStyle()
para.alignment = .center
let attrs: [NSAttributedString.Key: Any] = [
	.font: NSFont.systemFont(ofSize: 440, weight: .bold),
	.foregroundColor: NSColor.white,
	.paragraphStyle: para,
]
let text = NSAttributedString(string: "AO", attributes: attrs)
let textSize = text.size()
text.draw(in: NSRect(x: 0, y: (dim - textSize.height) / 2, width: dim, height: textSize.height))
NSGraphicsContext.restoreGraphicsState()

guard let cgImage = ctx.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: cgImage)
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath) (\(size)x\(size), opaque)")
