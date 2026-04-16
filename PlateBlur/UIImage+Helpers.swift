import CoreGraphics
import CoreVideo
import ImageIO
import UIKit

enum ImagePreparationError: LocalizedError {
    case invalidImageData

    var errorDescription: String? {
        switch self {
        case .invalidImageData:
            return AppText.text(.imageInvalidData)
        }
    }
}

extension UIImage {
    var pixelSize: CGSize {
        if let cgImage {
            return CGSize(width: cgImage.width, height: cgImage.height)
        }
        return size
    }

    func preparedForProcessing() throws -> UIImage {
        if imageOrientation == .up, let cgImage {
            return UIImage(cgImage: cgImage, scale: scale, orientation: .up)
        }

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let normalized = renderer.image { _ in
            draw(in: CGRect(origin: .zero, size: size))
        }

        guard normalized.cgImage != nil else {
            throw ImagePreparationError.invalidImageData
        }

        return normalized
    }

    func normalizedCGImage() throws -> CGImage {
        let normalized = try preparedForProcessing()
        guard let cgImage = normalized.cgImage else {
            throw ImagePreparationError.invalidImageData
        }
        return cgImage
    }

    func resized(to targetSize: CGSize) throws -> UIImage {
        let normalized = try preparedForProcessing()
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
        let resized = renderer.image { _ in
            normalized.draw(in: CGRect(origin: .zero, size: targetSize))
        }
        guard resized.cgImage != nil else {
            throw ImagePreparationError.invalidImageData
        }
        return resized
    }

    func cropped(to cropRect: CGRect) throws -> UIImage {
        let normalized = try preparedForProcessing()
        guard let cgImage = normalized.cgImage else {
            throw ImagePreparationError.invalidImageData
        }

        let scaleX = CGFloat(cgImage.width) / max(normalized.size.width, 1)
        let scaleY = CGFloat(cgImage.height) / max(normalized.size.height, 1)
        let pixelRect = CGRect(
            x: cropRect.origin.x * scaleX,
            y: cropRect.origin.y * scaleY,
            width: cropRect.size.width * scaleX,
            height: cropRect.size.height * scaleY
        ).integral.intersection(CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))

        guard pixelRect.width > 2,
              pixelRect.height > 2,
              let croppedImage = cgImage.cropping(to: pixelRect) else {
            throw ImagePreparationError.invalidImageData
        }

        return UIImage(cgImage: croppedImage, scale: 1, orientation: .up)
    }

    func pixelBuffer(targetSize: CGSize) throws -> CVPixelBuffer {
        let resizedImage = try resized(to: targetSize)
        guard let cgImage = resizedImage.cgImage else {
            throw ImagePreparationError.invalidImageData
        }

        let attributes: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ]
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            Int(targetSize.width),
            Int(targetSize.height),
            kCVPixelFormatType_32ARGB,
            attributes as CFDictionary,
            &pixelBuffer
        )

        guard status == kCVReturnSuccess, let pixelBuffer else {
            throw ImagePreparationError.invalidImageData
        }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(pixelBuffer),
            width: Int(targetSize.width),
            height: Int(targetSize.height),
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
        ) else {
            throw ImagePreparationError.invalidImageData
        }

        context.draw(cgImage, in: CGRect(origin: .zero, size: targetSize))
        return pixelBuffer
    }
}
