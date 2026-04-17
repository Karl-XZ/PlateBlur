import Foundation
import UniformTypeIdentifiers
import UIKit

enum SupportedPlateRegion: String, CaseIterable, Identifiable, Hashable {
    case germany
    case netherlands
    case switzerland

    var id: Self { self }

    func title(in language: AppLanguage) -> String {
        switch (self, language) {
        case (.germany, .simplifiedChinese):
            return "德国"
        case (.netherlands, .simplifiedChinese):
            return "荷兰"
        case (.switzerland, .simplifiedChinese):
            return "瑞士"
        case (.germany, .english):
            return "Germany"
        case (.netherlands, .english):
            return "Netherlands"
        case (.switzerland, .english):
            return "Switzerland"
        }
    }

    var shortTitle: String {
        switch self {
        case .germany:
            return "DE"
        case .netherlands:
            return "NL"
        case .switzerland:
            return "CH"
        }
    }
}

enum ExportFormat: String, CaseIterable, Identifiable {
    case jpeg
    case png

    var id: Self { self }

    func title(in _: AppLanguage) -> String {
        rawValue.uppercased()
    }

    var fileExtension: String {
        switch self {
        case .jpeg:
            return "jpg"
        case .png:
            return "png"
        }
    }

    var uniformTypeIdentifier: String {
        switch self {
        case .jpeg:
            return UTType.jpeg.identifier
        case .png:
            return UTType.png.identifier
        }
    }
}

enum SaveBehavior: String, CaseIterable, Identifiable {
    case saveAsNew
    case overwriteOriginalWhenPossible

    var id: Self { self }

    func title(in language: AppLanguage) -> String {
        switch (self, language) {
        case (.saveAsNew, .simplifiedChinese):
            return AppText.text(.saveAsNew, language: language)
        case (.overwriteOriginalWhenPossible, .simplifiedChinese):
            return AppText.text(.overwriteOriginal, language: language)
        case (.saveAsNew, .english):
            return AppText.text(.saveAsNew, language: language)
        case (.overwriteOriginalWhenPossible, .english):
            return AppText.text(.overwriteOriginal, language: language)
        }
    }
}

enum BatchProcessingState: String {
    case imported
    case detecting
    case processed
    case saving
    case saved
    case failed
    case shared

    func title(in language: AppLanguage) -> String {
        switch (self, language) {
        case (.imported, .simplifiedChinese):
            return "已导入"
        case (.detecting, .simplifiedChinese):
            return "检测中"
        case (.processed, .simplifiedChinese):
            return "可导出"
        case (.saving, .simplifiedChinese):
            return "保存中"
        case (.saved, .simplifiedChinese):
            return "已保存"
        case (.failed, .simplifiedChinese):
            return "待复查"
        case (.shared, .simplifiedChinese):
            return "已分享"
        case (.imported, .english):
            return "Imported"
        case (.detecting, .english):
            return "Detecting"
        case (.processed, .english):
            return "Ready"
        case (.saving, .english):
            return "Saving"
        case (.saved, .english):
            return "Saved"
        case (.failed, .english):
            return "Needs Review"
        case (.shared, .english):
            return "Shared"
        }
    }
}

struct ImportedImagePayload {
    let image: UIImage
    let suggestedName: String
    let sourceAssetIdentifier: String?
}

struct SharePayload: Identifiable {
    let id = UUID()
    let urls: [URL]
    let title: String
}

enum HistoryRecordPhase: String, Codable, CaseIterable {
    case detected
    case saved
    case shared
    case failed

    func title(in language: AppLanguage) -> String {
        switch (self, language) {
        case (.detected, .simplifiedChinese):
            return "已识别"
        case (.saved, .simplifiedChinese):
            return "已保存"
        case (.shared, .simplifiedChinese):
            return "已分享"
        case (.failed, .simplifiedChinese):
            return "需复查"
        case (.detected, .english):
            return "Detected"
        case (.saved, .english):
            return "Saved"
        case (.shared, .english):
            return "Shared"
        case (.failed, .english):
            return "Needs Review"
        }
    }
}

struct HistoryRecord: Identifiable, Codable, Hashable {
    let id: UUID
    let itemName: String
    let timestamp: Date
    let phase: HistoryRecordPhase
    let detectionCount: Int
    let detectorName: String?
    let thumbnailFileName: String
}

struct BatchProcessingItem: Identifiable {
    let id: UUID
    var name: String
    let importedAt: Date
    var sourceImage: UIImage
    var sourceAssetIdentifier: String?
    var detections: [PlateDetection]
    var redactedImage: UIImage?
    var state: BatchProcessingState
    var statusMessage: String
    var primaryDetector: PlateDetectionSource?

    init(
        id: UUID = UUID(),
        name: String,
        importedAt: Date = Date(),
        sourceImage: UIImage,
        sourceAssetIdentifier: String?,
        detections: [PlateDetection] = [],
        redactedImage: UIImage? = nil,
        state: BatchProcessingState = .imported,
        statusMessage: String = AppText.text(.importedAndReady),
        primaryDetector: PlateDetectionSource? = nil
    ) {
        self.id = id
        self.name = name
        self.importedAt = importedAt
        self.sourceImage = sourceImage
        self.sourceAssetIdentifier = sourceAssetIdentifier
        self.detections = detections
        self.redactedImage = redactedImage
        self.state = state
        self.statusMessage = statusMessage
        self.primaryDetector = primaryDetector
    }

    var canOverwriteOriginal: Bool {
        sourceAssetIdentifier != nil
    }

    var hasDetections: Bool {
        !detections.isEmpty
    }

    var isReadyForExport: Bool {
        hasDetections
    }

    var displayImage: UIImage {
        redactedImage ?? sourceImage
    }

    var exportBaseName: String {
        let sanitized = name
            .replacingOccurrences(of: "[^A-Za-z0-9_-]+", with: "_", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        return sanitized.isEmpty ? "PlateBlur-\(id.uuidString.prefix(8))" : sanitized
    }
}
