import Foundation
import UIKit
@preconcurrency
import Vision

final class TextPlateDetector {
    func detectPlates(in image: UIImage, regions: Set<SupportedPlateRegion>) async throws -> [PlateDetection] {
        guard !regions.isEmpty else { return [] }

        let cgImage = try image.normalizedCGImage()

        return try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
                let detections = observations.compactMap { observation -> PlateDetection? in
                    guard let candidate = Self.bestMatchingCandidate(from: observation, regions: regions) else {
                        return nil
                    }

                    let normalizedRect = CGRect(
                        x: observation.boundingBox.origin.x,
                        y: 1 - observation.boundingBox.origin.y - observation.boundingBox.height,
                        width: observation.boundingBox.width,
                        height: observation.boundingBox.height
                    )

                    guard normalizedRect.width > 0.08,
                          normalizedRect.height > 0.02,
                          normalizedRect.width / max(normalizedRect.height, 0.001) > 1.8 else {
                        return nil
                    }

                    return PlateDetection(
                        normalizedRect: normalizedRect,
                        confidence: candidate.confidence,
                        source: .ocrPattern
                    )
                }

                continuation.resume(returning: deduplicate(detections))
            }

            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            request.minimumTextHeight = 0.02
            request.recognitionLanguages = ["de-DE", "nl-NL", "fr-FR", "en-US"]

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

    private static func bestMatchingCandidate(
        from observation: VNRecognizedTextObservation,
        regions: Set<SupportedPlateRegion>
    ) -> VNRecognizedText? {
        for candidate in observation.topCandidates(3) {
            if matchesPlatePattern(candidate.string, regions: regions) {
                return candidate
            }
        }

        return nil
    }

    private static func matchesPlatePattern(_ input: String, regions: Set<SupportedPlateRegion>) -> Bool {
        let uppercase = input
            .uppercased()
            .replacingOccurrences(of: "—", with: "-")
            .replacingOccurrences(of: "–", with: "-")
            .replacingOccurrences(of: "·", with: "-")
            .replacingOccurrences(of: "_", with: "-")
            .replacingOccurrences(of: " ", with: "")

        guard uppercase.count >= 4 else {
            return false
        }

        return regions.contains { region in
            switch region {
            case .germany:
                return matches(regex: #"^[A-ZÄÖÜ]{1,3}-?[A-Z]{1,2}\d{1,4}[HE]?$"#, value: uppercase)
            case .netherlands:
                return matches(regex: #"^(?:[A-Z]{2}\d{2}[A-Z]{2}|\d{2}[A-Z]{2}[A-Z]{2}|[A-Z]{2}[A-Z]{2}\d{2}|\d{2}\d{2}[A-Z]{2}|[A-Z]{2}\d{2}\d{2}|\d{2}[A-Z]{2}\d{2}|[A-Z]{1,3}\d{1,3}[A-Z]{1,2})$"#, value: uppercase)
            case .switzerland:
                return matches(regex: #"^[A-Z]{1,2}\d{1,6}$"#, value: uppercase)
            }
        }
    }

    private static func matches(regex pattern: String, value: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
}
