// Most-recently-touched floating surface on top, like a window manager.
//
// Every active floating root (the main window, each sticky) registers here
// and gets an inline z-index from a contiguous band starting at BASE_Z.
// Raising reorders the list and reassigns — no ever-growing counter, so the
// band stays inside [BASE_Z, BASE_Z + count) and never climbs over the
// capture bar (65+) or bb's own dialogs (70).

const BASE_Z = 53;

const layers: HTMLElement[] = [];

/** The capture bar and note picker live at 65+; never climb into them. */
const MAX_Z = 64;

function assign(): void {
  layers.forEach((element, index) => {
    element.style.zIndex = String(Math.min(BASE_Z + index, MAX_Z));
  });
}

/** Newly registered surfaces start on top (mount = most recent). */
export function registerLayer(element: HTMLElement): () => void {
  layers.push(element);
  assign();
  return () => {
    const index = layers.indexOf(element);
    if (index !== -1) {
      layers.splice(index, 1);
      element.style.removeProperty("z-index");
      assign();
    }
  };
}

export function raiseLayer(element: HTMLElement): void {
  const index = layers.indexOf(element);
  if (index === -1 || index === layers.length - 1) return;
  layers.splice(index, 1);
  layers.push(element);
  assign();
}
