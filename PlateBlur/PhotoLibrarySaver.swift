import Photos
import UIKit

enum PhotoLibrarySaverError: LocalizedError {
    case permissionDenied
    case assetUnavailable
    case contentEditingInputUnavailable

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return AppText.text(.libraryPermissionDenied)
        case .assetUnavailable:
            return AppText.text(.libraryAssetUnavailable)
        case .contentEditingInputUnavailable:
            return AppText.text(.libraryInputUnavailable)
        }
    }
}

enum PhotoLibrarySaver {
    static func saveNew(imageData: Data, uniformTypeIdentifier: String) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw PhotoLibrarySaverError.permissionDenied
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges({
                let request = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.uniformTypeIdentifier = uniformTypeIdentifier
                request.addResource(with: .photo, data: imageData, options: options)
            }) { success, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if success {
                    continuation.resume(returning: ())
                } else {
                    continuation.resume(throwing: PhotoLibrarySaverError.permissionDenied)
                }
            }
        }
    }

    static func overwrite(
        assetIdentifier: String,
        imageData: Data
    ) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else {
            throw PhotoLibrarySaverError.permissionDenied
        }

        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetIdentifier], options: nil).firstObject else {
            throw PhotoLibrarySaverError.assetUnavailable
        }

        let input = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<PHContentEditingInput, Error>) in
            let options = PHContentEditingInputRequestOptions()
            options.isNetworkAccessAllowed = true
            asset.requestContentEditingInput(with: options) { input, _ in
                if let input {
                    continuation.resume(returning: input)
                } else {
                    continuation.resume(throwing: PhotoLibrarySaverError.contentEditingInputUnavailable)
                }
            }
        }

        let output = PHContentEditingOutput(contentEditingInput: input)
        try imageData.write(to: output.renderedContentURL, options: .atomic)
        output.adjustmentData = PHAdjustmentData(
            formatIdentifier: "com.example.PlateBlur",
            formatVersion: "1.0",
            data: Data("PlateBlur overwrite".utf8)
        )

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges({
                let request = PHAssetChangeRequest(for: asset)
                request.contentEditingOutput = output
            }) { success, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if success {
                    continuation.resume(returning: ())
                } else {
                    continuation.resume(throwing: PhotoLibrarySaverError.assetUnavailable)
                }
            }
        }
    }
}
