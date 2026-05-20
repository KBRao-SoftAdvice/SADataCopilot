from ipykernel.kernelapp import IPKernelApp
from .kernel import ClaudeKernel

IPKernelApp.launch_instance(kernel_class=ClaudeKernel)
