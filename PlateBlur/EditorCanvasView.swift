import SwiftUI
import UIKit

struct EditorCanvasView: View {
    let image: UIImage
    let detections: [PlateDetection]
    let selectedDetectionID: UUID?
    let language: AppLanguage
    let onSelect: (UUID?) -> Void
    let onRectChange: (UUID, CGRect) -> Void
    let onRectCommit: (UUID, CGRect) -> Void

    var body: some View {
        GeometryReader { geometry in
            let layout = ImageLayout(containerSize: geometry.size, imageSize: image.size)

            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 24)
                    .fill(Color.black.opacity(0.14))

                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .clipShape(RoundedRectangle(cornerRadius: 24))

                ForEach(detections) { detection in
                    DetectionOverlay(
                        detection: detection,
                        isSelected: selectedDetectionID == detection.id,
                        language: language,
                        layout: layout,
                        onSelect: {
                            onSelect(detection.id)
                        },
                        onRectChange: { rect in
                            onRectChange(detection.id, rect)
                        },
                        onRectCommit: { rect in
                            onRectCommit(detection.id, rect)
                        }
                    )
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                onSelect(nil)
            }
        }
        .aspectRatio(image.size, contentMode: .fit)
    }
}

private struct DetectionOverlay: View {
    let detection: PlateDetection
    let isSelected: Bool
    let language: AppLanguage
    let layout: ImageLayout
    let onSelect: () -> Void
    let onRectChange: (CGRect) -> Void
    let onRectCommit: (CGRect) -> Void

    @State private var dragOriginRect: CGRect?
    @State private var resizeOriginRect: CGRect?

    var body: some View {
        let displayRect = layout.displayRect(for: detection.normalizedRect)

        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 8)
                .stroke(isSelected ? Color.yellow : Color.red, lineWidth: isSelected ? 3 : 2)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill((isSelected ? Color.yellow : Color.red).opacity(0.14))
                )
                .frame(width: displayRect.width, height: displayRect.height)
                .position(x: displayRect.midX, y: displayRect.midY)
                .gesture(moveGesture(for: displayRect))
                .onTapGesture {
                    onSelect()
                }

            Text(labelText)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .background(Capsule().fill(Color.black.opacity(0.75)))
                .position(
                    x: min(displayRect.minX + 54, layout.imageRect.maxX - 54),
                    y: max(displayRect.minY - 12, layout.imageRect.minY + 12)
                )

            if isSelected {
                Circle()
                    .fill(Color.yellow)
                    .frame(width: 22, height: 22)
                    .overlay(
                        Circle()
                            .stroke(Color.black.opacity(0.35), lineWidth: 1)
                    )
                    .position(x: displayRect.maxX, y: displayRect.maxY)
                    .gesture(resizeGesture(for: displayRect))
            }
        }
    }

    private var labelText: String {
        let source = detection.source.title(in: language)
        let confidence = Int(detection.confidence * 100)
        return "\(source) \(confidence)%"
    }

    private func moveGesture(for displayRect: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 6)
            .onChanged { value in
                if dragOriginRect == nil {
                    dragOriginRect = displayRect
                    onSelect()
                }

                guard let dragOriginRect else { return }
                let updated = dragOriginRect.offsetBy(dx: value.translation.width, dy: value.translation.height)
                onRectChange(layout.normalizedRect(for: clampMove(updated)))
            }
            .onEnded { value in
                if let dragOriginRect {
                    let updated = dragOriginRect.offsetBy(dx: value.translation.width, dy: value.translation.height)
                    onRectCommit(layout.normalizedRect(for: clampMove(updated)))
                }
                dragOriginRect = nil
            }
    }

    private func resizeGesture(for displayRect: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 6)
            .onChanged { value in
                if resizeOriginRect == nil {
                    resizeOriginRect = displayRect
                }

                guard let resizeOriginRect else { return }
                let resized = CGRect(
                    x: resizeOriginRect.minX,
                    y: resizeOriginRect.minY,
                    width: max(32, resizeOriginRect.width + value.translation.width),
                    height: max(20, resizeOriginRect.height + value.translation.height)
                )
                onRectChange(layout.normalizedRect(for: clampResize(resized)))
            }
            .onEnded { value in
                if let resizeOriginRect {
                    let resized = CGRect(
                        x: resizeOriginRect.minX,
                        y: resizeOriginRect.minY,
                        width: max(32, resizeOriginRect.width + value.translation.width),
                        height: max(20, resizeOriginRect.height + value.translation.height)
                    )
                    onRectCommit(layout.normalizedRect(for: clampResize(resized)))
                }
                resizeOriginRect = nil
            }
    }

    private func clampMove(_ rect: CGRect) -> CGRect {
        let x = min(max(rect.minX, layout.imageRect.minX), layout.imageRect.maxX - rect.width)
        let y = min(max(rect.minY, layout.imageRect.minY), layout.imageRect.maxY - rect.height)
        return CGRect(x: x, y: y, width: rect.width, height: rect.height)
    }

    private func clampResize(_ rect: CGRect) -> CGRect {
        let maxWidth = layout.imageRect.maxX - rect.minX
        let maxHeight = layout.imageRect.maxY - rect.minY
        return CGRect(
            x: rect.minX,
            y: rect.minY,
            width: min(rect.width, maxWidth),
            height: min(rect.height, maxHeight)
        )
    }
}

private struct ImageLayout {
    let imageRect: CGRect

    init(containerSize: CGSize, imageSize: CGSize) {
        let scale = min(containerSize.width / max(imageSize.width, 1), containerSize.height / max(imageSize.height, 1))
        let fittedSize = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        imageRect = CGRect(
            x: (containerSize.width - fittedSize.width) / 2,
            y: (containerSize.height - fittedSize.height) / 2,
            width: fittedSize.width,
            height: fittedSize.height
        )
    }

    func displayRect(for normalizedRect: CGRect) -> CGRect {
        CGRect(
            x: imageRect.minX + normalizedRect.minX * imageRect.width,
            y: imageRect.minY + normalizedRect.minY * imageRect.height,
            width: normalizedRect.width * imageRect.width,
            height: normalizedRect.height * imageRect.height
        )
    }

    func normalizedRect(for displayRect: CGRect) -> CGRect {
        CGRect(
            x: (displayRect.minX - imageRect.minX) / imageRect.width,
            y: (displayRect.minY - imageRect.minY) / imageRect.height,
            width: displayRect.width / imageRect.width,
            height: displayRect.height / imageRect.height
        ).clampedToUnit()
    }
}
