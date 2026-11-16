// Drag things OUT of the island into other apps (Explorer, Discord, browsers…).
// Once the pointer moves a few px with the button down, the backend starts a real
// Windows drag-and-drop (OLE) carrying files and/or text.
import { isTauri } from "../../bridge";
import { send } from "../../lib/native";

export function startDragOut(e: React.PointerEvent, payload: { files?: string[]; text?: string }) {
  if (e.button !== 0 || !isTauri) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
    cleanup();
    send("drag_out", { files: payload.files ?? [], text: payload.text ?? null });
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", cleanup);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", cleanup);
}
