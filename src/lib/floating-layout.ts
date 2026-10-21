export function clampPanelPosition(
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const marginX = Math.min(12, Math.max(0, (viewport.width - rect.width) / 2))
  const marginY = Math.min(12, Math.max(0, (viewport.height - rect.height) / 2))
  return {
    left: Math.max(marginX, Math.min(rect.left, viewport.width - rect.width - marginX)),
    top: Math.max(marginY, Math.min(rect.top, viewport.height - rect.height - marginY)),
  }
}
