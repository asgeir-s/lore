import { useState, useCallback } from "react";

interface DragSplitterProps {
  onDrag: (deltaX: number) => void;
  onDragEnd: () => void;
}

export function DragSplitter({ onDrag, onDragEnd }: DragSplitterProps) {
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setDragging(true);
      const startX = e.clientX;
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);

      const handleMove = (ev: PointerEvent) => {
        onDrag(ev.clientX - startX);
      };

      const handleUp = () => {
        setDragging(false);
        onDragEnd();
        target.removeEventListener("pointermove", handleMove);
        target.removeEventListener("pointerup", handleUp);
        document.documentElement.classList.remove("dragging");
      };

      document.documentElement.classList.add("dragging");
      target.addEventListener("pointermove", handleMove);
      target.addEventListener("pointerup", handleUp);
    },
    [onDrag, onDragEnd],
  );

  return (
    <div
      className={`drag-splitter ${dragging ? "dragging" : ""}`}
      onPointerDown={handlePointerDown}
    />
  );
}
