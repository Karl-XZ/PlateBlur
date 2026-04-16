# PlateBlur Evaluation Report

- Model: `/Users/applemima111/Desktop/car/models/koushim/best.mlpackage`
- Dataset: `/Users/applemima111/Desktop/car/eval_data/keremberke/test`
- Confidence threshold: `0.25`
- IoU threshold: `0.45`
- Inference mode: `plain`
- Tile size: `640`
- Tile overlap: `0.4`
- Tile confidence threshold: `0.25`

## COCO Detection Metrics

- Images evaluated: `882`
- `AP@[0.50:0.95]`: `0.3140`
- `AP@0.50`: `0.6433`
- `AP@0.75`: `0.2929`
- `AR@100`: `0.3773`
- `Precision@IoU0.50`: `0.8326`
- `Recall@IoU0.50`: `0.6674`
- `F1@IoU0.50`: `0.7409`
- Image recall@IoU0.50: `0.6814`
- Average latency per image: `7.32 ms`
- P95 latency per image: `9.39 ms`
- Images with no predictions: `234`

## Scene-Level Public Validation Sets

These subsets keep full driving-scene context, so they are better indicators of real-world anonymization performance than cropped-plate smoke tests.

### PP4AV Switzerland Holdout

- Images evaluated: `75`
- `AP@[0.50:0.95]`: `0.0000`
- `AP@0.50`: `0.0000`
- `AP@0.75`: `0.0000`
- `AR@100`: `0.0000`
- `Precision@IoU0.50`: `0.0000`
- `Recall@IoU0.50`: `0.0000`
- `F1@IoU0.50`: `0.0000`
- Image recall@IoU0.50: `0.0000`
- Average latency per image: `13.20 ms`
- P95 latency per image: `14.38 ms`
- Images with no predictions: `75`

## Country Crop Smoke Tests

These small public datasets are cropped plate photos, so they are useful as region-support smoke tests, not as full-scene detection benchmarks.

### Germany

- Images: `10`
- Detector hit rate: `1.0000`
- Average top score: `0.9013`

### Netherlands

- Images: `10`
- Detector hit rate: `0.8000`
- Average top score: `0.4894`
