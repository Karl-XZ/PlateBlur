# PlateBlur

PlateBlur is a combined iPhone + Web project for vehicle-photo and vehicle-video license plate redaction.

Current app features:

- Capture a vehicle photo with the iPhone camera
- Import one or many photos from the photo library
- Run a local on-device detection pipeline for Germany, Netherlands, and Switzerland
- Bundle a general Core ML detector named `LicensePlateDetector`
- Bundle an enhanced small-object Core ML detector named `LicensePlateDetectorSwiss`
- Fall back to OCR plate-pattern matching and rectangle candidates when the model misses
- Auto-redact all detected plates with solid, mosaic, or blurred styles
- Show before/after previews and the current detection source
- Add, move, resize, and delete manual plate boxes
- Process a batch queue with per-image status and retry actions
- Save as a new photo, or overwrite the imported original after confirmation when available
- Share one or many processed results to chat apps, mail, or Files
- Block save/share when a photo has no active redaction box, so unredacted originals are not exported by mistake

Current web features:

- Upload one or many images in the browser and auto-generate editable plate candidate boxes
- Open a built-in sample library with bundled road-scene photos and a ready-made rear-plate video clip
- Apply blur, mosaic, solid block, or brand watermark styles directly on canvas
- Batch process images and download the current image or the whole batch
- Upload videos, detect the current frame, add manual track points, and interpolate a time-based track
- Process videos frame by frame in-browser with a visible progress bar and export a WebM result
- Persist settings and processing history locally in the browser with download/delete actions

## Open In Xcode

Open:

- `PlateBlur/PlateBlur.xcodeproj`
- `PlateBlur/web/index.html` for the browser workstation

## Open The Web Workstation

The web version lives in:

- `PlateBlur/web`

Because it is a static browser app, open it with a local HTTP server instead of double-clicking the HTML file.

Example:

1. `cd /Users/applemima111/Desktop/car/PlateBlur/web`
2. `python3 -m http.server 4174`
3. Open `http://127.0.0.1:4174`

## Model Integration

The project now ships with compiled detectors at:

- `PlateBlur/PlateBlur/LicensePlateDetector.mlmodelc`
- `PlateBlur/PlateBlur/LicensePlateDetectorSwiss.mlmodelc`

To refresh or replace it with a new export:

1. Activate the local evaluation environment: `source /Users/applemima111/Desktop/car/.venv/bin/activate`
2. Run: `python /Users/applemima111/Desktop/car/PlateBlur/tools/export_license_plate_model.py`
3. Rebuild the Xcode project.

The runtime lookup and detector orchestration live in:

- `PlateBlur/CoreMLPlateDetector.swift`
- `PlateBlur/TextPlateDetector.swift`
- `PlateBlur/PlateDetectorPipeline.swift`

## Detection Strategy

1. Run the bundled general Core ML detector for broad plate coverage.
2. When enhanced recognition is enabled, also run the small-object detector and merge the boxes.
3. Run Vision text recognition and match country-specific plate patterns.
4. Fall back to rectangle candidates if the first three stages find nothing.
5. Let the user fix misses with manual boxes before export.

## Validation

- Open `/Users/applemima111/Desktop/car/PlateBlur/PlateBlur.xcodeproj` in Xcode.
- The latest simulator build was verified with `xcodebuild` against the `PlateBlur` scheme.
- Requirement coverage is tracked in `/Users/applemima111/Desktop/car/PlateBlur/REQUIREMENTS_AUDIT.md`.
- Measured accuracy is tracked in `/Users/applemima111/Desktop/car/PlateBlur/EVALUATION_REPORT.md`.
- Switzerland upgrade comparisons are tracked in `/Users/applemima111/Desktop/car/PlateBlur/SWISS_UPGRADE_REPORT.md`.
- The current algorithm walkthrough is tracked in `/Users/applemima111/Desktop/car/PlateBlur/CURRENT_PLATE_ALGORITHM.md`.

## Evaluation Scripts

- Download the public test datasets: `python /Users/applemima111/Desktop/car/PlateBlur/tools/download_eval_datasets.py`
- Re-export and compile a bundled model: `python /Users/applemima111/Desktop/car/PlateBlur/tools/export_license_plate_model.py`
- Build the Swiss/DE-CH focused subset dataset: `python /Users/applemima111/Desktop/car/PlateBlur/tools/build_focus_tile_dataset.py`
- Prepare the full tiled PP4AV training dataset: `python /Users/applemima111/Desktop/car/PlateBlur/tools/prepare_pp4av_plate_dataset.py`
- Fine-tune and export a detector: `python /Users/applemima111/Desktop/car/PlateBlur/tools/train_plate_detector.py`
- Re-run the published metrics: `python /Users/applemima111/Desktop/car/PlateBlur/tools/evaluate_plate_detector.py`

## Current Measured Results

- Switzerland-tuned model on the Swiss holdout (`75` images) with hybrid tiled inference at threshold `0.20`: `Recall@IoU0.50 = 0.8158`, `F1@IoU0.50 = 0.6703`
- App-style routed union on the Swiss holdout (`75` images): `Recall@IoU0.50 = 0.8421`, `F1@IoU0.50 = 0.6531`
- The baseline general model with hybrid tiled inference on the Swiss holdout (`75` images): `Recall@IoU0.50 = 0.3421`, `F1@IoU0.50 = 0.4602`

## Known Limits

- The enhanced small-object model should complement the general detector, not replace it globally.
- The OCR and rectangle fallbacks are recovery paths, not substitutes for tuned detectors on hard long-tail scenes.
