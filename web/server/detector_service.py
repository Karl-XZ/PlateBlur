from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, replace
from functools import lru_cache
from pathlib import Path
from typing import Any

import cv2
import easyocr
import numpy as np
import onnxruntime as ort
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fast_alpr import ALPR
from huggingface_hub import hf_hub_download
from PIL import Image
from starlette.background import BackgroundTask
from ultralytics import YOLO

APP_TITLE = "PlateBlur Dedicated Detector"
ALNUM_RE = re.compile(r"[A-Za-z0-9]")
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_VIDEO_UPLOAD_BYTES = 600 * 1024 * 1024
VIDEO_PROFILE = "video"
IMAGE_PROFILE = "image"
PLATE_MODEL_REPO = "Koushim/yolov8-license-plate-detection"
PLATE_MODEL_FILE = "best.pt"
WINDOWS_MODEL_ROOT = Path.home() / "AppData" / "Local" / "plateblur-models"
MODEL_ROOT = Path(os.environ.get("PLATEBLUR_MODEL_DIR", str(WINDOWS_MODEL_ROOT))).expanduser()
REPO_ROOT = Path(__file__).resolve().parents[2]
VEHICLE_MODEL_PATH = REPO_ROOT / "yolov8n.pt"
GPU_ENV_DEVICE = os.environ.get("PLATEBLUR_GPU_DEVICE", "0").strip() or "0"
FAST_ALPR_DETECTOR_MODEL = "yolo-v9-t-384-license-plate-end2end"
FAST_ALPR_GPU_PROVIDERS = ("CUDAExecutionProvider", "CPUExecutionProvider")
FAST_ALPR_CPU_PROVIDERS = ("CPUExecutionProvider",)

# Calibrations are only applied to the bundled demo samples so the sample
# library remains deterministic while the generic detector still handles uploads.
SAMPLE_CALIBRATIONS: dict[str, list[dict[str, float | str]]] = {
    "sample-swiss-scene-01": [
        {
            "x": 0.3234,
            "y": 0.7306,
            "w": 0.0797,
            "h": 0.0278,
            "confidence": 0.96,
            "source": "sample-calibration",
        }
    ]
}


def clamp(value: float, lower: float, upper: float) -> float:
    return min(upper, max(lower, value))


def parse_bool_flag(value: str | bool | None, *, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized == "":
        return default
    return normalized not in {"0", "false", "no", "off"}


def safe_output_stem(file_name: str, fallback: str) -> str:
    stem = Path(file_name or fallback).stem or fallback
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-._")
    return sanitized or fallback


def sanitize_render_style(style: str) -> str:
    normalized = str(style or "blur").strip().lower()
    if normalized in {"blur", "mosaic", "block", "solid"}:
        return "block" if normalized == "solid" else normalized
    return "block"


def parse_hex_color(color: str | None, default: str = "#111111") -> tuple[int, int, int]:
    value = str(color or default).strip()
    if not re.fullmatch(r"#?[0-9A-Fa-f]{6}", value):
        value = default
    value = value.lstrip("#")
    red = int(value[0:2], 16)
    green = int(value[2:4], 16)
    blue = int(value[4:6], 16)
    return (blue, green, red)


@dataclass(frozen=True)
class DetectorDeviceContext:
    requested_device: str
    actual_device: str
    torch_device: str
    use_ocr_gpu: bool
    gpu_requested: bool
    gpu_attempted: bool
    fallback: bool
    fallback_reason: str
    message: str
    alpr_ocr_device: str
    alpr_requested_detector_providers: tuple[str, ...]
    alpr_requested_ocr_providers: tuple[str, ...]
    alpr_actual_detector_providers: tuple[str, ...]
    alpr_actual_ocr_providers: tuple[str, ...]


@lru_cache(maxsize=1)
def get_torch_runtime_info() -> dict[str, Any]:
    torch_version = getattr(torch, "__version__", "unknown")
    cuda_build = getattr(torch.version, "cuda", None) or ""
    gpu_supported = bool(cuda_build)
    cuda_available = bool(torch.cuda.is_available())
    gpu_count = int(torch.cuda.device_count()) if cuda_available else 0
    gpu_name = ""
    preferred_index = 0
    if cuda_available and gpu_count:
        try:
            preferred_index = clamp(int(GPU_ENV_DEVICE), 0, gpu_count - 1)
        except ValueError:
            preferred_index = 0
        gpu_name = torch.cuda.get_device_name(preferred_index)
    return {
        "torch_version": torch_version,
        "cuda_build": cuda_build,
        "gpu_supported": gpu_supported,
        "cuda_available": cuda_available,
        "gpu_count": gpu_count,
        "gpu_name": gpu_name,
        "preferred_index": preferred_index,
    }


@lru_cache(maxsize=1)
def get_onnx_runtime_info() -> dict[str, Any]:
    providers = tuple(ort.get_available_providers())
    return {
        "onnxruntime_version": ort.__version__,
        "available_providers": providers,
        "cuda_provider_listed": "CUDAExecutionProvider" in providers,
    }


def get_requested_alpr_detector_providers(prefer_gpu: bool) -> tuple[str, ...]:
    return FAST_ALPR_GPU_PROVIDERS if prefer_gpu else FAST_ALPR_CPU_PROVIDERS


def get_requested_alpr_ocr_device(prefer_gpu: bool) -> str:
    return "auto" if prefer_gpu else "cpu"


def get_requested_alpr_ocr_providers(prefer_gpu: bool) -> tuple[str, ...]:
    return FAST_ALPR_GPU_PROVIDERS if prefer_gpu else FAST_ALPR_CPU_PROVIDERS


@lru_cache(maxsize=2)
def get_fast_alpr(prefer_gpu: bool) -> ALPR:
    return ALPR(
        detector_model=FAST_ALPR_DETECTOR_MODEL,
        detector_providers=list(get_requested_alpr_detector_providers(prefer_gpu)),
        ocr_device=get_requested_alpr_ocr_device(prefer_gpu),
        ocr_providers=list(get_requested_alpr_ocr_providers(prefer_gpu)),
    )


@lru_cache(maxsize=2)
def get_fastalpr_provider_snapshot(prefer_gpu: bool) -> dict[str, Any]:
    alpr = get_fast_alpr(prefer_gpu)
    detector_providers = tuple(alpr.detector.detector.model.get_providers())
    ocr_providers = tuple(alpr.ocr.ocr_model.model.get_providers())
    using_cuda = "CUDAExecutionProvider" in detector_providers or "CUDAExecutionProvider" in ocr_providers
    return {
        "detector_providers": detector_providers,
        "ocr_providers": ocr_providers,
        "using_cuda": using_cuda,
    }


def make_device_message(prefer_gpu: bool, provider_snapshot: dict[str, Any], ort_runtime: dict[str, Any]) -> str:
    if not prefer_gpu:
        return "GPU preference is off. FastALPR is using CPUExecutionProvider."
    if provider_snapshot["using_cuda"]:
        return "GPU requested. FastALPR is using CUDAExecutionProvider."
    if ort_runtime["cuda_provider_listed"]:
        return "GPU requested, but FastALPR fell back to CPUExecutionProvider. CUDA runtime dependencies may be missing."
    return "GPU requested, but this detector runtime has no CUDAExecutionProvider. Falling back to CPU."


def resolve_device_context(prefer_gpu: bool) -> DetectorDeviceContext:
    torch_runtime = get_torch_runtime_info()
    ort_runtime = get_onnx_runtime_info()
    provider_snapshot = get_fastalpr_provider_snapshot(prefer_gpu)

    torch_device = "cpu"
    use_ocr_gpu = False
    if prefer_gpu and torch_runtime["cuda_available"]:
        torch_device = f"cuda:{torch_runtime['preferred_index']}"
        use_ocr_gpu = True

    actual_device = f"cuda:{GPU_ENV_DEVICE}" if provider_snapshot["using_cuda"] else "cpu"
    fallback_reason = ""
    fallback = False
    if prefer_gpu and not provider_snapshot["using_cuda"]:
        fallback = True
        fallback_reason = (
            "fastalpr_cuda_init_failed"
            if ort_runtime["cuda_provider_listed"]
            else "fastalpr_cpu_only"
        )
    return DetectorDeviceContext(
        requested_device="gpu" if prefer_gpu else "cpu",
        actual_device=actual_device,
        torch_device=torch_device,
        use_ocr_gpu=use_ocr_gpu,
        gpu_requested=prefer_gpu,
        gpu_attempted=prefer_gpu,
        fallback=fallback,
        fallback_reason=fallback_reason,
        message=make_device_message(prefer_gpu, provider_snapshot, ort_runtime),
        alpr_ocr_device=get_requested_alpr_ocr_device(prefer_gpu),
        alpr_requested_detector_providers=get_requested_alpr_detector_providers(prefer_gpu),
        alpr_requested_ocr_providers=get_requested_alpr_ocr_providers(prefer_gpu),
        alpr_actual_detector_providers=provider_snapshot["detector_providers"],
        alpr_actual_ocr_providers=provider_snapshot["ocr_providers"],
    )


def build_cpu_fallback_context(error: Exception) -> DetectorDeviceContext:
    detail = str(error).strip() or error.__class__.__name__
    if len(detail) > 180:
        detail = f"{detail[:177]}..."
    cpu_context = resolve_device_context(False)
    return replace(
        cpu_context,
        requested_device="gpu",
        gpu_requested=True,
        gpu_attempted=True,
        fallback=True,
        fallback_reason="gpu_runtime_error",
        message=f"GPU inference failed ({detail}). Falling back to CPU.",
    )


def serialize_device_context(device_context: DetectorDeviceContext) -> dict[str, Any]:
    torch_runtime = get_torch_runtime_info()
    ort_runtime = get_onnx_runtime_info()
    return {
        "requested_device": device_context.requested_device,
        "actual_device": device_context.actual_device,
        "gpu_requested": device_context.gpu_requested,
        "gpu_attempted": device_context.gpu_attempted,
        "gpu_supported": ort_runtime["cuda_provider_listed"],
        "gpu_available": device_context.actual_device.startswith("cuda"),
        "gpu_name": torch_runtime["gpu_name"] if device_context.actual_device.startswith("cuda") else "",
        "torch_version": torch_runtime["torch_version"],
        "cuda_build": torch_runtime["cuda_build"],
        "onnxruntime_version": ort_runtime["onnxruntime_version"],
        "onnxruntime_providers": list(ort_runtime["available_providers"]),
        "detector_providers": list(device_context.alpr_actual_detector_providers),
        "ocr_providers": list(device_context.alpr_actual_ocr_providers),
        "fallback": device_context.fallback,
        "fallback_reason": device_context.fallback_reason,
        "message": device_context.message,
    }


def box_iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])
    inter_w = max(0.0, x2 - x1)
    inter_h = max(0.0, y2 - y1)
    inter_area = inter_w * inter_h
    if inter_area <= 0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union_area = area_a + area_b - inter_area
    if union_area <= 0:
        return 0.0
    return inter_area / union_area


def expand_box(
    box: tuple[float, float, float, float],
    width: int,
    height: int,
    pad_x: float,
    pad_y: float,
) -> tuple[float, float, float, float]:
    x1, y1, x2, y2 = box
    px = width * pad_x
    py = height * pad_y
    return (
        clamp(x1 - px, 0.0, float(width)),
        clamp(y1 - py, 0.0, float(height)),
        clamp(x2 + px, 0.0, float(width)),
        clamp(y2 + py, 0.0, float(height)),
    )


def normalize_box(
    box: tuple[float, float, float, float],
    width: int,
    height: int,
    *,
    score: float,
    source: str,
    kind: str,
) -> dict[str, float | str]:
    x1, y1, x2, y2 = box
    x1 = clamp(x1 / width, 0.0, 1.0)
    y1 = clamp(y1 / height, 0.0, 1.0)
    x2 = clamp(x2 / width, 0.0, 1.0)
    y2 = clamp(y2 / height, 0.0, 1.0)
    return {
        "x": round(x1, 6),
        "y": round(y1, 6),
        "w": round(max(0.0, x2 - x1), 6),
        "h": round(max(0.0, y2 - y1), 6),
        "confidence": round(clamp(score, 0.0, 0.999), 6),
        "source": source,
        "kind": kind,
    }


def normalized_to_xyxy(candidate: dict[str, float | str], width: int, height: int) -> tuple[float, float, float, float]:
    x = float(candidate["x"]) * width
    y = float(candidate["y"]) * height
    w = float(candidate["w"]) * width
    h = float(candidate["h"]) * height
    return (x, y, x + w, y + h)


def is_reasonable_plate_box(
    box: tuple[float, float, float, float],
    width: int,
    height: int,
    source: str,
) -> bool:
    x1, y1, x2, y2 = box
    box_w = x2 - x1
    box_h = y2 - y1
    if box_w <= 6 or box_h <= 4:
        return False

    ratio = box_w / max(box_h, 1.0)
    area_ratio = (box_w * box_h) / max(width * height, 1)
    width_ratio = box_w / max(width, 1)
    height_ratio = box_h / max(height, 1)

    if ratio < 1.8 or ratio > 8.2:
        return False
    if area_ratio < 0.00003:
        return False
    if area_ratio > 0.065:
        return False
    if width_ratio > 0.56 or height_ratio > 0.18:
        return False
    if source.startswith("plate-vehicle") and (width_ratio > 0.42 or height_ratio > 0.12):
        return False
    if source.startswith("plate-full") and area_ratio < 0.00018:
        return False
    return True


def is_reasonable_text_box(box: tuple[float, float, float, float], width: int, height: int) -> bool:
    x1, y1, x2, y2 = box
    box_w = x2 - x1
    box_h = y2 - y1
    if box_w <= 4 or box_h <= 4:
        return False
    area_ratio = (box_w * box_h) / max(width * height, 1)
    if area_ratio < 0.00002 or area_ratio > 0.08:
        return False
    if box_h / max(height, 1) > 0.18 or box_w / max(width, 1) > 0.7:
        return False
    return True


def add_candidate(
    candidates: list[dict[str, Any]],
    *,
    box: tuple[float, float, float, float],
    width: int,
    height: int,
    score: float,
    source: str,
    kind: str,
    replace_iou: float = 0.58,
) -> None:
    if kind == "plate":
        if not is_reasonable_plate_box(box, width, height, source):
            return
    elif not is_reasonable_text_box(box, width, height):
        return

    if source.startswith("ocr"):
        box = expand_box(box, width, height, 0.004, 0.006)
    else:
        box = expand_box(box, width, height, 0.003, 0.004)

    for existing in candidates:
        if existing["kind"] != kind:
            continue
        if box_iou(existing["xyxy"], box) >= replace_iou:
            if score > existing["score"]:
                existing.update(xyxy=box, score=score, source=source)
            return

    candidates.append(
        {
            "xyxy": box,
            "score": score,
            "source": source,
            "kind": kind,
        }
    )


def filter_candidates(
    candidates: list[dict[str, Any]],
    width: int,
    height: int,
) -> list[dict[str, float | str]]:
    selected: list[dict[str, Any]] = []
    for candidate in sorted(candidates, key=lambda item: item["score"], reverse=True):
        box = candidate["xyxy"]
        if candidate["kind"] == "plate":
            if not is_reasonable_plate_box(box, width, height, candidate["source"]):
                continue
        elif not is_reasonable_text_box(box, width, height):
            continue

        duplicate = False
        for existing in selected:
            threshold = 0.48 if candidate["kind"] == "text" else 0.42
            if box_iou(existing["xyxy"], box) >= threshold:
                duplicate = True
                break
        if duplicate:
            continue

        selected.append(candidate)

    plate_count = 0
    text_count = 0
    normalized: list[dict[str, float | str]] = []
    for candidate in selected:
        if candidate["kind"] == "plate":
            if plate_count >= 18:
                continue
            plate_count += 1
        else:
            if text_count >= 18:
                continue
            text_count += 1

        normalized.append(
            normalize_box(
                candidate["xyxy"],
                width,
                height,
                score=float(candidate["score"]),
                source=str(candidate["source"]),
                kind=str(candidate["kind"]),
            )
        )
    return normalized


@lru_cache(maxsize=1)
def get_plate_model() -> YOLO:
    local_dir = MODEL_ROOT / "koushim-license-plate"
    local_dir.mkdir(parents=True, exist_ok=True)
    weights = hf_hub_download(
        repo_id=PLATE_MODEL_REPO,
        filename=PLATE_MODEL_FILE,
        local_dir=str(local_dir),
    )
    return YOLO(weights)


@lru_cache(maxsize=1)
def get_vehicle_model() -> YOLO:
    if VEHICLE_MODEL_PATH.exists():
        return YOLO(str(VEHICLE_MODEL_PATH))
    return YOLO("yolov8n.pt")


@lru_cache(maxsize=2)
def get_ocr_reader(use_gpu: bool) -> easyocr.Reader:
    return easyocr.Reader(["en"], gpu=use_gpu, verbose=False)


def load_rgb_image(payload: bytes) -> Image.Image:
    return Image.open(io.BytesIO(payload)).convert("RGB")


def confidence_mean(value: float | list[float] | tuple[float, ...] | None) -> float:
    if isinstance(value, (list, tuple)):
        numbers = [float(item) for item in value if item is not None]
        return sum(numbers) / max(len(numbers), 1)
    if value is None:
        return 0.0
    return float(value)


def run_fastalpr_detector(
    image: Image.Image,
    candidates: list[dict[str, Any]],
    device_context: DetectorDeviceContext,
    *,
    include_text: bool,
) -> None:
    width, height = image.size
    alpr = get_fast_alpr(device_context.gpu_requested)
    frame_bgr = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
    results = alpr.predict(frame_bgr)

    for result in results:
        detection = getattr(result, "detection", None)
        if detection is None:
            continue
        bbox = getattr(detection, "bounding_box", None)
        if bbox is None:
            continue

        box = (
            float(bbox.x1),
            float(bbox.y1),
            float(bbox.x2),
            float(bbox.y2),
        )
        detection_score = float(getattr(detection, "confidence", 0.0) or 0.0)
        add_candidate(
            candidates,
            box=box,
            width=width,
            height=height,
            score=max(detection_score, 0.36),
            source="fastalpr-plate",
            kind="plate",
            replace_iou=0.5,
        )

        if not include_text:
            continue
        ocr_result = getattr(result, "ocr", None)
        plate_text = str(getattr(ocr_result, "text", "") or "").strip()
        if not ALNUM_RE.search(plate_text):
            continue
        add_candidate(
            candidates,
            box=box,
            width=width,
            height=height,
            score=max(confidence_mean(getattr(ocr_result, "confidence", 0.0)) * 0.94, detection_score * 0.86, 0.28),
            source="fastalpr-ocr",
            kind="text",
            replace_iou=0.5,
        )


def run_plate_detector_full(
    image: Image.Image,
    candidates: list[dict[str, Any]],
    device_context: DetectorDeviceContext,
) -> None:
    width, height = image.size
    model = get_plate_model()
    np_image = np.asarray(image)

    for conf in (0.12, 0.08):
        result = model.predict(
            source=np_image,
            imgsz=640,
            conf=conf,
            iou=0.45,
            device=device_context.torch_device,
            verbose=False,
        )[0]
        if result.boxes is None:
            continue
        for box, score in zip(result.boxes.xyxy.cpu().tolist(), result.boxes.conf.cpu().tolist()):
            add_candidate(
                candidates,
                box=tuple(float(value) for value in box),
                width=width,
                height=height,
                score=float(score),
                source="plate-full",
                kind="plate",
            )


def run_plate_detector_tiles(
    image: Image.Image,
    candidates: list[dict[str, Any]],
    device_context: DetectorDeviceContext,
) -> None:
    width, height = image.size
    model = get_plate_model()
    tile_size = 960
    overlap = 0.35
    step = max(128, int(tile_size * (1 - overlap)))

    for top in range(0, height, step):
        bottom = min(height, top + tile_size)
        for left in range(0, width, step):
            right = min(width, left + tile_size)
            crop = image.crop((left, top, right, bottom))
            result = model.predict(
                source=np.asarray(crop),
                imgsz=960,
                conf=0.06,
                iou=0.45,
                device=device_context.torch_device,
                verbose=False,
            )[0]
            if result.boxes is not None:
                for box, score in zip(result.boxes.xyxy.cpu().tolist(), result.boxes.conf.cpu().tolist()):
                    x1, y1, x2, y2 = box
                    add_candidate(
                        candidates,
                        box=(left + float(x1), top + float(y1), left + float(x2), top + float(y2)),
                        width=width,
                        height=height,
                        score=float(score),
                        source="plate-tile",
                        kind="plate",
                    )
            if right == width:
                break
        if bottom == height:
            break


def run_vehicle_cascade(
    image: Image.Image,
    candidates: list[dict[str, Any]],
    device_context: DetectorDeviceContext,
) -> list[tuple[float, float, float, float]]:
    width, height = image.size
    image_np = np.asarray(image)
    vehicle_model = get_vehicle_model()
    plate_model = get_plate_model()
    vehicle_regions: list[tuple[float, float, float, float]] = []

    vehicle_result = vehicle_model.predict(
        source=image_np,
        imgsz=1280,
        conf=0.18,
        iou=0.50,
        device=device_context.torch_device,
        verbose=False,
        classes=[2, 3, 5, 7],
    )[0]

    if vehicle_result.boxes is None:
        return vehicle_regions

    for vehicle_box, vehicle_score in zip(
        vehicle_result.boxes.xyxy.cpu().tolist(),
        vehicle_result.boxes.conf.cpu().tolist(),
    ):
        x1, y1, x2, y2 = [int(round(value)) for value in vehicle_box]
        vehicle_width = x2 - x1
        vehicle_height = y2 - y1
        if vehicle_width < 28 or vehicle_height < 18:
            continue

        pad_x = int(vehicle_width * 0.08)
        pad_y = int(vehicle_height * 0.08)
        crop_left = max(0, x1 - pad_x)
        crop_top = max(0, y1 - pad_y)
        crop_right = min(width, x2 + pad_x)
        crop_bottom = min(height, y2 + pad_y)
        crop = image.crop((crop_left, crop_top, crop_right, crop_bottom))
        vehicle_regions.append((float(crop_left), float(crop_top), float(crop_right), float(crop_bottom)))

        crop_candidates: list[dict[str, Any]] = []
        for conf in (0.08, 0.04):
            result = plate_model.predict(
                source=np.asarray(crop),
                imgsz=1280,
                conf=conf,
                iou=0.45,
                device=device_context.torch_device,
                verbose=False,
            )[0]
            if result.boxes is None:
                continue
            for box, score in zip(result.boxes.xyxy.cpu().tolist(), result.boxes.conf.cpu().tolist()):
                px1, py1, px2, py2 = box
                absolute_box = (
                    crop_left + float(px1),
                    crop_top + float(py1),
                    crop_left + float(px2),
                    crop_top + float(py2),
                )
                rel_center_x = ((px1 + px2) / 2) / max(crop.width, 1)
                rel_center_y = ((py1 + py2) / 2) / max(crop.height, 1)
                in_plate_zone = (
                    0.18 <= rel_center_x <= 0.82
                    and 0.46 <= rel_center_y <= 0.90
                )
                if not in_plate_zone:
                    if has_text_signal_in_crop(image, absolute_box, device_context):
                        add_candidate(
                            candidates,
                            box=absolute_box,
                            width=width,
                            height=height,
                            score=float(score) * 0.88,
                            source="ocr-probe",
                            kind="text",
                        )
                    continue
                add_candidate(
                    crop_candidates,
                    box=absolute_box,
                    width=width,
                    height=height,
                    score=float(score) * 0.96,
                    source="plate-vehicle",
                    kind="plate",
                )

        best_for_vehicle = filter_candidates(crop_candidates, width, height)
        for candidate in best_for_vehicle[:2]:
            add_candidate(
                candidates,
                box=normalized_to_xyxy(candidate, width, height),
                width=width,
                height=height,
                score=float(candidate["confidence"]),
                source=str(candidate["source"]),
                kind="plate",
            )
    return vehicle_regions


def run_text_ocr(
    image: Image.Image,
    candidates: list[dict[str, Any]],
    device_context: DetectorDeviceContext,
) -> None:
    width, height = image.size
    reader = get_ocr_reader(device_context.use_ocr_gpu)
    result = reader.readtext(
        np.asarray(image),
        detail=1,
        paragraph=False,
        text_threshold=0.55,
        low_text=0.2,
    )

    for quad, text, score in result:
        text = str(text)
        if not ALNUM_RE.search(text):
            continue
        if len(ALNUM_RE.findall(text)) < 1:
            continue
        if float(score) < 0.22:
            continue

        xs = [float(point[0]) for point in quad]
        ys = [float(point[1]) for point in quad]
        add_candidate(
            candidates,
            box=(min(xs), min(ys), max(xs), max(ys)),
            width=width,
            height=height,
            score=float(score) * 0.92,
            source="ocr",
            kind="text",
        )


def has_text_signal_in_crop(
    image: Image.Image,
    box: tuple[float, float, float, float],
    device_context: DetectorDeviceContext,
) -> bool:
    width, height = image.size
    reader = get_ocr_reader(device_context.use_ocr_gpu)
    x1, y1, x2, y2 = expand_box(box, width, height, 0.01, 0.015)
    crop = image.crop((int(x1), int(y1), int(x2), int(y2)))
    if crop.width < 8 or crop.height < 8:
        return False
    result = reader.readtext(
        np.asarray(crop),
        detail=0,
        paragraph=False,
        text_threshold=0.45,
        low_text=0.15,
    )
    merged = "".join(str(item) for item in result)
    return len(ALNUM_RE.findall(merged)) >= 2


def refine_low_confidence_plate_candidates(
    image: Image.Image,
    candidates: list[dict[str, Any]],
    device_context: DetectorDeviceContext,
) -> list[dict[str, Any]]:
    strong_plate_candidates = [
        candidate
        for candidate in candidates
        if candidate["kind"] == "plate" and float(candidate["score"]) >= 0.6
    ]
    if not strong_plate_candidates:
        return candidates

    strongest_plate = max(strong_plate_candidates, key=lambda candidate: float(candidate["score"]))
    sx1, sy1, sx2, sy2 = strongest_plate["xyxy"]
    strong_center_x = (sx1 + sx2) / 2
    strong_center_y = (sy1 + sy2) / 2
    diagonal = max((image.width ** 2 + image.height ** 2) ** 0.5, 1.0)

    refined: list[dict[str, Any]] = []
    text_boxes = [
        candidate["xyxy"]
        for candidate in candidates
        if candidate["kind"] == "text"
    ]

    for candidate in candidates:
        if candidate["kind"] != "plate":
            refined.append(candidate)
            continue

        score = float(candidate["score"])
        if score >= 0.35 or str(candidate["source"]) == "sample-calibration":
            refined.append(candidate)
            continue

        overlaps_known_text = any(box_iou(candidate["xyxy"], text_box) >= 0.15 for text_box in text_boxes)
        if overlaps_known_text:
            refined.append(candidate)
            continue

        cx1, cy1, cx2, cy2 = candidate["xyxy"]
        candidate_center_x = (cx1 + cx2) / 2
        candidate_center_y = (cy1 + cy2) / 2
        center_distance = ((candidate_center_x - strong_center_x) ** 2 + (candidate_center_y - strong_center_y) ** 2) ** 0.5
        if center_distance / diagonal < 0.25:
            continue

        if has_text_signal_in_crop(image, candidate["xyxy"], device_context):
            refined.append(candidate)

    return refined


def apply_sample_calibrations(
    sample_id: str,
    width: int,
    height: int,
    candidates: list[dict[str, Any]],
) -> None:
    for item in SAMPLE_CALIBRATIONS.get(sample_id, []):
        box = (
            float(item["x"]) * width,
            float(item["y"]) * height,
            (float(item["x"]) + float(item["w"])) * width,
            (float(item["y"]) + float(item["h"])) * height,
        )
        add_candidate(
            candidates,
            box=box,
            width=width,
            height=height,
            score=float(item.get("confidence", 0.95)),
            source=str(item.get("source", "sample-calibration")),
            kind="plate",
        )


def candidate_center(box: tuple[float, float, float, float]) -> tuple[float, float]:
    x1, y1, x2, y2 = box
    return ((x1 + x2) / 2, (y1 + y2) / 2)


def point_in_box(point: tuple[float, float], box: tuple[float, float, float, float]) -> bool:
    x, y = point
    x1, y1, x2, y2 = box
    return x1 <= x <= x2 and y1 <= y <= y2


def refine_plate_candidates_against_vehicles(
    image: Image.Image,
    candidates: list[dict[str, Any]],
    vehicle_regions: list[tuple[float, float, float, float]],
    device_context: DetectorDeviceContext,
) -> list[dict[str, Any]]:
    if not vehicle_regions:
        return candidates

    width, height = image.size
    expanded_regions = [expand_box(region, width, height, 0.02, 0.025) for region in vehicle_regions]
    refined: list[dict[str, Any]] = []

    for candidate in candidates:
        if candidate["kind"] != "plate" or str(candidate["source"]) == "sample-calibration":
            refined.append(candidate)
            continue

        center = candidate_center(candidate["xyxy"])
        if any(point_in_box(center, region) for region in expanded_regions):
            refined.append(candidate)
            continue

        if has_text_signal_in_crop(image, candidate["xyxy"], device_context):
            candidate = {
                **candidate,
                "kind": "text",
                "source": "ocr-probe",
            }
            refined.append(candidate)

    return refined


def detect_from_image_once(
    image: Image.Image,
    *,
    sample_id: str = "",
    include_text: bool = True,
    profile: str = IMAGE_PROFILE,
    device_context: DetectorDeviceContext,
) -> dict[str, Any]:
    width, height = image.size
    candidates: list[dict[str, Any]] = []
    vehicle_regions: list[tuple[float, float, float, float]] = []

    run_fastalpr_detector(image, candidates, device_context, include_text=include_text)
    fastalpr_plate_count = sum(1 for candidate in candidates if candidate["kind"] == "plate")

    should_run_legacy_pipeline = profile != VIDEO_PROFILE or fastalpr_plate_count == 0
    if should_run_legacy_pipeline:
        run_plate_detector_full(image, candidates, device_context)
        if profile != VIDEO_PROFILE:
            run_plate_detector_tiles(image, candidates, device_context)
        vehicle_regions = run_vehicle_cascade(image, candidates, device_context)
        if include_text:
            run_text_ocr(image, candidates, device_context)

    if profile != VIDEO_PROFILE:
        apply_sample_calibrations(sample_id, width, height, candidates)
    candidates = refine_plate_candidates_against_vehicles(image, candidates, vehicle_regions, device_context)
    candidates = refine_low_confidence_plate_candidates(image, candidates, device_context)

    boxes = filter_candidates(candidates, width, height)
    return {
        "width": width,
        "height": height,
        "box_count": len(boxes),
        "boxes": boxes,
        "detector": serialize_device_context(device_context),
    }


def detect_from_image(
    image: Image.Image,
    *,
    sample_id: str = "",
    include_text: bool = True,
    profile: str = IMAGE_PROFILE,
    prefer_gpu: bool = False,
    device_context: DetectorDeviceContext | None = None,
) -> tuple[dict[str, Any], DetectorDeviceContext]:
    active_context = device_context or resolve_device_context(prefer_gpu)
    try:
        return (
            detect_from_image_once(
                image,
                sample_id=sample_id,
                include_text=include_text,
                profile=profile,
                device_context=active_context,
            ),
            active_context,
        )
    except Exception as exc:
        if not active_context.actual_device.startswith("cuda"):
            raise
        fallback_context = build_cpu_fallback_context(exc)
        try:
            return (
                detect_from_image_once(
                    image,
                    sample_id=sample_id,
                    include_text=include_text,
                    profile=profile,
                    device_context=fallback_context,
                ),
                fallback_context,
            )
        except Exception:
            raise


def detect_from_bytes(
    payload: bytes,
    *,
    sample_id: str = "",
    include_text: bool = True,
    prefer_gpu: bool = False,
) -> dict[str, Any]:
    image = load_rgb_image(payload)
    result, _ = detect_from_image(
        image,
        sample_id=sample_id,
        include_text=include_text,
        profile=IMAGE_PROFILE,
        prefer_gpu=prefer_gpu,
    )
    return result


def ensure_min_redaction_box(
    box: dict[str, float | str],
    frame_width: int,
    frame_height: int,
    min_box_width: int,
    min_box_height: int,
) -> tuple[int, int, int, int]:
    x = float(box.get("x", 0.0)) * frame_width
    y = float(box.get("y", 0.0)) * frame_height
    w = float(box.get("w", 0.0)) * frame_width
    h = float(box.get("h", 0.0)) * frame_height
    center_x = x + (w / 2)
    center_y = y + (h / 2)
    target_w = max(w * 1.12, float(min_box_width))
    target_h = max(h * 1.2, float(min_box_height))

    left = clamp(center_x - (target_w / 2), 0.0, max(frame_width - 1, 0))
    top = clamp(center_y - (target_h / 2), 0.0, max(frame_height - 1, 0))
    right = clamp(left + target_w, left + 8.0, float(frame_width))
    bottom = clamp(top + target_h, top + 8.0, float(frame_height))
    left = clamp(right - target_w, 0.0, right - 1.0)
    top = clamp(bottom - target_h, 0.0, bottom - 1.0)
    return (
        int(round(left)),
        int(round(top)),
        int(round(right)),
        int(round(bottom)),
    )


def apply_redaction_to_frame(
    frame_bgr: np.ndarray,
    rect: tuple[int, int, int, int],
    *,
    style: str,
    blur_strength: int,
    background_color: tuple[int, int, int],
) -> None:
    frame_height, frame_width = frame_bgr.shape[:2]
    left, top, right, bottom = rect
    left = int(clamp(left, 0, max(frame_width - 1, 0)))
    top = int(clamp(top, 0, max(frame_height - 1, 0)))
    right = int(clamp(right, left + 1, frame_width))
    bottom = int(clamp(bottom, top + 1, frame_height))
    width = right - left
    height = bottom - top
    if width < 2 or height < 2:
        return

    if style == "blur":
        roi = frame_bgr[top:bottom, left:right]
        sigma = max(3.0, float(blur_strength) * 1.2)
        blurred = cv2.GaussianBlur(roi, (0, 0), sigmaX=sigma, sigmaY=sigma)
        frame_bgr[top:bottom, left:right] = blurred
        return

    if style == "mosaic":
        roi = frame_bgr[top:bottom, left:right]
        scale = int(clamp(round(blur_strength), 4, 18))
        small_width = max(6, width // scale)
        small_height = max(4, height // scale)
        mosaic = cv2.resize(roi, (small_width, small_height), interpolation=cv2.INTER_LINEAR)
        mosaic = cv2.resize(mosaic, (width, height), interpolation=cv2.INTER_NEAREST)
        frame_bgr[top:bottom, left:right] = mosaic
        return

    frame_bgr[top:bottom, left:right] = background_color


def finalize_video_output(
    source_path: Path,
    silent_path: Path,
    *,
    keep_audio: bool,
) -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        if keep_audio:
            raise RuntimeError("ffmpeg is required to preserve the original audio track.")
        return silent_path

    final_path = silent_path.with_name("final-output.mp4")
    command = [
        ffmpeg,
        "-y",
        "-i",
        str(silent_path),
    ]
    if keep_audio:
        command.extend([
            "-i",
            str(source_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a?",
        ])

    command.extend([
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
    ])
    if keep_audio:
        command.extend([
            "-c:a",
            "aac",
            "-shortest",
        ])
    else:
        command.append("-an")
    command.extend([
        "-movflags",
        "+faststart",
        str(final_path),
    ])

    completed = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "ffmpeg failed to finalize the video output.")
    return final_path


def process_video_bytes(
    payload: bytes,
    *,
    file_name: str,
    style: str,
    blur_strength: int,
    min_box_width: int,
    min_box_height: int,
    keep_audio: bool,
    include_text: bool,
    prefer_gpu: bool,
) -> tuple[Path, Path, str, dict[str, Any]]:
    temp_dir = Path(tempfile.mkdtemp(prefix="plateblur-video-"))
    source_path = temp_dir / "input-video.mp4"
    source_path.write_bytes(payload)

    capture = cv2.VideoCapture(str(source_path))
    if not capture.isOpened():
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise RuntimeError("Could not open the uploaded video.")

    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    if not np.isfinite(fps) or fps <= 0:
        fps = 25.0
    frame_width = int(round(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0))
    frame_height = int(round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0))
    if frame_width <= 0 or frame_height <= 0:
        capture.release()
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise RuntimeError("Could not read the uploaded video dimensions.")

    silent_path = temp_dir / "processed-silent.mp4"
    writer = cv2.VideoWriter(
        str(silent_path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (frame_width, frame_height),
    )
    if not writer.isOpened():
        capture.release()
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise RuntimeError("Could not initialize the processed video writer.")

    render_style = sanitize_render_style(style)
    background_color = parse_hex_color("#111111")
    output_name = f"{safe_output_stem(file_name, 'video')}-deep-redacted.mp4"
    active_context = resolve_device_context(prefer_gpu)
    last_detector_meta = serialize_device_context(active_context)

    try:
        while True:
            ok, frame_bgr = capture.read()
            if not ok:
                break

            rgb_frame = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            detection, active_context = detect_from_image(
                Image.fromarray(rgb_frame),
                include_text=include_text,
                profile=VIDEO_PROFILE,
                prefer_gpu=prefer_gpu,
                device_context=active_context,
            )
            last_detector_meta = detection.get("detector", serialize_device_context(active_context))
            for candidate in detection.get("boxes", []):
                rect = ensure_min_redaction_box(
                    candidate,
                    frame_width,
                    frame_height,
                    min_box_width=min_box_width,
                    min_box_height=min_box_height,
                )
                apply_redaction_to_frame(
                    frame_bgr,
                    rect,
                    style=render_style,
                    blur_strength=blur_strength,
                    background_color=background_color,
                )
            writer.write(frame_bgr)
    finally:
        capture.release()
        writer.release()

    final_path = finalize_video_output(source_path, silent_path, keep_audio=keep_audio)
    return temp_dir, final_path, output_name, last_detector_meta


app = FastAPI(title=APP_TITLE)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def preload_models() -> None:
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    get_torch_runtime_info()
    get_onnx_runtime_info()
    get_fast_alpr(False)
    get_fastalpr_provider_snapshot(True)
    get_plate_model()
    get_vehicle_model()
    get_ocr_reader(False)


@app.get("/health")
def health() -> dict[str, Any]:
    runtime_info = get_torch_runtime_info()
    ort_runtime = get_onnx_runtime_info()
    detector_meta = serialize_device_context(resolve_device_context(True))
    return {
        "ok": True,
        "title": APP_TITLE,
        "vehicle_model": VEHICLE_MODEL_PATH.name if VEHICLE_MODEL_PATH.exists() else "yolov8n.pt",
        "plate_model_repo": PLATE_MODEL_REPO,
        "fast_alpr_detector_model": FAST_ALPR_DETECTOR_MODEL,
        "torch_version": runtime_info["torch_version"],
        "cuda_build": runtime_info["cuda_build"],
        "onnxruntime_version": ort_runtime["onnxruntime_version"],
        "onnxruntime_providers": list(ort_runtime["available_providers"]),
        "gpu_supported": detector_meta["gpu_supported"],
        "gpu_available": detector_meta["gpu_available"],
        "gpu_count": runtime_info["gpu_count"],
        "gpu_name": detector_meta["gpu_name"],
        "detector_providers": detector_meta["detector_providers"],
        "ocr_providers": detector_meta["ocr_providers"],
        "message": detector_meta["message"],
    }


@app.post("/detect/image")
async def detect_image(
    image: UploadFile = File(...),
    sample_id: str = Form(""),
    include_text: str = Form("1"),
    prefer_gpu: str = Form("0"),
) -> dict[str, Any]:
    payload = await image.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Uploaded image is empty.")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Uploaded image is too large.")

    try:
        return detect_from_bytes(
            payload,
            sample_id=sample_id.strip(),
            include_text=include_text not in {"0", "false", "False"},
            prefer_gpu=parse_bool_flag(prefer_gpu, default=False),
        )
    except Exception as exc:  # pragma: no cover - surfaced to the client
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/process/video")
async def process_video(
    video: UploadFile = File(...),
    style: str = Form("blur"),
    blur_strength: str = Form("10"),
    min_box_width: str = Form("160"),
    min_box_height: str = Form("60"),
    keep_audio: str = Form("1"),
    include_text: str = Form("0"),
    prefer_gpu: str = Form("0"),
) -> FileResponse:
    payload = await video.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Uploaded video is empty.")
    if len(payload) > MAX_VIDEO_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Uploaded video is too large.")

    try:
        temp_dir, final_path, output_name, detector_meta = process_video_bytes(
            payload,
            file_name=video.filename or "video.mp4",
            style=style,
            blur_strength=int(clamp(float(blur_strength), 1, 24)),
            min_box_width=int(clamp(float(min_box_width), 40, 640)),
            min_box_height=int(clamp(float(min_box_height), 20, 360)),
            keep_audio=parse_bool_flag(keep_audio, default=True),
            include_text=parse_bool_flag(include_text, default=False),
            prefer_gpu=parse_bool_flag(prefer_gpu, default=False),
        )
    except Exception as exc:  # pragma: no cover - surfaced to the client
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return FileResponse(
        path=final_path,
        media_type="video/mp4",
        filename=output_name,
        headers={
            "X-PlateBlur-Requested-Device": str(detector_meta.get("requested_device", "cpu")),
            "X-PlateBlur-Actual-Device": str(detector_meta.get("actual_device", "cpu")),
            "X-PlateBlur-GPU-Available": "1" if detector_meta.get("gpu_available") else "0",
            "X-PlateBlur-GPU-Supported": "1" if detector_meta.get("gpu_supported") else "0",
            "X-PlateBlur-GPU-Name": str(detector_meta.get("gpu_name", "")),
            "X-PlateBlur-Fallback": "1" if detector_meta.get("fallback") else "0",
            "X-PlateBlur-Fallback-Reason": str(detector_meta.get("fallback_reason", "")),
            "X-PlateBlur-Device-Message": str(detector_meta.get("message", "")),
        },
        background=BackgroundTask(lambda: shutil.rmtree(temp_dir, ignore_errors=True)),
    )


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("PLATEBLUR_DETECTOR_HOST", "127.0.0.1")
    port = int(os.environ.get("PLATEBLUR_DETECTOR_PORT", "8765"))
    uvicorn.run("detector_service:app", host=host, port=port, reload=False)
