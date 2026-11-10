import { useEffect, useRef, useState } from "react";
import { createMap, type LL, type MapView } from "./MapView";

/** Creates a map in the element once, keeps it sized with the card, and removes it on unmount. */
export function useMap(center?: LL) {
  const el = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<MapView | null>(null);
  useEffect(() => {
    if (!el.current) return;
    let v: MapView | null = null;
    let gone = false;
    void createMap(el.current, center).then((m) => { if (gone) m.destroy(); else { v = m; setView(m); } });
    const ro = new ResizeObserver(() => v?.resize());
    ro.observe(el.current);
    return () => { gone = true; ro.disconnect(); v?.destroy(); };
  }, []);
  return { el, view };
}
