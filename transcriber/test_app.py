"""Provider routing checks without downloading models or requiring Intel hardware."""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

with patch("threading.Thread.start"):
    import app


@unittest.skipUnless(sys.platform == "linux", "OpenVINO plugin wheel targets Linux/Windows")
class NativePluginTests(unittest.TestCase):
    def test_native_plugin_registers_and_enumerates_devices(self):
        import onnxruntime_ep_openvino as plugin

        app.ort.register_execution_provider_library("openvino_validation", plugin.get_library_path())
        try:
            self.assertTrue(any(device.ep_name == plugin.get_ep_name() for device in app.ort.get_ep_devices()))
        finally:
            app.ort.unregister_execution_provider_library("openvino_validation")


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.plugin = Mock()
        self.plugin.get_ep_name.return_value = "OpenVINOExecutionProvider"
        self.plugin.get_library_path.return_value = "/synthetic/plugin.so"
        self.gpu = SimpleNamespace(ep_name="OpenVINOExecutionProvider", ep_metadata={"ov_device": "GPU.0"},
                                   device=SimpleNamespace(type=app.ort.OrtHardwareDeviceType.GPU))
        for context in (
            patch.dict("sys.modules", {"onnxruntime_ep_openvino": self.plugin}),
            patch.object(app, "DEVICE", "GPU"),
            patch.object(app, "OPENVINO_CACHE_DIR", ""),
            patch.dict(app.state, {"model": None, "error": None}, clear=True),
        ):
            context.start()
            self.addCleanup(context.stop)
        self.register = self.enterContext(patch.object(app.ort, "register_execution_provider_library"))
        self.devices = self.enterContext(patch.object(app.ort, "get_ep_devices", return_value=[self.gpu]))
        self.session = self.enterContext(patch.object(app.ort, "SessionOptions"))

    def test_cpu_does_not_register_plugin(self):
        with patch.object(app, "DEVICE", "CPU"):
            self.assertEqual(app.model_options(), {"providers": ["CPUExecutionProvider"]})
        self.register.assert_not_called()

    def test_invalid_device_is_rejected(self):
        with patch.object(app, "DEVICE", "AUTO"), self.assertRaisesRegex(ValueError, "CPU or GPU"):
            app.model_options()
        self.register.assert_not_called()

    def test_gpu_selection_and_cache_off(self):
        cpu = SimpleNamespace(ep_name="OpenVINOExecutionProvider",
                              device=SimpleNamespace(type=app.ort.OrtHardwareDeviceType.CPU))
        other = SimpleNamespace(ep_name="OtherExecutionProvider", device=self.gpu.device)
        self.devices.return_value = [cpu, other, self.gpu]
        options = app.model_options()
        self.register.assert_called_once_with("openvino_ep", "/synthetic/plugin.so")
        self.session.return_value.add_provider_for_devices.assert_called_once_with([self.gpu], {})
        self.assertEqual(options["asr_config"], {"sess_options": self.session.return_value})

    def test_missing_gpu_keeps_health_unready(self):
        self.devices.return_value = []
        with patch.object(app, "model_files", return_value=Path("/synthetic/model")):
            app.load()
        with self.assertRaises(app.HTTPException) as error:
            asyncio.run(app.health())
        self.assertEqual(error.exception.status_code, 503)
        self.assertIn("No OpenVINO Intel GPU", error.exception.detail)

    def test_cache_uses_openvino_property(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = str(Path(directory) / "cache")
            with patch.object(app, "OPENVINO_CACHE_DIR", cache):
                app.model_options()
            options = self.session.return_value.add_provider_for_devices.call_args.args[1]
            self.assertEqual(json.loads(options["load_config"]), {"GPU": {"CACHE_DIR": cache}})
            self.assertTrue(Path(cache).is_dir())

    def test_real_onnx_asr_routes_both_model_sessions_without_provider_override(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "vocab.txt").write_text("<blk> 0\nsynthetic 1\n")
            for name in ("encoder-model.fp16.onnx", "decoder_joint-model.fp16.onnx"):
                (path / name).touch()
            with patch.object(app.ort, "InferenceSession") as inference:
                app.onnx_asr.load_model(app.MODEL_TYPE, path, quantization="fp16", **app.model_options())
            calls = [call for call in inference.call_args_list
                     if isinstance(call.args[0], Path) and call.args[0].parent == path]
            self.assertEqual({Path(call.args[0]).name for call in calls},
                             {"encoder-model.fp16.onnx", "decoder_joint-model.fp16.onnx"})
            for call in calls:
                self.assertEqual(call.kwargs, {"sess_options": self.session.return_value})

    def test_warmup_precedes_readiness(self):
        model = Mock()
        model.recognize.side_effect = lambda wave: self.assertIsNone(app.state["model"])
        with patch.object(app, "model_files"), patch.object(app.onnx_asr, "load_model", return_value=model):
            app.load()
        self.assertIs(app.state["model"], model)
        model.recognize.assert_called_once()

    def test_gpu_failure_retries_with_lazy_cpu_model(self):
        gpu, cpu = Mock(), Mock()
        gpu.recognize.side_effect = RuntimeError("synthetic GPU failure")
        cpu.recognize.return_value = " synthetic transcript "
        app.state["model"] = gpu
        with patch.object(app, "decode", return_value=np.zeros(16000, dtype=np.float32)), \
                patch.object(app, "model_files"), patch.object(app.onnx_asr, "load_model", return_value=cpu) as load:
            self.assertEqual(app.transcribe(b"synthetic audio")["text"], "synthetic transcript")
            app.transcribe(b"synthetic audio")
        load.assert_called_once()
        self.assertEqual(load.call_args.kwargs["providers"], ["CPUExecutionProvider"])
        self.assertNotIn("asr_config", load.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
