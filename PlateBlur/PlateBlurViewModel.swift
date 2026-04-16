import Foundation
import UIKit

@MainActor
final class PlateBlurViewModel: ObservableObject {
    @Published var items: [BatchProcessingItem] = []
    @Published var selectedItemID: UUID?
    @Published var selectedDetectionID: UUID?
    @Published var redactionStyle: PlateRedactionStyle = .solidBlock {
        didSet { regenerateAllPreviews() }
    }
    @Published var expansionAmount: Double = 0.12 {
        didSet { regenerateAllPreviews() }
    }
    @Published var exportFormat: ExportFormat = .jpeg
    @Published var exportQuality: Double = 0.9
    @Published var autoSaveAfterProcessing = false
    @Published var includeOriginalWhenSharing = false
    @Published var autoDetectAfterImport = true
    @Published var enabledRegions: Set<SupportedPlateRegion> = Set(SupportedPlateRegion.allCases)
    @Published var enhancedRecognitionEnabled = true {
        didSet {
            guard oldValue != enhancedRecognitionEnabled else { return }
            statusMessage = localized(enhancedRecognitionEnabled ? .enhancedRecognitionOn : .enhancedRecognitionOff)
        }
    }
    @Published var sharePayload: SharePayload?
    @Published var appLanguage: AppLanguage {
        didSet {
            guard oldValue != appLanguage else { return }
            AppText.currentLanguage = appLanguage
            refreshMessagesForLanguageChange()
        }
    }
    @Published var statusMessage: String

    private let pipeline = PlateDetectorPipeline()
    private let renderer = PlateRedactionRenderer()
    private let exportService = ExportService()

    init() {
        let language = AppText.currentLanguage
        appLanguage = language
        statusMessage = AppText.text(.importToBegin, language: language)
    }

    var selectedItem: BatchProcessingItem? {
        guard let selectedItemID,
              let index = items.firstIndex(where: { $0.id == selectedItemID }) else {
            return nil
        }

        return items[index]
    }

    var selectedPreviewImage: UIImage? {
        selectedItem?.displayImage
    }

    var canUseCamera: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    var hasItems: Bool {
        !items.isEmpty
    }

    var selectedItemCanExport: Bool {
        selectedItem?.isReadyForExport == true
    }

    var hasExportableItems: Bool {
        items.contains(where: \.isReadyForExport)
    }

    var batchSummary: String {
        let processed = items.filter { $0.state == .processed || $0.state == .saved || $0.state == .shared }.count
        return localized(.queueSummary, processed, items.count)
    }

    func importPayloads(_ payloads: [ImportedImagePayload]) async {
        guard !payloads.isEmpty else { return }

        var newIDs: [UUID] = []
        var importedCount = 0

        for payload in payloads {
            do {
                let prepared = try payload.image.preparedForProcessing()
                let item = BatchProcessingItem(
                    name: payload.suggestedName,
                    sourceImage: prepared,
                    sourceAssetIdentifier: payload.sourceAssetIdentifier,
                    statusMessage: autoDetectAfterImport ? localized(.queuedForDetection) : localized(.importedAndReady)
                )
                items.append(item)
                newIDs.append(item.id)
                importedCount += 1
            } catch {
                statusMessage = localized(.prepareFailed, payload.suggestedName, error.localizedDescription)
            }
        }

        if selectedItemID == nil {
            selectedItemID = newIDs.first
        } else if let last = newIDs.last {
            selectedItemID = last
        }

        selectedDetectionID = nil
        statusMessage = localized(.importedCount, importedCount)

        regenerateAllPreviews()

        if autoDetectAfterImport {
            await processItems(withIDs: newIDs)
        }
    }

    func importCameraImage(_ image: UIImage) async {
        let payload = ImportedImagePayload(
            image: image,
            suggestedName: localized(.cameraName, localizedTimeString()),
            sourceAssetIdentifier: nil
        )
        await importPayloads([payload])
    }

    func selectItem(_ id: UUID?) {
        selectedItemID = id
        selectedDetectionID = nil
    }

    func removeItem(_ id: UUID) {
        items.removeAll { $0.id == id }
        if selectedItemID == id {
            selectedItemID = items.first?.id
            selectedDetectionID = nil
        }
        statusMessage = items.isEmpty ? localized(.removedAllItems) : localized(.removedSingleItem)
    }

    func toggleRegion(_ region: SupportedPlateRegion) {
        if enabledRegions.contains(region) {
            guard enabledRegions.count > 1 else {
                statusMessage = localized(.keepOneRegion)
                return
            }
            enabledRegions.remove(region)
        } else {
            enabledRegions.insert(region)
        }

        statusMessage = localized(
            .enabledRegions,
            enabledRegions.map(\.shortTitle).sorted().joined(separator: ", ")
        )
    }

    func runAutoDetectionOnSelected() async {
        guard let selectedItemID else {
            statusMessage = localized(.importPhotoFirst)
            return
        }
        await processItem(withID: selectedItemID)
    }

    func runAutoDetectionOnAll() async {
        guard !items.isEmpty else {
            statusMessage = localized(.importPhotosFirst)
            return
        }
        await processItems(withIDs: items.map(\.id))
    }

    func retryItem(_ id: UUID) async {
        await processItem(withID: id)
    }

    func addManualDetection() {
        guard let index = selectedItemIndex else {
            statusMessage = localized(.selectPhotoBeforeAddingBox)
            return
        }

        let detection = PlateDetection(
            normalizedRect: CGRect(x: 0.28, y: 0.55, width: 0.34, height: 0.12),
            confidence: 1,
            source: .manual
        )
        items[index].detections.append(detection)
        items[index].state = .processed
        items[index].statusMessage = localized(.manualBoxAdded)
        selectedDetectionID = detection.id
        regeneratePreview(for: items[index].id)
        statusMessage = items[index].statusMessage
    }

    func removeSelectedDetection() {
        guard let selectedDetectionID,
              let itemIndex = selectedItemIndex else {
            statusMessage = localized(.selectDetectionBeforeDeleting)
            return
        }

        items[itemIndex].detections.removeAll { $0.id == selectedDetectionID }
        self.selectedDetectionID = items[itemIndex].detections.first?.id
        items[itemIndex].statusMessage = localized(.deletedSelectedBox)
        regeneratePreview(for: items[itemIndex].id)
        statusMessage = items[itemIndex].statusMessage
    }

    func updateDetection(id: UUID, normalizedRect: CGRect) {
        guard let itemIndex = selectedItemIndex,
              let detectionIndex = items[itemIndex].detections.firstIndex(where: { $0.id == id }) else { return }

        items[itemIndex].detections[detectionIndex].normalizedRect = normalizedRect.clampedToUnit()
    }

    func commitDetection(id: UUID, normalizedRect: CGRect) {
        guard let itemIndex = selectedItemIndex,
              let detectionIndex = items[itemIndex].detections.firstIndex(where: { $0.id == id }) else { return }

        items[itemIndex].detections[detectionIndex].normalizedRect = normalizedRect.clampedToUnit()
        regeneratePreview(for: items[itemIndex].id)
    }

    func selectDetection(_ id: UUID?) {
        selectedDetectionID = id
    }

    func saveSelected(with behavior: SaveBehavior) async {
        guard let selectedItemID else {
            statusMessage = localized(.selectProcessedBeforeSave)
            return
        }

        guard selectedItemCanExport else {
            statusMessage = localized(.keepBoxBeforeSave)
            return
        }

        await saveItem(withID: selectedItemID, behavior: behavior)
    }

    func saveAllAsNew() async {
        let exportableIDs = items.filter(\.isReadyForExport).map(\.id)
        guard !exportableIDs.isEmpty else {
            statusMessage = localized(.nothingToBatchSave)
            return
        }

        for id in exportableIDs {
            await saveItem(withID: id, behavior: .saveAsNew, updateGlobalStatus: false)
        }

        let skippedCount = items.count - exportableIDs.count
        statusMessage = skippedCount == 0
            ? localized(.batchSaveDone, exportableIDs.count)
            : localized(.batchSaveDoneSkipped, exportableIDs.count, skippedCount)
    }

    func prepareShareSelected() {
        guard let selectedItem else {
            statusMessage = localized(.selectProcessedBeforeShare)
            return
        }

        guard selectedItem.isReadyForExport else {
            statusMessage = localized(.keepBoxBeforeShare)
            return
        }

        do {
            sharePayload = try exportService.buildSharePayload(
                for: [selectedItem],
                format: exportFormat,
                quality: exportQuality,
                includeOriginal: includeOriginalWhenSharing
            )
            let preparedCount = sharePayload?.urls.count ?? 0
            updateItemState(selectedItem.id, state: .shared, itemStatus: localized(.sharePreparedCount, preparedCount))
            statusMessage = localized(.sharePreparedCount, preparedCount)
        } catch {
            statusMessage = localized(.sharePrepareFailed, error.localizedDescription)
        }
    }

    func prepareShareAll() {
        let exportableItems = items.filter(\.isReadyForExport)
        guard !exportableItems.isEmpty else {
            statusMessage = localized(.nothingToShare)
            return
        }

        do {
            sharePayload = try exportService.buildSharePayload(
                for: exportableItems,
                format: exportFormat,
                quality: exportQuality,
                includeOriginal: includeOriginalWhenSharing
            )
            let itemStatus = localized(.batchSharePrepared, exportableItems.count)
            for id in exportableItems.map(\.id) {
                updateItemState(id, state: .shared, itemStatus: itemStatus)
            }
            let skippedCount = items.count - exportableItems.count
            statusMessage = skippedCount == 0
                ? localized(.batchSharePrepared, exportableItems.count)
                : localized(.batchSharePreparedSkipped, exportableItems.count, skippedCount)
        } catch {
            statusMessage = localized(.sharePrepareFailed, error.localizedDescription)
        }
    }

    private var selectedItemIndex: Int? {
        guard let selectedItemID else { return nil }
        return items.firstIndex(where: { $0.id == selectedItemID })
    }

    private func processItems(withIDs ids: [UUID]) async {
        for id in ids {
            await processItem(withID: id)
        }
        statusMessage = localized(.detectionRunFinished, ids.count)
    }

    private func processItem(withID id: UUID) async {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }

        let sourceImage = items[index].sourceImage
        let manualDetections = items[index].detections.filter { $0.source == .manual }
        items[index].state = .detecting
        items[index].statusMessage = localized(.runningDetection)

        let report = await pipeline.detect(
            in: sourceImage,
            regions: enabledRegions,
            enhancedRecognitionEnabled: enhancedRecognitionEnabled
        )

        guard let refreshedIndex = items.firstIndex(where: { $0.id == id }) else { return }

        let merged = deduplicate(report.detections + manualDetections)
        items[refreshedIndex].detections = merged
        items[refreshedIndex].primaryDetector = report.primaryDetector
        items[refreshedIndex].statusMessage = report.message
        items[refreshedIndex].state = merged.isEmpty ? .failed : .processed

        if selectedItemID == id {
            selectedDetectionID = merged.first?.id
        }

        regeneratePreview(for: id)

        if merged.isEmpty {
            items[refreshedIndex].statusMessage += " \(localized(.addManualBoxIfNeeded))"
        }

        statusMessage = items[refreshedIndex].statusMessage

        if autoSaveAfterProcessing && !merged.isEmpty {
            await saveItem(withID: id, behavior: .saveAsNew, updateGlobalStatus: false)
        }
    }

    private func saveItem(
        withID id: UUID,
        behavior: SaveBehavior,
        updateGlobalStatus: Bool = true
    ) async {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }

        let item = items[index]
        guard item.isReadyForExport else {
            updateItemState(id, state: .failed, itemStatus: localized(.addManualBoxBeforeExport))
            if updateGlobalStatus {
                statusMessage = localized(.addManualBoxBeforeExport)
            }
            return
        }

        let imageToSave = item.redactedImage ?? item.sourceImage
        items[index].state = .saving
        items[index].statusMessage = localized(.encodingForExport)

        do {
            let imageData = try exportService.imageData(for: imageToSave, format: exportFormat, quality: exportQuality)

            switch behavior {
            case .saveAsNew:
                try await PhotoLibrarySaver.saveNew(
                    imageData: imageData,
                    uniformTypeIdentifier: exportFormat.uniformTypeIdentifier
                )
                updateItemState(id, state: .saved, itemStatus: localized(.savedNewCopy))
            case .overwriteOriginalWhenPossible:
                if let assetIdentifier = item.sourceAssetIdentifier {
                    try await PhotoLibrarySaver.overwrite(
                        assetIdentifier: assetIdentifier,
                        imageData: imageData
                    )
                    updateItemState(id, state: .saved, itemStatus: localized(.overwriteFinished))
                } else {
                    try await PhotoLibrarySaver.saveNew(
                        imageData: imageData,
                        uniformTypeIdentifier: exportFormat.uniformTypeIdentifier
                    )
                    updateItemState(id, state: .saved, itemStatus: localized(.originalUnavailableSavedNew))
                }
            }

            if updateGlobalStatus,
               let refreshedIndex = items.firstIndex(where: { $0.id == id }) {
                statusMessage = items[refreshedIndex].statusMessage
            }
        } catch {
            updateItemState(id, state: .failed, itemStatus: localized(.saveFailed, error.localizedDescription))
            if updateGlobalStatus {
                statusMessage = localized(.saveFailed, error.localizedDescription)
            }
        }
    }

    private func updateItemState(_ id: UUID, state: BatchProcessingState, itemStatus: String) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].state = state
        items[index].statusMessage = itemStatus
    }

    private func refreshMessagesForLanguageChange() {
        for index in items.indices {
            switch items[index].state {
            case .imported:
                items[index].statusMessage = autoDetectAfterImport ? localized(.queuedForDetection) : localized(.importedAndReady)
            case .detecting:
                items[index].statusMessage = localized(.runningDetection)
            case .processed:
                items[index].statusMessage = items[index].detections.isEmpty
                    ? localized(.addManualBoxIfNeeded)
                    : localized(.detectionCount, items[index].detections.count)
            case .saving:
                items[index].statusMessage = localized(.encodingForExport)
            case .saved:
                items[index].statusMessage = localized(.savedNewCopy)
            case .failed:
                items[index].statusMessage = localized(.addManualBoxIfNeeded)
            case .shared:
                items[index].statusMessage = localized(.sharePreparedCount, includeOriginalWhenSharing ? 2 : 1)
            }
        }

        statusMessage = localized(.languageChanged, appLanguage.displayName(in: appLanguage))
    }

    private func regenerateAllPreviews() {
        for item in items {
            regeneratePreview(for: item.id)
        }
    }

    private func regeneratePreview(for id: UUID) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        let item = items[index]
        items[index].redactedImage = renderer.render(
            image: item.sourceImage,
            detections: item.detections,
            style: redactionStyle,
            expansion: expansionAmount
        ) ?? item.sourceImage
    }

    private func localized(_ key: AppCopy, _ arguments: CVarArg...) -> String {
        AppText.text(key, language: appLanguage, arguments: arguments)
    }

    private func localizedTimeString() -> String {
        let formatter = DateFormatter()
        formatter.locale = appLanguage.locale
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter.string(from: .now)
    }
}
