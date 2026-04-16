import Photos
import PhotosUI
import SwiftUI

struct ContentView: View {
    @StateObject private var viewModel = PlateBlurViewModel()
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var isCameraPresented = false
    @State private var isSaveDialogPresented = false
    @State private var isSettingsPresented = false
    @State private var isSampleLibraryPresented = false
    @State private var previewMode: PreviewMode = .original

    private let accentBlue = Color(red: 0.0, green: 0.443, blue: 0.89)
    private let backgroundGray = Color(red: 0.96, green: 0.96, blue: 0.97)
    private let textPrimary = Color(red: 0.114, green: 0.114, blue: 0.121)
    private let textSecondary = Color.black.opacity(0.58)
    private let borderColor = Color.black.opacity(0.08)
    private let actionColumns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
    ]
    private let styleColumns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
    ]

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                backgroundGray
                    .ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(spacing: 14) {
                        heroHeader(topInset: geometry.safeAreaInsets.top)
                        imageStageSection(height: min(max(geometry.size.height * 0.34, 270), 360))
                        commandSection
                        queueSection
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 96)
                }
                .scrollBounceBehavior(.basedOnSize)

                bottomToolbar(bottomInset: geometry.safeAreaInsets.bottom)
            }
        }
        .preferredColorScheme(.light)
        .environment(\.locale, viewModel.appLanguage.locale)
        .sheet(isPresented: $isCameraPresented) {
            CameraCaptureView { image in
                Task {
                    await viewModel.importCameraImage(image)
                }
            }
        }
        .sheet(item: $viewModel.sharePayload) { payload in
            ActivityView(items: payload.urls)
        }
        .sheet(isPresented: $isSettingsPresented) {
            SettingsSheet(viewModel: viewModel)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $isSampleLibraryPresented) {
            SampleLibraryView(language: viewModel.appLanguage) { payload in
                Task {
                    await viewModel.importPayloads([payload])
                }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .confirmationDialog(
            t(.saveDialogTitle),
            isPresented: $isSaveDialogPresented,
            titleVisibility: .visible
        ) {
            Button(t(.saveAsNew)) {
                Task {
                    await viewModel.saveSelected(with: .saveAsNew)
                }
            }

            if viewModel.selectedItem?.canOverwriteOriginal == true {
                Button(t(.overwriteOriginal), role: .destructive) {
                    Task {
                        await viewModel.saveSelected(with: .overwriteOriginalWhenPossible)
                    }
                }
            }
        } message: {
            Text(t(.saveDialogMessage))
        }
        .onChange(of: selectedPhotoItems) { _, newValue in
            Task {
                await loadSelections(newValue)
            }
        }
    }

    private func heroHeader(topInset: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(t(.appTitle))
                        .font(.system(size: 32, weight: .bold))
                        .foregroundStyle(textPrimary)

                    Text(t(.appSubtitle))
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(textSecondary)
                }

                Spacer(minLength: 0)

                toolbarIconButton(systemImage: "globe") {
                    isSettingsPresented = true
                }
            }

            AppleGlassCard(cornerRadius: 24, padding: 14) {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(viewModel.statusMessage)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(textPrimary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lineLimit(2)

                        if let item = viewModel.selectedItem {
                            Text(item.statusMessage)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(textSecondary)
                                .lineLimit(1)
                        }
                    }

                    Spacer(minLength: 0)

                    Image(systemName: "waveform.and.magnifyingglass")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(accentBlue)
                        .frame(width: 36, height: 36)
                        .background(
                            Circle()
                                .fill(accentBlue.opacity(0.10))
                        )
                }
            }
        }
        .padding(.top, topInset + 10)
    }

    private func imageStageSection(height: CGFloat) -> some View {
        AppleGlassCard(cornerRadius: 32, padding: 18) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(viewModel.selectedItem?.name ?? t(.emptyHeroTitle))
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(textPrimary)
                            .lineLimit(2)

                        Text(stageSubtitle)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(textSecondary)
                            .lineLimit(2)
                    }

                    Spacer(minLength: 0)

                    previewModePicker
                }

                Group {
                    if let item = viewModel.selectedItem {
                        stagePreview(for: item, height: height)
                    } else {
                        emptyStage(height: height)
                    }
                }

                HStack(spacing: 10) {
                    infoChip(
                        title: t(.detectionCount, viewModel.selectedItem?.detections.count ?? 0),
                        tint: accentBlue.opacity(0.12),
                        foreground: accentBlue
                    )

                    infoChip(
                        title: t(
                            .detectorLabel,
                            viewModel.selectedItem?.primaryDetector?.title(in: viewModel.appLanguage) ?? t(.noDetector)
                        ),
                        tint: Color.white.opacity(0.72),
                        foreground: textPrimary
                    )
                }

                if viewModel.selectedItem != nil {
                    HStack(spacing: 12) {
                        inlineActionButton(
                            title: t(.addBox),
                            systemImage: "plus.viewfinder",
                            emphasized: true,
                            isDisabled: viewModel.selectedItem == nil
                        ) {
                            viewModel.addManualDetection()
                        }

                        inlineActionButton(
                            title: t(.deleteBox),
                            systemImage: "trash",
                            emphasized: false,
                            isDisabled: viewModel.selectedDetectionID == nil
                        ) {
                            viewModel.removeSelectedDetection()
                        }
                    }
                }
            }
        }
    }

    private func stagePreview(for item: BatchProcessingItem, height: CGFloat) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(Color.white.opacity(0.72))

            if previewMode == .original {
                EditorCanvasView(
                    image: item.sourceImage,
                    detections: item.detections,
                    selectedDetectionID: viewModel.selectedDetectionID,
                    language: viewModel.appLanguage,
                    onSelect: viewModel.selectDetection(_:),
                    onRectChange: viewModel.updateDetection(id:normalizedRect:),
                    onRectCommit: viewModel.commitDetection(id:normalizedRect:)
                )
                .padding(8)
            } else {
                Image(uiImage: item.displayImage)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(10)
            }
        }
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(Color.white.opacity(0.95), lineWidth: 1)
        )
    }

    private func emptyStage(height: CGFloat) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(Color.white.opacity(0.72))

            VStack(spacing: 18) {
                Image(systemName: "car.rear.and.tire.marks")
                    .font(.system(size: 48, weight: .regular))
                    .foregroundStyle(accentBlue)

                VStack(spacing: 8) {
                    Text(t(.emptyHeroBody))
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(textPrimary)
                        .multilineTextAlignment(.center)

                    Text(t(.emptyHeroHint))
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(textSecondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: 280)
            }
            .padding(24)
        }
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(Color.white.opacity(0.95), lineWidth: 1)
        )
    }

    private var commandSection: some View {
        AppleGlassCard(cornerRadius: 30, padding: 18) {
            VStack(alignment: .leading, spacing: 14) {
                Text(t(.actionsTitle))
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(textPrimary)

                LazyVGrid(columns: actionColumns, spacing: 10) {
                    PhotosPicker(selection: $selectedPhotoItems, maxSelectionCount: 30, matching: .images) {
                        commandTile(
                            title: t(.importPhotos),
                            systemImage: "photo.on.rectangle.angled",
                            tint: accentBlue
                        )
                    }
                    .buttonStyle(.plain)

                    commandTileButton(
                        title: t(.testSamples),
                        systemImage: "photo.stack",
                        tint: accentBlue
                    ) {
                        isSampleLibraryPresented = true
                    }

                    commandTileButton(
                        title: t(.capture),
                        systemImage: "camera.fill",
                        tint: accentBlue,
                        isDisabled: !viewModel.canUseCamera
                    ) {
                        isCameraPresented = true
                    }

                    commandTileButton(
                        title: t(.detectCurrent),
                        systemImage: "viewfinder.circle",
                        tint: accentBlue,
                        isDisabled: viewModel.selectedItem == nil
                    ) {
                        Task {
                            await viewModel.runAutoDetectionOnSelected()
                        }
                    }

                    commandTileButton(
                        title: t(.detectAll),
                        systemImage: "square.stack.3d.down.right.fill",
                        tint: accentBlue,
                        isDisabled: !viewModel.hasItems
                    ) {
                        Task {
                            await viewModel.runAutoDetectionOnAll()
                        }
                    }

                    commandTileButton(
                        title: t(.settings),
                        systemImage: "slider.horizontal.3",
                        tint: accentBlue
                    ) {
                        isSettingsPresented = true
                    }
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text(t(.redactionStyleTitle))
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(textSecondary)

                    LazyVGrid(columns: styleColumns, spacing: 10) {
                        ForEach(PlateRedactionStyle.allCases) { style in
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    viewModel.redactionStyle = style
                                    previewMode = .redacted
                                }
                            } label: {
                                Text(style.title(in: viewModel.appLanguage))
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(viewModel.redactionStyle == style ? .white : textPrimary)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 11)
                                    .background(
                                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                                            .fill(viewModel.redactionStyle == style ? accentBlue : Color.white.opacity(0.76))
                                    )
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                                            .stroke(borderColor, lineWidth: viewModel.redactionStyle == style ? 0 : 1)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private var queueSection: some View {
        AppleGlassCard(cornerRadius: 30, padding: 18) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(t(.queueTitle))
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(textPrimary)

                    Spacer(minLength: 0)

                    Text(viewModel.batchSummary)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(textSecondary)
                }

                if viewModel.items.isEmpty {
                    Text(t(.queueEmpty))
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .background(
                            RoundedRectangle(cornerRadius: 22, style: .continuous)
                                .fill(Color.white.opacity(0.62))
                        )
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(viewModel.items) { item in
                                queueCard(for: item)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
    }

    private func bottomToolbar(bottomInset: CGFloat) -> some View {
        HStack(spacing: 12) {
            toolbarMenu(
                title: t(.saveMenu),
                systemImage: "square.and.arrow.down",
                isDisabled: !viewModel.selectedItemCanExport && !viewModel.hasExportableItems
            ) {
                Button(t(.saveCurrent), systemImage: "square.and.arrow.down") {
                    isSaveDialogPresented = true
                }
                .disabled(!viewModel.selectedItemCanExport)

                Button(t(.saveAll), systemImage: "tray.and.arrow.down") {
                    Task {
                        await viewModel.saveAllAsNew()
                    }
                }
                .disabled(!viewModel.hasExportableItems)
            }

            toolbarMenu(
                title: t(.shareMenu),
                systemImage: "square.and.arrow.up",
                isDisabled: !viewModel.selectedItemCanExport && !viewModel.hasExportableItems
            ) {
                Button(t(.shareCurrent), systemImage: "square.and.arrow.up") {
                    viewModel.prepareShareSelected()
                }
                .disabled(!viewModel.selectedItemCanExport)

                Button(t(.shareAll), systemImage: "square.on.square") {
                    viewModel.prepareShareAll()
                }
                .disabled(!viewModel.hasExportableItems)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            Capsule(style: .continuous)
                .fill(Color.white.opacity(0.72))
                .background(.ultraThinMaterial, in: Capsule(style: .continuous))
        )
        .overlay(
            Capsule(style: .continuous)
                .stroke(Color.white.opacity(0.95), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.10), radius: 24, y: 10)
        .padding(.horizontal, 20)
        .padding(.bottom, max(bottomInset, 10))
    }

    private var previewModePicker: some View {
        HStack(spacing: 6) {
            ForEach(PreviewMode.allCases) { mode in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        previewMode = mode
                    }
                } label: {
                    Text(mode.title(in: viewModel.appLanguage))
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(previewMode == mode ? .white : textPrimary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(
                            Capsule(style: .continuous)
                                .fill(previewMode == mode ? accentBlue : Color.white.opacity(0.76))
                        )
                        .overlay(
                            Capsule(style: .continuous)
                                .stroke(borderColor, lineWidth: previewMode == mode ? 0 : 1)
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var stageSubtitle: String {
        if let item = viewModel.selectedItem {
            return item.state.title(in: viewModel.appLanguage)
        }
        return t(.emptyHeroHint)
    }

    private func toolbarIconButton(systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(textPrimary)
                .frame(width: 44, height: 44)
                .background(
                    Circle()
                        .fill(Color.white.opacity(0.72))
                        .background(.ultraThinMaterial, in: Circle())
                )
                .overlay(
                    Circle()
                        .stroke(Color.white.opacity(0.92), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }

    private func infoChip(title: String, tint: Color, foreground: Color) -> some View {
        Text(title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                Capsule(style: .continuous)
                    .fill(tint)
            )
    }

    private func inlineActionButton(
        title: String,
        systemImage: String,
        emphasized: Bool,
        isDisabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(emphasized ? Color.white : textPrimary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(emphasized ? accentBlue : Color.white.opacity(0.72))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(borderColor, lineWidth: emphasized ? 0 : 1)
                )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.45 : 1)
    }

    private func commandTile(
        title: String,
        systemImage: String,
        tint: Color
    ) -> some View {
        VStack(spacing: 8) {
            ZStack {
                Circle()
                    .fill(tint.opacity(0.12))
                    .frame(width: 38, height: 38)

                Image(systemName: systemImage)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(tint)
            }

            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
                .allowsTightening(true)
        }
        .frame(maxWidth: .infinity, minHeight: 92)
        .padding(.horizontal, 8)
        .padding(.vertical, 14)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color.white.opacity(0.68))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(borderColor, lineWidth: 1)
        )
    }

    private func commandTileButton(
        title: String,
        systemImage: String,
        tint: Color,
        isDisabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            commandTile(title: title, systemImage: systemImage, tint: tint)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.45 : 1)
    }

    private func queueCard(for item: BatchProcessingItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                viewModel.selectItem(item.id)
            } label: {
                VStack(alignment: .leading, spacing: 10) {
                    Image(uiImage: item.displayImage)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 148, height: 92)
                        .clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))

                    Text(item.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(textPrimary)
                        .lineLimit(1)

                    Text(item.state.title(in: viewModel.appLanguage))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(textSecondary)

                    Text(item.statusMessage)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(textSecondary)
                        .lineLimit(2)
                }
            }
            .buttonStyle(.plain)

            HStack(spacing: 10) {
                if item.state == .failed {
                    smallCardButton(systemImage: "arrow.clockwise") {
                        Task {
                            await viewModel.retryItem(item.id)
                        }
                    }
                }

                smallCardButton(systemImage: "xmark", destructive: true) {
                    viewModel.removeItem(item.id)
                }
            }
        }
        .padding(14)
        .frame(width: 174, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(viewModel.selectedItemID == item.id ? accentBlue.opacity(0.08) : Color.white.opacity(0.72))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(viewModel.selectedItemID == item.id ? accentBlue.opacity(0.40) : borderColor, lineWidth: 1)
        )
    }

    private func smallCardButton(systemImage: String, destructive: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(destructive ? Color.red.opacity(0.85) : accentBlue)
                .frame(width: 32, height: 32)
                .background(
                    Circle()
                        .fill(Color.white.opacity(0.86))
                )
        }
        .buttonStyle(.plain)
    }

    private func toolbarMenu<Content: View>(
        title: String,
        systemImage: String,
        isDisabled: Bool,
        @ViewBuilder content: () -> Content
    ) -> some View {
        Menu {
            content()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .semibold))
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .foregroundStyle(isDisabled ? textSecondary.opacity(0.8) : textPrimary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
        }
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.5 : 1)
    }

    private func loadSelections(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }

        var payloads: [ImportedImagePayload] = []

        for (index, item) in items.enumerated() {
            do {
                guard let data = try await item.loadTransferable(type: Data.self),
                      let image = UIImage(data: data) else {
                    continue
                }

                let defaultName = "\(t(.importPhotos)) \(viewModel.items.count + index + 1)"
                let suggestedName = assetName(for: item) ?? defaultName
                payloads.append(
                    ImportedImagePayload(
                        image: image,
                        suggestedName: suggestedName,
                        sourceAssetIdentifier: item.itemIdentifier
                    )
                )
            } catch {
                viewModel.statusMessage = AppText.text(
                    .loadedOnePhotoFailed,
                    language: viewModel.appLanguage,
                    error.localizedDescription
                )
            }
        }

        selectedPhotoItems = []
        await viewModel.importPayloads(payloads)
    }

    private func assetName(for item: PhotosPickerItem) -> String? {
        guard let identifier = item.itemIdentifier,
              let asset = PHAsset.fetchAssets(withLocalIdentifiers: [identifier], options: nil).firstObject else {
            return nil
        }

        return PHAssetResource.assetResources(for: asset).first?.originalFilename
    }

    private func t(_ key: AppCopy, _ arguments: CVarArg...) -> String {
        AppText.text(key, language: viewModel.appLanguage, arguments: arguments)
    }
}

private struct SettingsSheet: View {
    @ObservedObject var viewModel: PlateBlurViewModel
    @Environment(\.dismiss) private var dismiss

    private let accentBlue = Color(red: 0.0, green: 0.443, blue: 0.89)
    private let backgroundGray = Color(red: 0.96, green: 0.96, blue: 0.97)
    private let textPrimary = Color(red: 0.114, green: 0.114, blue: 0.121)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    settingsCard(title: text(.languageTitle), subtitle: text(.languageDescription)) {
                        VStack(spacing: 12) {
                            ForEach(AppLanguage.allCases) { language in
                                Button {
                                    viewModel.appLanguage = language
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(language.displayName(in: viewModel.appLanguage))
                                                .font(.system(size: 16, weight: .semibold))
                                                .foregroundStyle(textPrimary)
                                            Text(language.rawValue)
                                                .font(.system(size: 12, weight: .medium))
                                                .foregroundStyle(.secondary)
                                        }

                                        Spacer(minLength: 0)

                                        if viewModel.appLanguage == language {
                                            Image(systemName: "checkmark.circle.fill")
                                                .foregroundStyle(accentBlue)
                                        }
                                    }
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 12)
                                    .background(
                                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                                            .fill(viewModel.appLanguage == language ? accentBlue.opacity(0.10) : Color.white.opacity(0.70))
                                    )
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                                            .stroke(Color.black.opacity(0.08), lineWidth: 1)
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    settingsCard(title: text(.enhancedRecognitionTitle), subtitle: text(.enhancedRecognitionDescription)) {
                        Toggle(text(.enhancedRecognitionEnabled), isOn: $viewModel.enhancedRecognitionEnabled)
                            .tint(accentBlue)
                    }

                    settingsCard(title: text(.redactionStyleTitle), subtitle: nil) {
                        Picker(text(.redactionStyleTitle), selection: $viewModel.redactionStyle) {
                            ForEach(PlateRedactionStyle.allCases) { style in
                                Text(style.title(in: viewModel.appLanguage)).tag(style)
                            }
                        }
                        .pickerStyle(.segmented)

                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(text(.paddingTitle))
                                Spacer()
                                Text("\(Int(viewModel.expansionAmount * 100))%")
                                    .foregroundStyle(.secondary)
                            }
                            Slider(value: $viewModel.expansionAmount, in: 0 ... 0.35)
                        }
                    }

                    settingsCard(title: text(.exportFormatTitle), subtitle: nil) {
                        Picker(text(.exportFormatTitle), selection: $viewModel.exportFormat) {
                            ForEach(ExportFormat.allCases) { format in
                                Text(format.title(in: viewModel.appLanguage)).tag(format)
                            }
                        }
                        .pickerStyle(.segmented)

                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(text(.jpegQualityTitle))
                                Spacer()
                                Text("\(Int(viewModel.exportQuality * 100))%")
                                    .foregroundStyle(.secondary)
                            }
                            Slider(value: $viewModel.exportQuality, in: 0.5 ... 1.0)
                                .disabled(viewModel.exportFormat == .png)
                        }
                    }

                    settingsCard(title: text(.settingsTitle), subtitle: text(.settingsSubtitle)) {
                        Toggle(text(.autoDetectAfterImport), isOn: $viewModel.autoDetectAfterImport)
                        Toggle(text(.autoSaveAfterProcessing), isOn: $viewModel.autoSaveAfterProcessing)
                        Toggle(text(.includeOriginalWhenSharing), isOn: $viewModel.includeOriginalWhenSharing)
                    }

                    settingsCard(title: text(.plateRegionsTitle), subtitle: text(.plateRegionsDescription)) {
                        HStack(spacing: 10) {
                            ForEach(SupportedPlateRegion.allCases) { region in
                                Button {
                                    viewModel.toggleRegion(region)
                                } label: {
                                    VStack(spacing: 4) {
                                        Text(region.shortTitle)
                                            .font(.system(size: 16, weight: .semibold))
                                        Text(region.title(in: viewModel.appLanguage))
                                            .font(.system(size: 12, weight: .medium))
                                    }
                                    .foregroundStyle(viewModel.enabledRegions.contains(region) ? Color.white : textPrimary)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 12)
                                    .frame(maxWidth: .infinity)
                                    .background(
                                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                                            .fill(viewModel.enabledRegions.contains(region) ? accentBlue : Color.white.opacity(0.72))
                                    )
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                                            .stroke(Color.black.opacity(0.08), lineWidth: viewModel.enabledRegions.contains(region) ? 0 : 1)
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(backgroundGray)
            .navigationTitle(text(.settingsTitle))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(text(.close)) {
                        dismiss()
                    }
                }
            }
        }
    }

    private func settingsCard<Content: View>(title: String, subtitle: String?, @ViewBuilder content: @escaping () -> Content) -> some View {
        AppleGlassCard(cornerRadius: 28, padding: 18) {
            VStack(alignment: .leading, spacing: 14) {
                Text(title)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(textPrimary)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                content()
            }
        }
    }

    private func text(_ key: AppCopy, _ arguments: CVarArg...) -> String {
        AppText.text(key, language: viewModel.appLanguage, arguments: arguments)
    }
}

private struct SampleLibraryView: View {
    let language: AppLanguage
    let onImport: (ImportedImagePayload) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedID: String?

    private let samples = SamplePhotoLibrary.load()
    private let backgroundGray = Color(red: 0.96, green: 0.96, blue: 0.97)
    private let accentBlue = Color(red: 0.0, green: 0.443, blue: 0.89)

    private let columns = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    AppleGlassCard(cornerRadius: 28, padding: 18) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(AppText.text(.testLibraryTitle, language: language))
                                .font(.system(size: 22, weight: .semibold))
                            Text(AppText.text(.testLibrarySubtitle, language: language))
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let sample = selectedSample {
                        AppleGlassCard(cornerRadius: 28, padding: 16) {
                            VStack(alignment: .leading, spacing: 12) {
                                Image(uiImage: sample.image)
                                    .resizable()
                                    .scaledToFit()
                                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))

                                Text(sample.title(in: language))
                                    .font(.system(size: 20, weight: .semibold))

                                Text(sample.subtitle(in: language))
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    } else if samples.isEmpty {
                        Text(AppText.text(.sampleEmpty, language: language))
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(.secondary)
                    }

                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(samples) { sample in
                            Button {
                                selectedID = sample.id
                            } label: {
                                VStack(alignment: .leading, spacing: 10) {
                                    Image(uiImage: sample.image)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(height: 110)
                                        .frame(maxWidth: .infinity)
                                        .clipped()
                                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))

                                    Text(sample.title(in: language))
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)

                                    Text(sample.subtitle(in: language))
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                                .padding(12)
                                .background(
                                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                                        .fill(selectedID == sample.id ? accentBlue.opacity(0.10) : Color.white.opacity(0.72))
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                                        .stroke(selectedID == sample.id ? accentBlue.opacity(0.35) : Color.black.opacity(0.08), lineWidth: 1)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(20)
                .padding(.bottom, 96)
            }
            .background(backgroundGray)
            .navigationTitle(AppText.text(.testLibraryTitle, language: language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(AppText.text(.close, language: language)) {
                        dismiss()
                    }
                }
            }
            .overlay(alignment: .bottom) {
                if let sample = selectedSample {
                    Button {
                        onImport(sample.payload)
                        dismiss()
                    } label: {
                        Text(AppText.text(.importSample, language: language))
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 16)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(accentBlue)
                            )
                            .padding(.horizontal, 20)
                            .padding(.bottom, 14)
                    }
                    .buttonStyle(.plain)
                    .background(.clear)
                }
            }
            .onAppear {
                if selectedID == nil {
                    selectedID = samples.first?.id
                }
            }
        }
    }

    private var selectedSample: SamplePhoto? {
        if let selectedID,
           let selected = samples.first(where: { $0.id == selectedID }) {
            return selected
        }
        return samples.first
    }
}

private struct AppleGlassCard<Content: View>: View {
    let cornerRadius: CGFloat
    let padding: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .background(
                ZStack {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(.ultraThinMaterial)
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(Color.white.opacity(0.72))
                }
            )
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(Color.white.opacity(0.96), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.08), radius: 24, y: 10)
    }
}

#Preview {
    ContentView()
}
