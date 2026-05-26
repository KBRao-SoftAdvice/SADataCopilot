interface OutputItem {
  mime: string;
  text(): string;
}

interface RendererContext {
  postMessage?(msg: unknown): void;
}

interface ActivationResult {
  renderOutputItem(outputItem: OutputItem, element: HTMLElement): void;
}

const HIDDEN_RE = /<div[^>]*class="copilot-(panel-port|clear-tools|token-payload|tool-payload)"[^>]*>(?:<\/div>)?/g;

export const activate = (_context: RendererContext): ActivationResult => {
  return {
    renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
      const html = outputItem.text();

      // Strip hidden signal divs from visible output
      const visible = html.replace(HIDDEN_RE, '');

      // Don't render empty outputs
      if (!visible.trim()) {
        element.style.display = 'none';
        return;
      }

      element.innerHTML = visible;
      element.style.fontFamily = '-apple-system, BlinkMacSystemFont, sans-serif';
      element.style.fontSize = '13px';
      element.style.lineHeight = '1.5';

      // Style code blocks within rendered output
      const pres = element.querySelectorAll('pre');
      for (const pre of Array.from(pres)) {
        pre.style.overflowX = 'auto';
        pre.style.maxHeight = '500px';
        pre.style.overflowY = 'auto';
      }
    }
  };
};
