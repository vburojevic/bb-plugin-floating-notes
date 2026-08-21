// Where the *visible* viewport actually is, which on iOS is not where CSS says.
//
// Ported from bb-plugin-floating-terminal. Opening the software keyboard does
// not change the layout viewport, so a fixed sheet keeps its full height and
// the editor's caret ends up behind the keys. visualViewport is the only thing
// that reports the truth, so the sheet's height and offset come from here.

const HEIGHT_VAR = "--bb-fn-viewport-height";
const TOP_VAR = "--bb-fn-viewport-top";

/**
 * Below this the shortfall is browser chrome (a URL bar collapsing), above it
 * a keyboard. The distinction matters because the home-indicator inset is
 * already inside the keyboard and must not be added twice.
 */
const KEYBOARD_MIN_PX = 120;

export interface ViewportState {
  keyboardOpen: boolean;
}

/**
 * Mirror the visual viewport onto `element` as custom properties, and flag
 * whether a keyboard is up. Returns a teardown.
 */
export function trackVisualViewport(
  element: HTMLElement,
  onChange?: (state: ViewportState) => void,
): () => void {
  const viewport = window.visualViewport;
  if (viewport === undefined || viewport === null) {
    return () => {};
  }

  let lastKeyboardOpen: boolean | null = null;

  const apply = () => {
    element.style.setProperty(HEIGHT_VAR, `${Math.round(viewport.height)}px`);
    // The layout viewport scrolls under the visual one when the keyboard
    // opens, and a fixed element is positioned against the layout viewport.
    element.style.setProperty(TOP_VAR, `${Math.round(viewport.offsetTop)}px`);

    const hidden = window.innerHeight - viewport.height - viewport.offsetTop;
    const keyboardOpen = hidden > KEYBOARD_MIN_PX;
    element.dataset.keyboard = keyboardOpen ? "open" : "closed";
    if (keyboardOpen !== lastKeyboardOpen) {
      lastKeyboardOpen = keyboardOpen;
      onChange?.({ keyboardOpen });
    }
  };

  apply();
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  return () => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
    element.style.removeProperty(HEIGHT_VAR);
    element.style.removeProperty(TOP_VAR);
    delete element.dataset.keyboard;
  };
}
