import Foundation
import UIKit

enum ExportServiceError: LocalizedError {
    case missingImage
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .missingImage:
            return AppText.text(.exportMissingImage)
        case .encodingFailed:
            return AppText.text(.exportEncodingFailed)
        }
    }
}

struct ExportService {
    func imageData(for image: UIImage, format: ExportFormat, quality: Double) throws -> Data {
        switch format {
        case .jpeg:
            guard let data = image.jpegData(compressionQuality: quality) else {
                throw ExportServiceError.encodingFailed
            }
            return data
        case .png:
            guard let data = image.pngData() else {
                throw ExportServiceError.encodingFailed
            }
            return data
        }
    }

    func buildSharePayload(
        for items: [BatchProcessingItem],
        format: ExportFormat,
        quality: Double,
        includeOriginal: Bool
    ) throws -> SharePayload {
        let tempRoot = FileManager.default.temporaryDirectory.appendingPathComponent("PlateBlurExports", isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)

        var urls: [URL] = []

        for item in items {
            let redacted = item.redactedImage ?? item.sourceImage
            let redactedData = try imageData(for: redacted, format: format, quality: quality)
            let redactedURL = tempRoot.appendingPathComponent("\(item.exportBaseName)-redacted.\(format.fileExtension)")
            try redactedData.write(to: redactedURL, options: .atomic)
            urls.append(redactedURL)

            if includeOriginal {
                let originalData = try imageData(for: item.sourceImage, format: format, quality: quality)
                let originalURL = tempRoot.appendingPathComponent("\(item.exportBaseName)-original.\(format.fileExtension)")
                try originalData.write(to: originalURL, options: .atomic)
                urls.append(originalURL)
            }
        }

        let title = items.count == 1 ? items[0].name : AppText.text(.exportTitle)
        return SharePayload(urls: urls, title: title)
    }
}
