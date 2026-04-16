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
    private static let modelInputSize = CGSize(width: 640, height: 640)
    private static let directIoUThreshold = 0.45
    private static let tileOverlap: CGFloat = 0.40
    private let modelResourceName: String
    private let fullFrameConfidenceThreshold: Double
    private let tileConfidenceThreshold: Double

    init(
        modelResourceName: String = "LicensePlateDetector",
        fullFrameConfidenceThreshold: Double = 0.20,
        tileConfidenceThreshold: Double = 0.20
    ) {
        self.modelResourceName = modelResourceName
        self.fullFrameConfidenceThreshold = fullFrameConfidenceThreshold
        self.tileConfidenceThreshold = tileConfidenceThreshold
    }

    private lazy var modelURL: URL? = {
        Bundle.main.url(forResource: modelResourceName, withExtension: "mlmodelc")
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

        let preparedImage = try image.preparedForProcessing()
        let fullImageSize = preparedImage.pixelSize

        var mergedDetections = try await directDetections(
            using: mlModel,
            image: preparedImage,
            fullImageSize: fullImageSize,
            tileOrigin: .zero,
            confidenceThreshold: fullFrameConfidenceThreshold
        )

        let tileWindows = Self.makeTileWindows(for: fullImageSize)
        if tileWindows.count > 1 {
            for tileWindow in tileWindows {
                let tileImage = try preparedImage.cropped(to: tileWindow)
                let tileDetections = try await directDetections(
                    using: mlModel,
                    image: tileImage,
                    fullImageSize: fullImageSize,
                    tileOrigin: tileWindow.origin,
                    confidenceThreshold: tileConfidenceThreshold
                )
                mergedDetections.append(contentsOf: tileDetections)
            }
        }

        return deduplicate(mergedDetections)
    }

    private func directDetections(
        using mlModel: MLModel,
        image: UIImage,
        fullImageSize: CGSize,
        tileOrigin: CGPoint,
        confidenceThreshold: Double
    ) async throws -> [PlateDetection] {
        let tileSize = image.pixelSize
        let pixelBuffer = try image.pixelBuffer(targetSize: Self.modelInputSize)
        let provider = try MLDictionaryFeatureProvider(dictionary: [
            Self.directImageInputName: MLFeatureValue(pixelBuffer: pixelBuffer),
            Self.directConfidenceInputName: MLFeatureValue(double: confidenceThreshold),
            Self.directIoUInputName: MLFeatureValue(double: Self.directIoUThreshold),
        ])
        let prediction = try await mlModel.prediction(from: provider)
        let localDetections = try Self.decodeDirectPrediction(
            prediction,
            minimumConfidence: Float(confidenceThreshold)
        )

        return localDetections.compactMap { detection in
            let rect = detection.normalizedRect
            let globalRect = CGRect(
                x: (tileOrigin.x + rect.origin.x * tileSize.width) / max(fullImageSize.width, 1),
                y: (tileOrigin.y + rect.origin.y * tileSize.height) / max(fullImageSize.height, 1),
                width: rect.size.width * tileSize.width / max(fullImageSize.width, 1),
                height: rect.size.height * tileSize.height / max(fullImageSize.height, 1)
            ).clampedToUnit()

            guard globalRect.isMeaningfulUnitRect else {
                return nil
            }

            return PlateDetection(
                id: detection.id,
                normalizedRect: globalRect,
                confidence: detection.confidence,
                source: .coreML
            )
        }
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

    private static func decodeDirectPrediction(
        _ prediction: MLFeatureProvider,
        minimumConfidence: Float
    ) throws -> [PlateDetection] {
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

            guard bestScore >= minimumConfidence else { continue }

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

    private static func makeTileWindows(for imageSize: CGSize) -> [CGRect] {
        let tileSide = adaptiveTileSide(for: imageSize)
        let width = Int(round(imageSize.width))
        let height = Int(round(imageSize.height))
        let tileLength = Int(round(tileSide))

        let xPositions = slidingPositions(length: width, window: tileLength, overlap: tileOverlap)
        let yPositions = slidingPositions(length: height, window: tileLength, overlap: tileOverlap)

        return yPositions.flatMap { y in
            xPositions.map { x in
                CGRect(
                    x: x,
                    y: y,
                    width: min(tileLength, width - x),
                    height: min(tileLength, height - y)
                )
            }
        }
    }

    private static func adaptiveTileSide(for imageSize: CGSize) -> CGFloat {
        let longestEdge = max(imageSize.width, imageSize.height)
        if longestEdge <= 1600 {
            return 640
        }
        if longestEdge <= 2800 {
            return 960
        }
        return 1280
    }

    private static func slidingPositions(length: Int, window: Int, overlap: CGFloat) -> [Int] {
        guard length > window else { return [0] }

        let step = max(1, Int(round(CGFloat(window) * (1 - overlap))))
        var positions = Array(Swift.stride(from: 0, through: max(length - window, 0), by: step))
        let tail = length - window
        if positions.last != tail {
            positions.append(tail)
        }
        return positions
    }
}
