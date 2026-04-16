# PlateBlur Evaluation Report

- Model: `/Users/applemima111/Desktop/car/models/koushim/best.mlpackage`
- Dataset: `/Users/applemima111/Desktop/car/eval_data/keremberke/test`
- Confidence threshold: `0.1`
- IoU threshold: `0.45`
- Inference mode: `hybrid`
- Tile size: `640`
- Tile overlap: `0.4`
- Tile confidence threshold: `0.1`

## COCO Detection Metrics

- Images evaluated: `882`
- `AP@[0.50:0.95]`: `0.3339`
- `AP@0.50`: `0.7104`
- `AP@0.75`: `0.3041`
- `AR@100`: `0.4133`
- `Precision@IoU0.50`: `0.6581`
- `Recall@IoU0.50`: `0.7639`
- `F1@IoU0.50`: `0.7070`
- Image recall@IoU0.50: `0.7778`
- Average latency per image: `16.63 ms`
- P95 latency per image: `26.39 ms`
- Images with no predictions: `129`

## Scene-Level Public Validation Sets

These subsets keep full driving-scene context, so they are better indicators of real-world anonymization performance than cropped-plate smoke tests.

### PP4AV Switzerland Holdout

- Images evaluated: `75`
- `AP@[0.50:0.95]`: `0.0984`
- `AP@0.50`: `0.3120`
- `AP@0.75`: `0.0137`
- `AR@100`: `0.1276`
- `Precision@IoU0.50`: `0.7027`
- `Recall@IoU0.50`: `0.3421`
- `F1@IoU0.50`: `0.4602`
- Image recall@IoU0.50: `0.3467`
- Average latency per image: `45.95 ms`
- P95 latency per image: `62.85 ms`
- Images with no predictions: `42`

## Country Crop Smoke Tests

These small public datasets are cropped plate photos, so they are useful as region-support smoke tests, not as full-scene detection benchmarks.

### Germany

- Images: `10`
- Detector hit rate: `1.0000`
- Average top score: `0.9591`

### Netherlands

- Images: `10`
- Detector hit rate: `1.0000`
- Average top score: `0.7409`
