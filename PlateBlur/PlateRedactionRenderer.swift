import CoreImage
import UIKit

struct PlateRedactionRenderer {
    private let ciContext = CIContext()

    func render(
        image: UIImage,
        detections: [PlateDetection],
        style: PlateRedactionStyle,
        expansion: CGFloat
    ) -> UIImage? {
        guard let cgImage = try? image.normalizedCGImage() else {
            return nil
        }

        let imageBounds = CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height)
        var workingImage = CIImage(cgImage: cgImage)

        for detection in detections {
            let plateRect = imageRect(for: detection.normalizedRect, in: imageBounds, expansion: expansion)
            guard plateRect.width > 1, plateRect.height > 1 else {
                continue
            }

            switch style {
            case .solidBlock:
                let overlay = CIImage(color: .black).cropped(to: plateRect)
                workingImage = overlay.composited(over: workingImage)
            case .mosaic:
                let cropped = workingImage.cropped(to: plateRect)
                let pixelated = cropped
                    .clampedToExtent()
                    .applyingFilter("CIPixellate", parameters: ["inputScale": max(plateRect.width, plateRect.height) / 10])
                    .cropped(to: plateRect)
                workingImage = pixelated.composited(over: workingImage)
            case .gaussianBlur:
                let cropped = workingImage.cropped(to: plateRect)
                let blurred = cropped
                    .clampedToExtent()
                    .applyingFilter("CIGaussianBlur", parameters: ["inputRadius": max(18, plateRect.height / 2)])
                    .cropped(to: plateRect)
                workingImage = blurred.composited(over: workingImage)
            }
        }

        guard let output = ciContext.createCGImage(workingImage, from: imageBounds) else {
            return nil
        }

        return UIImage(cgImage: output)
    }

    private func imageRect(for normalizedRect: CGRect, in imageBounds: CGRect, expansion: CGFloat) -> CGRect {
        var rect = CGRect(
            x: normalizedRect.origin.x * imageBounds.width,
            y: (1 - normalizedRect.origin.y - normalizedRect.height) * imageBounds.height,
            width: normalizedRect.size.width * imageBounds.width,
            height: normalizedRect.size.height * imageBounds.height
        )

        rect = rect.insetBy(
            dx: -(rect.width * expansion),
            dy: -(rect.height * expansion)
        )

        return rect.intersection(imageBounds)
    }
}
