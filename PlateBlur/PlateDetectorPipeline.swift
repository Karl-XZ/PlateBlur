import UIKit

actor PlateDetectorPipeline {
    private let coreMLDetector = CoreMLPlateDetector()
    private let textDetector = TextPlateDetector()
    private let rectangleDetector = RectangleCandidateDetector()

    func detect(in image: UIImage, regions: Set<SupportedPlateRegion>) async -> DetectionRunReport {
        var messages: [String] = []
        var mergedDetections: [PlateDetection] = []

        if coreMLDetector.isAvailable {
            do {
                let coreMLDetections = try await coreMLDetector.detectPlates(in: image)
                if !coreMLDetections.isEmpty {
                    mergedDetections.append(contentsOf: coreMLDetections)
                    messages.append(AppText.text(.coreMLFound, coreMLDetections.count))
                }
            } catch {
                messages.append(AppText.text(.coreMLFailed, error.localizedDescription))
            }
        } else {
            messages.append(AppText.text(.noBundledModel))
        }

        do {
            let textDetections = try await textDetector.detectPlates(in: image, regions: regions)
            if !textDetections.isEmpty {
                mergedDetections = deduplicate(mergedDetections + textDetections)
                messages.append(
                    AppText.text(
                        .ocrFound,
                        regions.map(\.shortTitle).sorted().joined(separator: "/"),
                        textDetections.count
                    )
                )
            } else {
                messages.append(AppText.text(.ocrNone))
            }
        } catch {
            messages.append(AppText.text(.ocrFailed, error.localizedDescription))
        }

        if !mergedDetections.isEmpty {
            let primarySource: PlateDetectionSource = mergedDetections.contains(where: { $0.source == .coreML }) ? .coreML : .ocrPattern
            return DetectionRunReport(
                detections: mergedDetections,
                message: messages.joined(separator: " "),
                primaryDetector: primarySource
            )
        }

        do {
            let fallbackDetections = try await rectangleDetector.detectPlates(in: image)
            if !fallbackDetections.isEmpty {
                messages.append(AppText.text(.rectangleFallbackUsed))
                return DetectionRunReport(
                    detections: fallbackDetections,
                    message: messages.joined(separator: " "),
                    primaryDetector: .rectangleFallback
                )
            }

            messages.append(AppText.text(.rectangleFallbackNone))
        } catch {
            messages.append(AppText.text(.rectangleFallbackFailed, error.localizedDescription))
        }

        return DetectionRunReport(
            detections: [],
            message: messages.joined(separator: " "),
            primaryDetector: nil
        )
    }
}
