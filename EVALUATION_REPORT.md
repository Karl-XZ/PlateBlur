# PlateBlur Evaluation Report

- Model: `/Users/applemima111/Desktop/car/models/koushim/best.mlpackage`
- Dataset: `/Users/applemima111/Desktop/car/eval_data/keremberke/test`
- Confidence threshold: `0.25`
- IoU threshold: `0.45`

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
- Average latency per image: `7.97 ms`
- P95 latency per image: `10.46 ms`
- Images with no predictions: `234`

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
