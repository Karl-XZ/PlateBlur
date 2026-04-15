# PlateBlur

PlateBlur is an iPhone-first SwiftUI app for vehicle-photo license plate redaction.

Current app features:

- Capture a vehicle photo with the iPhone camera
- Import one or many photos from the photo library
- Run a local on-device detection pipeline for Germany, Netherlands, and Switzerland
- Bundle a Core ML detector named `LicensePlateDetector`
- Fall back to OCR plate-pattern matching and rectangle candidates when the model misses
- Auto-redact all detected plates with solid, mosaic, or blurred styles
- Show before/after previews and the current detection source
- Add, move, resize, and delete manual plate boxes
- Process a batch queue with per-image status and retry actions
- Save as a new photo, or overwrite the imported original after confirmation when available
- Share one or many processed results to chat apps, mail, or Files
- Block save/share when a photo has no active redaction box, so unredacted originals are not exported by mistake

## Open In Xcode

Open:

- `PlateBlur/PlateBlur.xcodeproj`

## Model Integration

The project now ships with a compiled detector at:

- `PlateBlur/PlateBlur/LicensePlateDetector.mlmodelc`

To refresh or replace it with a new export:

1. Activate the local evaluation environment: `source /Users/applemima111/Desktop/car/.venv-plate/bin/activate`
2. Run: `python /Users/applemima111/Desktop/car/PlateBlur/tools/export_license_plate_model.py`
3. Rebuild the Xcode project.

The runtime lookup and detector orchestration live in:

- `PlateBlur/CoreMLPlateDetector.swift`
- `PlateBlur/TextPlateDetector.swift`
- `PlateBlur/PlateDetectorPipeline.swift`

## Detection Strategy

1. Try a bundled Core ML detector first.
2. Run Vision text recognition and match country-specific plate patterns.
3. Fall back to rectangle candidates if the first two stages find nothing.
4. Let the user fix misses with manual boxes before export.

## Validation

- Open `/Users/applemima111/Desktop/car/PlateBlur/PlateBlur.xcodeproj` in Xcode.
- The latest simulator build was verified with `xcodebuild` against the `PlateBlur` scheme.
- Requirement coverage is tracked in `/Users/applemima111/Desktop/car/PlateBlur/REQUIREMENTS_AUDIT.md`.
- Measured accuracy is tracked in `/Users/applemima111/Desktop/car/PlateBlur/EVALUATION_REPORT.md`.

## Evaluation Scripts

- Download the public test datasets: `python /Users/applemima111/Desktop/car/PlateBlur/tools/download_eval_datasets.py`
- Re-export and compile the bundled model: `python /Users/applemima111/Desktop/car/PlateBlur/tools/export_license_plate_model.py`
- Re-run the published metrics: `python /Users/applemima111/Desktop/car/PlateBlur/tools/evaluate_plate_detector.py`

## Current Measured Results

- Keremberke public test set (`882` images): `AP@0.50 = 0.6433`, `AP@[0.50:0.95] = 0.3140`, `F1@IoU0.50 = 0.7409`
- Core ML evaluation latency on the local Apple Silicon machine: `7.97 ms` average, `10.46 ms` p95 per image
- Country crop smoke tests: Germany `100%` hit rate on `10` images, Netherlands `80%` hit rate on `10` images

## Known Limits

- Switzerland-specific public test data is still missing from the local evaluation bundle, so the shipped report does not yet contain a Swiss holdout metric.
- The OCR and rectangle fallbacks are recovery paths, not substitutes for a tuned detector on hard long-tail scenes.
