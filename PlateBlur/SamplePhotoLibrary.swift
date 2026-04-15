import UIKit

struct SamplePhoto: Identifiable {
    let filename: String
    let titleChinese: String
    let titleEnglish: String
    let subtitleChinese: String
    let subtitleEnglish: String
    let image: UIImage

    var id: String { filename }

    func title(in language: AppLanguage) -> String {
        switch language {
        case .simplifiedChinese:
            return titleChinese
        case .english:
            return titleEnglish
        }
    }

    func subtitle(in language: AppLanguage) -> String {
        switch language {
        case .simplifiedChinese:
            return subtitleChinese
        case .english:
            return subtitleEnglish
        }
    }

    var payload: ImportedImagePayload {
        ImportedImagePayload(
            image: image,
            suggestedName: filename.replacingOccurrences(of: ".jpg", with: "").replacingOccurrences(of: ".png", with: ""),
            sourceAssetIdentifier: nil
        )
    }
}

enum SamplePhotoLibrary {
    private static let sampleDirectoryName = "SamplePhotos"

    private static let manifest: [(filename: String, zhTitle: String, enTitle: String, zhSubtitle: String, enSubtitle: String)] = [
        ("street-scene-01.jpg", "街景样张 01", "Street Scene 01", "公开测试集 · 全景车流", "Public benchmark · wide street scene"),
        ("street-scene-02.jpg", "街景样张 02", "Street Scene 02", "公开测试集 · 远距离目标", "Public benchmark · distant target"),
        ("street-scene-03.jpg", "街景样张 03", "Street Scene 03", "公开测试集 · 复杂背景", "Public benchmark · cluttered background"),
        ("de-crop-01.jpg", "德国裁切 01", "Germany Crop 01", "德国测试图 · 近距离车牌", "Germany sample · close plate crop"),
        ("de-crop-02.jpg", "德国裁切 02", "Germany Crop 02", "德国测试图 · 角度变化", "Germany sample · angled plate crop"),
        ("nl-crop-01.jpg", "荷兰裁切 01", "Netherlands Crop 01", "荷兰测试图 · 高亮背景", "Netherlands sample · bright background"),
        ("nl-crop-02.jpg", "荷兰裁切 02", "Netherlands Crop 02", "荷兰测试图 · 小车牌", "Netherlands sample · small plate crop"),
    ]

    static func load() -> [SamplePhoto] {
        guard let baseURL = Bundle.main.resourceURL?.appendingPathComponent(sampleDirectoryName, isDirectory: true) else {
            return []
        }

        return manifest.compactMap { item in
            let url = baseURL.appendingPathComponent(item.filename)
            guard let image = UIImage(contentsOfFile: url.path) else {
                return nil
            }

            return SamplePhoto(
                filename: item.filename,
                titleChinese: item.zhTitle,
                titleEnglish: item.enTitle,
                subtitleChinese: item.zhSubtitle,
                subtitleEnglish: item.enSubtitle,
                image: image
            )
        }
    }
}
