import CoreGraphics
import Foundation

struct PlateDetection: Identifiable, Equatable {
    let id: UUID
    var normalizedRect: CGRect
    var confidence: Float
    var source: PlateDetectionSource

    init(
        id: UUID = UUID(),
        normalizedRect: CGRect,
        confidence: Float,
        source: PlateDetectionSource
    ) {
        self.id = id
        self.normalizedRect = normalizedRect.clampedToUnit()
        self.confidence = confidence
        self.source = source
    }
}

enum PlateDetectionSource: String, CaseIterable {
    case coreML = "Core ML"
    case ocrPattern = "OCR Pattern"
    case rectangleFallback = "Rectangle Fallback"
    case manual = "Manual"

    func title(in language: AppLanguage) -> String {
        switch (self, language) {
        case (.coreML, .simplifiedChinese):
            return "Core ML"
        case (.ocrPattern, .simplifiedChinese):
            return "OCR"
        case (.rectangleFallback, .simplifiedChinese):
            return "矩形兜底"
        case (.manual, .simplifiedChinese):
            return "手动"
        case (.coreML, .english):
            return "Core ML"
        case (.ocrPattern, .english):
            return "OCR"
        case (.rectangleFallback, .english):
            return "Rectangle Fallback"
        case (.manual, .english):
            return "Manual"
        }
    }
}

enum PlateRedactionStyle: String, CaseIterable, Identifiable {
    case solidBlock
    case mosaic
    case gaussianBlur

    var id: Self { self }

    func title(in language: AppLanguage) -> String {
        switch (self, language) {
        case (.solidBlock, .simplifiedChinese):
            return "纯色"
        case (.mosaic, .simplifiedChinese):
            return "马赛克"
        case (.gaussianBlur, .simplifiedChinese):
            return "模糊"
        case (.solidBlock, .english):
            return "Solid"
        case (.mosaic, .english):
            return "Mosaic"
        case (.gaussianBlur, .english):
            return "Blur"
        }
    }
}

enum PreviewMode: String, CaseIterable, Identifiable {
    case original
    case redacted

    var id: Self { self }

    func title(in language: AppLanguage) -> String {
        switch (self, language) {
        case (.original, .simplifiedChinese):
            return AppText.text(.previewOriginal, language: language)
        case (.redacted, .simplifiedChinese):
            return AppText.text(.previewRedacted, language: language)
        case (.original, .english):
            return AppText.text(.previewOriginal, language: language)
        case (.redacted, .english):
            return AppText.text(.previewRedacted, language: language)
        }
    }
}

struct DetectionRunReport {
    let detections: [PlateDetection]
    let message: String
    let primaryDetector: PlateDetectionSource?
}

extension CGRect {
    func clampedToUnit() -> CGRect {
        let minX = Swift.max(0, Swift.min(origin.x, 1))
        let minY = Swift.max(0, Swift.min(origin.y, 1))
        let maxWidth = Swift.max(0, 1 - minX)
        let maxHeight = Swift.max(0, 1 - minY)
        let width = Swift.max(0.02, Swift.min(size.width, maxWidth))
        let height = Swift.max(0.02, Swift.min(size.height, maxHeight))
        return CGRect(x: minX, y: minY, width: width, height: height)
    }

    var area: CGFloat {
        width * height
    }

    var isMeaningfulUnitRect: Bool {
        width > 0.01 && height > 0.01
    }
}
