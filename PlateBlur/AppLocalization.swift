import Foundation

enum AppLanguage: String, CaseIterable, Identifiable {
    case simplifiedChinese = "zh-Hans"
    case english = "en"

    var id: Self { self }

    var locale: Locale {
        Locale(identifier: rawValue)
    }

    func displayName(in language: AppLanguage) -> String {
        switch (self, language) {
        case (.simplifiedChinese, .simplifiedChinese):
            return "简体中文"
        case (.english, .simplifiedChinese):
            return "English"
        case (.simplifiedChinese, .english):
            return "Simplified Chinese"
        case (.english, .english):
            return "English"
        }
    }
}

enum AppCopy {
    case appTitle
    case appSubtitle
    case settings
    case statusIdle
    case queueTitle
    case queueEmpty
    case queueSummary
    case emptyHeroTitle
    case emptyHeroBody
    case emptyHeroHint
    case currentItem
    case previewOriginal
    case previewRedacted
    case editHint
    case resultHint
    case detectionCount
    case detectorLabel
    case noDetector
    case addBox
    case deleteBox
    case importPhotos
    case testSamples
    case capture
    case detectCurrent
    case detectAll
    case saveCurrent
    case saveAll
    case shareCurrent
    case shareAll
    case actionsTitle
    case saveMenu
    case shareMenu
    case stylesTitle
    case statusTitle
    case testLibraryTitle
    case testLibrarySubtitle
    case importSample
    case close
    case sampleEmpty
    case sampleReadyTag
    case settingsTitle
    case settingsSubtitle
    case languageTitle
    case languageDescription
    case redactionStyleTitle
    case paddingTitle
    case exportFormatTitle
    case jpegQualityTitle
    case autoDetectAfterImport
    case autoSaveAfterProcessing
    case includeOriginalWhenSharing
    case plateRegionsTitle
    case saveDialogTitle
    case saveDialogMessage
    case saveAsNew
    case overwriteOriginal
    case importedAndReady
    case queuedForDetection
    case importToBegin
    case prepareFailed
    case importedCount
    case removedAllItems
    case removedSingleItem
    case keepOneRegion
    case enabledRegions
    case selectPhotoBeforeAddingBox
    case manualBoxAdded
    case selectDetectionBeforeDeleting
    case deletedSelectedBox
    case importPhotoFirst
    case importPhotosFirst
    case selectProcessedBeforeSave
    case keepBoxBeforeSave
    case nothingToBatchSave
    case batchSaveDone
    case batchSaveDoneSkipped
    case selectProcessedBeforeShare
    case keepBoxBeforeShare
    case sharePreparedCount
    case sharePrepareFailed
    case nothingToShare
    case batchSharePrepared
    case batchSharePreparedSkipped
    case detectionRunFinished
    case runningDetection
    case addManualBoxIfNeeded
    case addManualBoxBeforeExport
    case encodingForExport
    case savedNewCopy
    case overwriteFinished
    case originalUnavailableSavedNew
    case saveFailed
    case loadedOnePhotoFailed
    case languageChanged
    case cameraName
    case exportTitle
    case exportMissingImage
    case exportEncodingFailed
    case libraryPermissionDenied
    case libraryAssetUnavailable
    case libraryInputUnavailable
    case coreMLFound
    case coreMLFailed
    case coreMLUnsupported
    case coreMLPredictionFailed
    case coreMLMalformedOutput
    case noBundledModel
    case ocrFound
    case ocrNone
    case ocrFailed
    case rectangleFallbackUsed
    case rectangleFallbackNone
    case rectangleFallbackFailed
    case imageInvalidData

    fileprivate func template(in language: AppLanguage) -> String {
        switch language {
        case .simplifiedChinese:
            switch self {
            case .appTitle: return "车牌打码"
            case .appSubtitle: return "拍照、检测、打码，一屏完成。"
            case .settings: return "设置"
            case .statusIdle: return "导入车辆照片后就可以开始。"
            case .queueTitle: return "当前队列"
            case .queueEmpty: return "还没有图片。可以从相册导入、直接拍照，或先看内置测试图。"
            case .queueSummary: return "%d / %d 张已可导出"
            case .emptyHeroTitle: return "先挑一张车图，我们马上开始。"
            case .emptyHeroBody: return "这版已经内置 Core ML 车牌检测，也保留 OCR 和矩形兜底。适合手机现场拍照后直接完成打码。"
            case .emptyHeroHint: return "推荐先点“测试图片”，快速看效果。"
            case .currentItem: return "当前图片"
            case .previewOriginal: return "原图与框"
            case .previewRedacted: return "打码结果"
            case .editHint: return "拖动或缩放框，直接修正识别结果。"
            case .resultHint: return "这是当前打码预览，保存与分享都会导出这一版。"
            case .detectionCount: return "%d 个框"
            case .detectorLabel: return "主检测：%@"
            case .noDetector: return "尚未检测"
            case .addBox: return "加框"
            case .deleteBox: return "删框"
            case .importPhotos: return "导入照片"
            case .testSamples: return "测试图片"
            case .capture: return "立即拍照"
            case .detectCurrent: return "检测当前"
            case .detectAll: return "检测全部"
            case .saveCurrent: return "保存当前"
            case .saveAll: return "全部保存"
            case .shareCurrent: return "分享当前"
            case .shareAll: return "全部分享"
            case .actionsTitle: return "快捷操作"
            case .saveMenu: return "保存"
            case .shareMenu: return "分享"
            case .stylesTitle: return "打码样式"
            case .statusTitle: return "状态"
            case .testLibraryTitle: return "测试图片"
            case .testLibrarySubtitle: return "这里打包了当前评测时用到的公开样张，直接选一张导入看看。"
            case .importSample: return "导入这张测试图"
            case .close: return "关闭"
            case .sampleEmpty: return "当前没有打包任何测试图片。"
            case .sampleReadyTag: return "内置样张"
            case .settingsTitle: return "设置"
            case .settingsSubtitle: return "这里控制语言、导出与自动化行为。"
            case .languageTitle: return "界面语言"
            case .languageDescription: return "默认用中文，英文可以在这里切换。"
            case .redactionStyleTitle: return "打码样式"
            case .paddingTitle: return "车牌外扩"
            case .exportFormatTitle: return "导出格式"
            case .jpegQualityTitle: return "JPEG 质量"
            case .autoDetectAfterImport: return "导入后自动检测"
            case .autoSaveAfterProcessing: return "检测完成后自动保存"
            case .includeOriginalWhenSharing: return "分享时附带原图"
            case .plateRegionsTitle: return "车牌地区"
            case .saveDialogTitle: return "保存处理结果"
            case .saveDialogMessage: return "选择是另外保存一份，还是直接覆盖原始照片。"
            case .saveAsNew: return "另存新图"
            case .overwriteOriginal: return "覆盖原图"
            case .importedAndReady: return "导入完成，等待处理。"
            case .queuedForDetection: return "已加入检测队列。"
            case .importToBegin: return "导入车辆照片后就可以开始。"
            case .prepareFailed: return "处理 %@ 失败：%@"
            case .importedCount: return "已导入 %d 张照片。"
            case .removedAllItems: return "队列已清空。"
            case .removedSingleItem: return "已从队列中移除 1 张图片。"
            case .keepOneRegion: return "至少要保留一个车牌地区。"
            case .enabledRegions: return "当前地区：%@"
            case .selectPhotoBeforeAddingBox: return "先选中一张图片，再手动加框。"
            case .manualBoxAdded: return "已添加手动框，可以直接拖动或缩放。"
            case .selectDetectionBeforeDeleting: return "先选中一个框，再删除。"
            case .deletedSelectedBox: return "已删除当前选中的框。"
            case .importPhotoFirst: return "先导入一张图片。"
            case .importPhotosFirst: return "先导入至少一张图片。"
            case .selectProcessedBeforeSave: return "先选中一张已处理图片，再保存。"
            case .keepBoxBeforeSave: return "至少保留一个车牌框才能保存。"
            case .nothingToBatchSave: return "当前没有可批量保存的图片。"
            case .batchSaveDone: return "批量保存完成，共 %d 张。"
            case .batchSaveDoneSkipped: return "批量保存完成，共 %d 张；另有 %d 张因没有框被跳过。"
            case .selectProcessedBeforeShare: return "先选中一张已处理图片，再分享。"
            case .keepBoxBeforeShare: return "至少保留一个车牌框才能分享。"
            case .sharePreparedCount: return "已准备 %d 个分享文件。"
            case .sharePrepareFailed: return "准备分享失败：%@"
            case .nothingToShare: return "当前没有可分享的图片。"
            case .batchSharePrepared: return "已准备 %d 张图片的批量分享。"
            case .batchSharePreparedSkipped: return "已准备 %d 张图片的批量分享；另有 %d 张因没有框被跳过。"
            case .detectionRunFinished: return "检测完成，共处理 %d 张图片。"
            case .runningDetection: return "正在执行自动车牌检测..."
            case .addManualBoxIfNeeded: return "如果漏检，可以手动补一个框。"
            case .addManualBoxBeforeExport: return "导出前请先补一个手动框。"
            case .encodingForExport: return "正在编码导出图片..."
            case .savedNewCopy: return "已将打码结果另存到相册。"
            case .overwriteFinished: return "已在确认后覆盖原始照片。"
            case .originalUnavailableSavedNew: return "原始资源不可覆盖，已改为另存一份。"
            case .saveFailed: return "保存失败：%@"
            case .loadedOnePhotoFailed: return "加载某张图片失败：%@"
            case .languageChanged: return "界面语言已切换为 %@。"
            case .cameraName: return "拍摄 %@"
            case .exportTitle: return "车牌打码导出"
            case .exportMissingImage: return "当前项目没有可导出的渲染图。"
            case .exportEncodingFailed: return "图片编码失败，无法导出。"
            case .libraryPermissionDenied: return "没有相册访问权限。"
            case .libraryAssetUnavailable: return "原始照片资源已不可用，无法覆盖。"
            case .libraryInputUnavailable: return "这张照片当前无法用于覆盖编辑。"
            case .coreMLFound: return "Core ML 检测到 %d 个候选车牌。"
            case .coreMLFailed: return "Core ML 检测失败：%@"
            case .coreMLUnsupported: return "内置 Core ML 模型的输出格式暂不支持。"
            case .coreMLPredictionFailed: return "内置 Core ML 模型推理失败。"
            case .coreMLMalformedOutput: return "内置 Core ML 模型返回了损坏的框数据。"
            case .noBundledModel: return "未找到内置的 LicensePlateDetector 模型。"
            case .ocrFound: return "OCR 在 %@ 区域规则下识别到 %d 个疑似车牌文本。"
            case .ocrNone: return "OCR 没有识别到符合地区规则的车牌文本。"
            case .ocrFailed: return "OCR 检测失败：%@"
            case .rectangleFallbackUsed: return "已启用矩形兜底候选。正式上线前建议换成训练好的车牌模型。"
            case .rectangleFallbackNone: return "矩形兜底也没有找到可靠候选。"
            case .rectangleFallbackFailed: return "矩形兜底失败：%@"
            case .imageInvalidData: return "当前图片无法完成预处理。"
            }
        case .english:
            switch self {
            case .appTitle: return "PlateBlur"
            case .appSubtitle: return "Capture, detect, and redact in one screen."
            case .settings: return "Settings"
            case .statusIdle: return "Import a vehicle photo to begin."
            case .queueTitle: return "Queue"
            case .queueEmpty: return "No images yet. Import from the library, capture one now, or open the built-in samples first."
            case .queueSummary: return "%d / %d ready to export"
            case .emptyHeroTitle: return "Pick a car photo and we can start right away."
            case .emptyHeroBody: return "This build ships with a bundled Core ML plate detector plus OCR and rectangle fallback recovery. It is tuned for fast iPhone photo redaction."
            case .emptyHeroHint: return "Start with Test Samples if you want to inspect the current benchmark images."
            case .currentItem: return "Current Image"
            case .previewOriginal: return "Original + Boxes"
            case .previewRedacted: return "Redacted Result"
            case .editHint: return "Drag or resize the boxes to correct the detection result."
            case .resultHint: return "This is the current redaction preview. Save and share will export this version."
            case .detectionCount: return "%d boxes"
            case .detectorLabel: return "Primary detector: %@"
            case .noDetector: return "Not detected yet"
            case .addBox: return "Add Box"
            case .deleteBox: return "Delete Box"
            case .importPhotos: return "Import Photos"
            case .testSamples: return "Test Samples"
            case .capture: return "Capture"
            case .detectCurrent: return "Detect Current"
            case .detectAll: return "Detect All"
            case .saveCurrent: return "Save Current"
            case .saveAll: return "Save All"
            case .shareCurrent: return "Share Current"
            case .shareAll: return "Share All"
            case .actionsTitle: return "Quick Actions"
            case .saveMenu: return "Save"
            case .shareMenu: return "Share"
            case .stylesTitle: return "Redaction Style"
            case .statusTitle: return "Status"
            case .testLibraryTitle: return "Test Samples"
            case .testLibrarySubtitle: return "These are the public benchmark images currently packed into the app so you can inspect them quickly."
            case .importSample: return "Import This Sample"
            case .close: return "Close"
            case .sampleEmpty: return "No test samples are bundled right now."
            case .sampleReadyTag: return "Bundled sample"
            case .settingsTitle: return "Settings"
            case .settingsSubtitle: return "Language, export, and automation controls live here."
            case .languageTitle: return "Interface Language"
            case .languageDescription: return "Chinese is the default. You can switch to English here."
            case .redactionStyleTitle: return "Redaction Style"
            case .paddingTitle: return "Plate Padding"
            case .exportFormatTitle: return "Export Format"
            case .jpegQualityTitle: return "JPEG Quality"
            case .autoDetectAfterImport: return "Auto detect after import"
            case .autoSaveAfterProcessing: return "Auto save after processing"
            case .includeOriginalWhenSharing: return "Include originals when sharing"
            case .plateRegionsTitle: return "Plate Regions"
            case .saveDialogTitle: return "Save Processed Image"
            case .saveDialogMessage: return "Choose whether to create a new photo or overwrite the original asset."
            case .saveAsNew: return "Save As New"
            case .overwriteOriginal: return "Overwrite Original"
            case .importedAndReady: return "Imported and ready."
            case .queuedForDetection: return "Queued for detection."
            case .importToBegin: return "Import a vehicle photo to begin."
            case .prepareFailed: return "Failed to prepare %@: %@"
            case .importedCount: return "Imported %d photo(s)."
            case .removedAllItems: return "All items were removed."
            case .removedSingleItem: return "Removed one item from the queue."
            case .keepOneRegion: return "At least one plate region must stay enabled."
            case .enabledRegions: return "Enabled regions: %@"
            case .selectPhotoBeforeAddingBox: return "Select a photo before adding a manual box."
            case .manualBoxAdded: return "Manual box added. Drag or resize it directly."
            case .selectDetectionBeforeDeleting: return "Select a detection before deleting it."
            case .deletedSelectedBox: return "Removed the selected box."
            case .importPhotoFirst: return "Import a photo first."
            case .importPhotosFirst: return "Import one or more photos first."
            case .selectProcessedBeforeSave: return "Select a processed item before saving."
            case .keepBoxBeforeSave: return "Keep at least one plate box before saving."
            case .nothingToBatchSave: return "Nothing is ready for batch save yet."
            case .batchSaveDone: return "Batch save finished for %d item(s)."
            case .batchSaveDoneSkipped: return "Batch save finished for %d item(s); skipped %d without boxes."
            case .selectProcessedBeforeShare: return "Select a processed item before sharing."
            case .keepBoxBeforeShare: return "Keep at least one plate box before sharing."
            case .sharePreparedCount: return "Prepared %d file(s) for sharing."
            case .sharePrepareFailed: return "Failed to prepare share payload: %@"
            case .nothingToShare: return "Nothing is ready to share yet."
            case .batchSharePrepared: return "Prepared batch sharing for %d item(s)."
            case .batchSharePreparedSkipped: return "Prepared batch sharing for %d item(s); skipped %d without boxes."
            case .detectionRunFinished: return "Detection run finished for %d item(s)."
            case .runningDetection: return "Running automatic plate detection..."
            case .addManualBoxIfNeeded: return "Add a manual box if the detector missed the plate."
            case .addManualBoxBeforeExport: return "Add a manual box before exporting this photo."
            case .encodingForExport: return "Encoding image for export..."
            case .savedNewCopy: return "Saved a new redacted copy to the photo library."
            case .overwriteFinished: return "Overwrote the original asset after confirmation."
            case .originalUnavailableSavedNew: return "Original asset unavailable, so a new copy was saved instead."
            case .saveFailed: return "Save failed: %@"
            case .loadedOnePhotoFailed: return "Failed to load one photo: %@"
            case .languageChanged: return "Interface language switched to %@."
            case .cameraName: return "Camera %@"
            case .exportTitle: return "PlateBlur Export"
            case .exportMissingImage: return "The selected item has no rendered image to export."
            case .exportEncodingFailed: return "The image could not be encoded for export."
            case .libraryPermissionDenied: return "Photo library access was denied."
            case .libraryAssetUnavailable: return "The original photo asset is no longer available for overwrite."
            case .libraryInputUnavailable: return "The selected photo could not be opened for overwrite."
            case .coreMLFound: return "Core ML detector found %d candidate plate(s)."
            case .coreMLFailed: return "Core ML detector failed: %@"
            case .coreMLUnsupported: return "The bundled Core ML model output format is not supported."
            case .coreMLPredictionFailed: return "The bundled Core ML detector failed during prediction."
            case .coreMLMalformedOutput: return "The bundled Core ML detector returned malformed bounding box data."
            case .noBundledModel: return "No bundled Core ML model named LicensePlateDetector was found."
            case .ocrFound: return "OCR pattern detector found %2$d plate-like text region(s) for %1$@."
            case .ocrNone: return "OCR pattern detector found no region-specific plate text."
            case .ocrFailed: return "OCR pattern detector failed: %@"
            case .rectangleFallbackUsed: return "Using rectangle fallback candidates. Replace them with a trained plate model before shipping."
            case .rectangleFallbackNone: return "The rectangle fallback also found no strong candidates."
            case .rectangleFallbackFailed: return "Rectangle fallback failed: %@"
            case .imageInvalidData: return "The selected image could not be prepared for processing."
            }
        }
    }
}

enum AppText {
    private static let storageKey = "plateblur.appLanguage"

    static var currentLanguage: AppLanguage {
        get {
            guard let raw = UserDefaults.standard.string(forKey: storageKey),
                  let language = AppLanguage(rawValue: raw) else {
                return .simplifiedChinese
            }
            return language
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: storageKey)
        }
    }

    static func text(
        _ key: AppCopy,
        language: AppLanguage? = nil,
        arguments: [CVarArg] = []
    ) -> String {
        let resolvedLanguage = language ?? currentLanguage
        let template = key.template(in: resolvedLanguage)
        guard !arguments.isEmpty else { return template }
        return String(format: template, locale: resolvedLanguage.locale, arguments: arguments)
    }

    static func text(
        _ key: AppCopy,
        language: AppLanguage? = nil,
        _ arguments: CVarArg...
    ) -> String {
        text(key, language: language, arguments: arguments)
    }
}
