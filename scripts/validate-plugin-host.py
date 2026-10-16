"""用上游真实 ManifestValidator 验证插件；不启动内核或加载用户配置。"""

import argparse
import json
import shutil
import sys
from importlib.metadata import version
from pathlib import Path
from tempfile import TemporaryDirectory

workspace = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--core-root", type=Path, default=workspace / "MaiBot")
parser.add_argument("--plugin-root", type=Path, default=workspace / "MaiBot/plugins/desktop_pet_adapter")
args = parser.parse_args()
core = args.core_root.resolve()
plugin = args.plugin_root.resolve()
sys.path.insert(0, str(core))

from src.plugin_runtime import detect_host_application_version
from src.plugin_runtime.runner.manifest_validator import ManifestValidator
from src.plugin_runtime.runner.plugin_loader import PluginLoader

host_version = detect_host_application_version(core)
sdk_version = version("maibot-plugin-sdk")
validator = ManifestValidator(host_version=host_version, sdk_version=sdk_version, project_root=core)
result = validator.load_from_plugin_path(plugin)
if result is None:
    raise RuntimeError(json.dumps(validator.errors, ensure_ascii=False))
print(f"PASS Host manifest: {result.id}, Host {host_version}, SDK {sdk_version}")

# 只发现隔离副本中的目标插件，避免加载被检查 Host 中的其他插件或实际配置。
cache = workspace / ".cache"
cache.mkdir(exist_ok=True)
with TemporaryDirectory(prefix="mai-plugin-contract-", dir=cache) as directory:
    shutil.copytree(
        plugin,
        Path(directory) / plugin.name,
        ignore=shutil.ignore_patterns(".git", ".venv", "__pycache__", ".ruff_cache", "config.toml"),
    )
    loader = PluginLoader(host_version=host_version, plugin_type_filter="trusted_or_adapter")
    loaded = loader.discover_and_load([directory])
    try:
        adapter = next((item for item in loaded if item.plugin_id == result.id), None)
        if adapter is None:
            raise RuntimeError(json.dumps(loader.failed_plugins, ensure_ascii=False))
        declarations = adapter.instance.get_components()
        gateways = [item for item in declarations if item["type"] == "MESSAGE_GATEWAY"]
        assert gateways and all(item["metadata"]["route_type"] == "duplex" for item in gateways)
    finally:
        for item in loaded:
            loader.purge_plugin_modules(item.plugin_id, item.plugin_dir)
            loader.remove_loaded_plugin(item.plugin_id)
print("PASS Host loader: SDK plugin factory, adapter runner filter, gateway component")
