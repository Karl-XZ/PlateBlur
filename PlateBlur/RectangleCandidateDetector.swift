import UIKit
@preconcurrency
import Vision

final class RectangleCandidateDetector: PlateDetecting {
    func detectPlates(in image: UIImage) async throws -> [PlateDetection] {
        let cgImage = try image.normalizedCGImage()

        return try await withCheckedThrowingContinuation { continuation in
            let request = VNDetectRectanglesRequest { request, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                let observations = (request.results as? [VNRectangleObservation]) ?? []
                let detections = observations.compactMap(Self.makeDetection(from:))
                continuation.resume(returning: deduplicate(detections))
            }

            request.maximumObservations = 12
            request.minimumSize = 0.03
            request.minimumAspectRatio = 0.2
            request.maximumAspectRatio = 1.0
            request.minimumConfidence = 0.45
            request.quadratureTolerance = 18

            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
                    try handler.perform([request])
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func makeDetection(from observation: VNRectangleObservation) -> PlateDetection? {
        let box = observation.boundingBox
        let width = box.width
        let height = box.height
        let aspectRatio = width / max(height, 0.0001)
        let centerYTopLeft = 1 - box.midY

        guard width > 0.08,
              height > 0.02,
              aspectRatio >= 1.8,
              aspectRatio <= 6.5,
              centerYTopLeft > 0.12,
              centerYTopLeft < 0.95 else {
            return nil
        }

        let normalizedRect = CGRect(
            x: box.origin.x,
            y: 1 - box.origin.y - box.height,
            width: width,
            height: height
        )

        return PlateDetection(
            normalizedRect: normalizedRect,
            confidence: observation.confidence,
            source: .rectangleFallback
        )
    }
}

func deduplicate(_ detections: [PlateDetection]) -> [PlateDetection] {
    let sorted = detections.sorted {
        if $0.confidence == $1.confidence {
            return $0.normalizedRect.area > $1.normalizedRect.area
        }
        return $0.confidence > $1.confidence
    }

    var accepted: [PlateDetection] = []

    for detection in sorted {
        let overlapsExisting = accepted.contains { existing in
            detection.normalizedRect.intersection(existing.normalizedRect).area / max(existing.normalizedRect.union(detection.normalizedRect).area, 0.0001) > 0.45
        }

        if !overlapsExisting {
            accepted.append(detection)
        }
    }

    return accepted.prefix(6).map { $0 }
}
