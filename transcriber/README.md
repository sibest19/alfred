# transcriber

A small speech-to-text service (Python, FastAPI), published as `ghcr.io/sibest19/alfred-transcriber:<version>` (amd64). It runs [Parakeet Ultra](https://huggingface.co/moondream/parakeet-ultra) (NVIDIA Parakeet TDT 0.6B v3 post-trained by Moondream; 25 European languages, punctuation, CC BY 4.0) as ONNX through [onnx-asr](https://github.com/istupakov/onnx-asr), on an Intel GPU via the standalone `onnxruntime-ep-openvino` plugin (`DEVICE=GPU`, needs `/dev/dri/renderD*` and the render group) or on the CPU (`DEVICE=CPU`). The model (`MODEL_REPO`, default `Masterx/parakeet-tdt-0.6b-ultra-onnx`, `MODEL_QUANTIZATION=fp16`) is downloaded into `/models` on first start. OpenVINO's on-disk cache (`OPENVINO_CACHE_DIR`) remains opt-in pending GPU restart validation with the new plugin. Missing Intel GPU devices fail readiness in GPU mode; use `DEVICE=CPU` explicitly for CPU-only hosts.

The plugin migration is prepared but **Intel GPU validation is still required before release**; see [validation and rollback](OPENVINO-MIGRATION.md) for issue [#55](https://github.com/sibest19/alfred/issues/55).

- `POST /transcribe`: audio in any format ffmpeg reads (raw body or multipart `file`) → `{"text", "duration_s", "elapsed_s"}`.
- `POST /v1/audio/transcriptions`: the OpenAI-style form of the same.
- `GET /health`: `200` once the model is loaded and warmed up.

Historical measurements with the legacy runtime on an Intel Arc A310 (fp16): a 197 s voice note in 10 s, a 4 s one in 0.15 s; the same on a Ryzen 9 5900X CPU took 18 s and 0.25 s. These do not validate the new plugin.
