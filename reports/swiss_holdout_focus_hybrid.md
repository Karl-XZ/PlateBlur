# PlateBlur Evaluation Report

- Model: `/Users/applemima111/Desktop/car/models/plateblur_training/pp4av_focus_de_ch/weights/best.mlpackage`
- Dataset: `/Users/applemima111/Desktop/car/eval_data/keremberke/test`
- Confidence threshold: `0.1`
- IoU threshold: `0.45`
- Inference mode: `hybrid`
- Tile size: `640`
- Tile overlap: `0.4`
- Tile confidence threshold: `0.1`

## COCO Detection Metrics

- Images evaluated: `882`
- `AP@[0.50:0.95]`: `0.1609`
- `AP@0.50`: `0.3078`
- `AP@0.75`: `0.1332`
- `AR@100`: `0.2092`
- `Precision@IoU0.50`: `0.6681`
- `Recall@IoU0.50`: `0.3415`
- `F1@IoU0.50`: `0.4519`
- Image recall@IoU0.50: `0.3447`
- Average latency per image: `15.22 ms`
- P95 latency per image: `24.01 ms`
- Images with no predictions: `525`

## Scene-Level Public Validation Sets

These subsets keep full driving-scene context, so they are better indicators of real-world anonymization performance than cropped-plate smoke tests.

### PP4AV Switzerland Holdout

- Images evaluated: `75`
- `AP@[0.50:0.95]`: `0.1691`
- `AP@0.50`: `0.6206`
- `AP@0.75`: `0.0204`
- `AR@100`: `0.3000`
- `Precision@IoU0.50`: `0.3168`
- `Recall@IoU0.50`: `0.8421`
- `F1@IoU0.50`: `0.4604`
- Image recall@IoU0.50: `0.8533`
- Average latency per image: `40.55 ms`
- P95 latency per image: `51.80 ms`
- Images with no predictions: `0`

## Country Crop Smoke Tests

These small public datasets are cropped plate photos, so they are useful as region-support smoke tests, not as full-scene detection benchmarks.

### Germany

- Images: `10`
- Detector hit rate: `0.9000`
- Average top score: `0.4430`

### Netherlands

- Images: `10`
- Detector hit rate: `0.9000`
- Average top score: `0.2262`
