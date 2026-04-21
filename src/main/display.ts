import { Rectangle, screen } from "electron";

export interface DesktopFloor {
  readonly x: number;
  readonly top: number;
  readonly y: number;
  readonly width: number;
}

export function getPrimaryDesktopFloor(windowHeight: number): DesktopFloor {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const bottom = workArea.y + workArea.height;

  return {
    x: workArea.x,
    top: workArea.y,
    y: bottom - windowHeight,
    width: workArea.width,
  };
}

export function containsPoint(rect: Rectangle, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}
