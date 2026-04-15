@preconcurrency
import CoreML
import UIKit
@preconcurrency
import Vision

protocol PlateDetecting {
    func detectPlates(in image: UIImage) async throws -> [PlateDetection]
}

enum CoreMLPlateDetectorError: LocalizedError {
    case modelUnavailable
    case unsupportedModelOutput
    case predictionFailed
    case malformedOutput

    var errorDescription: String? {
        switch self {
        case .modelUnavailable:
            return AppText.text(.noBundledModel)
        case .unsupportedModelOutput:
            return AppText.text(.coreMLUnsupported)
        case .predictionFailed:
            return AppText.text(.coreMLPredictionFailed)
        case .malformedOutput:
            return AppText.text(.coreMLMalformedOutput)
        }
    }
}

final class CoreMLPlateDetector: PlateDetecting {
    private static let likelyPlateTokens = ["plate", "licence", "license", "lp"]
    private static let directImageInputName = "image"
    private static let directConfidenceInputName = "confidenceThreshold"
    private static let directIoUInputName = "iouThreshold"

    private lazy var modelURL: URL? = {
        Bundle.main.url(forResource: "LicensePlateDetector", withExtension: "mlmodelc")
    }()

    private lazy var mlModel: MLModel? = {
        guard let modelURL else {
            return nil
        }
        return try? MLModel(contentsOf: modelURL)
    }()

    private lazy var visionModel: VNCoreMLModel? = {
        guard let model = mlModel else { return nil }
        return try? VNCoreMLModel(for: model)
    }()

    private lazy var usesDirectUltralyticsPipeline: Bool = {
        guard let mlModel else { return false }
        let inputs = mlModel.modelDescription.inputDescriptionsByName
        let outputs = mlModel.modelDescription.outputDescriptionsByName
        return inputs[Self.directImageInputName] != nil &&
            inputs[Self.directConfidenceInputName] != nil &&
            inputs[Self.directIoUInputName] != nil &&
            outputs["confidence"] != nil &&
            outputs["coordinates"] != nil
    }()

    var isAvailable: Bool {
        mlModel != nil
    }

    func detectPlates(in image: UIImage) async throws -> [PlateDetection] {
        guard mlModel != nil else {
            throw CoreMLPlateDetectorError.modelUnavailable
        }

        if usesDirectUltralyticsPipeline {
            return try await detectViaDirectModel(in: image)
        }

        guard let visionModel else {
            throw CoreMLPlateDetectorError.unsupportedModelOutput
        }

        let cgImage = try image.normalizedCGImage()

        return try await withCheckedThrowingContinuation { continuation in
            let request = VNCoreMLRequest(model: visionModel) { request, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                guard let observations = request.results as? [VNRecognizedObjectObservation] else {
                    continuation.resume(throwing: CoreMLPlateDetectorError.unsupportedModelOutput)
                    return
                }

                let detections = observations.compactMap(Self.makeDetection(from:))
                continuation.resume(returning: deduplicate(detections))
            }

            request.imageCropAndScaleOption = .scaleFill

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

    private func detectViaDirectModel(in image: UIImage) async throws -> [PlateDetection] {
        guard let mlModel else {
            throw CoreMLPlateDetectorError.modelUnavailable
        }

        let inputSize = CGSize(width: 640, height: 640)
        let pixelBuffer = try image.pixelBuffer(targetSize: inputSize)
        let provider = try MLDictionaryFeatureProvider(dictionary: [
            Self.directImageInputName: MLFeatureValue(pixelBuffer: pixelBuffer),
            Self.directConfidenceInputName: MLFeatureValue(double: 0.25),
            Self.directIoUInputName: MLFeatureValue(double: 0.45),
        ])
        let prediction = try await mlModel.prediction(from: provider)
        return deduplicate(try Self.decodeDirectPrediction(prediction))
    }

    private static func makeDetection(from observation: VNRecognizedObjectObservation) -> PlateDetection? {
        let topLabel = observation.labels.first
        let identifier = topLabel?.identifier.lowercased() ?? "plate"
        let shouldKeep = likelyPlateTokens.contains { identifier.contains($0) } || observation.labels.count <= 1

        guard shouldKeep else {
            return nil
        }

        let boundingBox = observation.boundingBox
        let normalizedRect = CGRect(
            x: boundingBox.origin.x,
            y: 1 - boundingBox.origin.y - boundingBox.size.height,
            width: boundingBox.size.width,
            height: boundingBox.size.height
        )

        return PlateDetection(
            normalizedRect: normalizedRect,
            confidence: topLabel?.confidence ?? observation.confidence,
            source: .coreML
        )
    }

    private static func decodeDirectPrediction(_ prediction: MLFeatureProvider) throws -> [PlateDetection] {
        guard let coordinatesValue = prediction.featureValue(for: "coordinates")?.multiArrayValue,
              let confidenceValue = prediction.featureValue(for: "confidence")?.multiArrayValue else {
            throw CoreMLPlateDetectorError.malformedOutput
        }

        let coordinateCount = coordinatesValue.count
        guard coordinateCount.isMultiple(of: 4) else {
            throw CoreMLPlateDetectorError.malformedOutput
        }

        let detectionCount = coordinateCount / 4
        if detectionCount == 0 {
            return []
        }

        let classCount = max(confidenceValue.count / detectionCount, 1)
        var detections: [PlateDetection] = []
        detections.reserveCapacity(detectionCount)

        for detectionIndex in 0 ..< detectionCount {
            let centerX = confidenceSafeFloat(from: coordinatesValue, index: detectionIndex * 4)
            let centerY = confidenceSafeFloat(from: coordinatesValue, index: detectionIndex * 4 + 1)
            let width = confidenceSafeFloat(from: coordinatesValue, index: detectionIndex * 4 + 2)
            let height = confidenceSafeFloat(from: coordinatesValue, index: detectionIndex * 4 + 3)

            guard width > 0, height > 0 else { continue }

            var bestScore: Float = 0
            for classIndex in 0 ..< classCount {
                let score = confidenceSafeFloat(from: confidenceValue, index: detectionIndex * classCount + classIndex)
                bestScore = max(bestScore, score)
            }

            guard bestScore >= 0.25 else { continue }

            let rect = CGRect(
                x: CGFloat(centerX - width / 2),
                y: CGFloat(centerY - height / 2),
                width: CGFloat(width),
                height: CGFloat(height)
            ).clampedToUnit()

            guard rect.isMeaningfulUnitRect else { continue }

            detections.append(
                PlateDetection(
                    normalizedRect: rect,
                    confidence: bestScore,
                    source: .coreML
                )
            )
        }

        return detections
    }

    private static func confidenceSafeFloat(from array: MLMultiArray, index: Int) -> Float {
        guard index < array.count else { return 0 }
        return array[index].floatValue
    }
}
