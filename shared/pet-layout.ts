export const PET_SURFACE = { width: 340, height: 400 };
export const PET_CHARACTER = { left: 55, top: 99, width: 230, height: 240 };

export function fitPetPosition(
  position: { x: number; y: number },
  area: { x: number; y: number; width: number; height: number },
  scale: number,
) {
  // 屏幕边界约束角色本体；气泡与控件预留的透明边距可以移出屏幕。
  const left = PET_CHARACTER.left * scale;
  const top = PET_CHARACTER.top * scale;
  return {
    x: Math.round(
      Math.max(
        area.x - left,
        Math.min(
          position.x,
          area.x + area.width - left - PET_CHARACTER.width * scale,
        ),
      ),
    ),
    y: Math.round(
      Math.max(
        area.y - top,
        Math.min(
          position.y,
          area.y + area.height - top - PET_CHARACTER.height * scale,
        ),
      ),
    ),
  };
}
