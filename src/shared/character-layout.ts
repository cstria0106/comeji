export const CharacterImageSize = 512;
export const DefaultCharacterScale = 0.5;
export const MinCharacterScale = 0.2;
export const MaxCharacterScale = 1;
export const CharacterScaleStep = 0.05;
export const CharacterGrabImageX = 290;
export const CharacterGrabImageY = 60;

export interface CharacterLayout {
  readonly scale: number;
  readonly imageSize: number;
  readonly displaySize: number;
  readonly paddingTop: number;
  readonly paddingRight: number;
  readonly paddingBottom: number;
  readonly paddingLeft: number;
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly grabImageX: number;
  readonly grabImageY: number;
  readonly grabDisplayX: number;
  readonly grabDisplayY: number;
}

export function clampCharacterScale(value: number): number {
  if (!Number.isFinite(value)) {
    return DefaultCharacterScale;
  }

  return Math.min(Math.max(value, MinCharacterScale), MaxCharacterScale);
}

export function createCharacterLayout(scale: number): CharacterLayout {
  const clampedScale = clampCharacterScale(scale);
  const displaySize = Math.round(CharacterImageSize * clampedScale);
  const padding = Math.round(Math.max(32, 96 * clampedScale));
  const paddingTop = Math.round(Math.max(112, 224 * clampedScale));

  return {
    scale: clampedScale,
    imageSize: CharacterImageSize,
    displaySize,
    paddingTop,
    paddingRight: padding,
    paddingBottom: padding,
    paddingLeft: padding,
    windowWidth: displaySize + padding * 2,
    windowHeight: displaySize + paddingTop + padding,
    grabImageX: CharacterGrabImageX,
    grabImageY: CharacterGrabImageY,
    grabDisplayX: Math.round(CharacterGrabImageX * clampedScale),
    grabDisplayY: Math.round(CharacterGrabImageY * clampedScale),
  };
}
