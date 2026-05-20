"""Install the Claude Code kernel into Jupyter."""

import json
import os
import sys
from pathlib import Path


def install():
    from jupyter_client.kernelspec import KernelSpecManager

    kernel_json = {
        "argv": [sys.executable, "-m", "claude_kernel", "-f", "{connection_file}"],
        "display_name": "Claude Code",
        "language": "python",
        "metadata": {"debugger": False},
    }

    kernel_dir = Path(__file__).parent / "_installed_spec"
    kernel_dir.mkdir(exist_ok=True)
    with open(kernel_dir / "kernel.json", "w") as f:
        json.dump(kernel_json, f, indent=2)

    ksm = KernelSpecManager()
    ksm.install_kernel_spec(str(kernel_dir), kernel_name="claude_code", user=True)
    print(f"Installed 'Claude Code' kernel (python: {sys.executable})")
    print("Launch with: jupyter lab  or  jupyter notebook")


if __name__ == "__main__":
    install()
