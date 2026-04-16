import UIKit

actor PlateDetectorPipeline {
    private let generalCoreMLDetector = CoreMLPlateDetector(
        modelResourceName: "LicensePlateDetector",
        fullFrameConfidenceThreshold: 0.10,
        tileConfidenceThreshold: 0.10
    )
    private let enhancedCoreMLDetector = CoreMLPlateDetector(
        modelResourceName: "LicensePlateDetectorSwiss",
        fullFrameConfidenceThreshold: 0.20,
        tileConfidenceThreshold: 0.20
    )
    private let textDetector = TextPlateDetector()
    private let rectangleDetector = RectangleCandidateDetector()

    func detect(
        in image: UIImage,
        regions: Set<SupportedPlateRegion>,
        enhancedRecognitionEnabled: Bool
    ) async -> DetectionRunReport {
        var messages: [String] = []
        var mergedDetections: [PlateDetection] = []
        var coreMLDetections: [PlateDetection] = []

        let activeCoreMLDetectors: [CoreMLPlateDetector] =
            enhancedRecognitionEnabled
                ? [generalCoreMLDetector, enhancedCoreMLDetector]
                : [generalCoreMLDetector]

        if activeCoreMLDetectors.allSatisfy({ !$0.isAvailable }) {
            messages.append(AppText.text(.noBundledModel))
        }

        for detector in activeCoreMLDetectors where detector.isAvailable {
            do {
                coreMLDetections.append(contentsOf: try await detector.detectPlates(in: image))
            } catch {
                messages.append(AppText.text(.coreMLFailed, error.localizedDescription))
            }
        }

        let deduplicatedCoreMLDetections = deduplicate(coreMLDetections)
        if !deduplicatedCoreMLDetections.isEmpty {
            mergedDetections.append(contentsOf: deduplicatedCoreMLDetections)
            messages.append(AppText.text(.coreMLFound, deduplicatedCoreMLDetections.count))
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
