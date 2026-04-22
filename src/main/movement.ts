import { screen, type BrowserWindow } from "electron";
import { performance } from "node:perf_hooks";
import type { CharacterState, Facing, PointerSample, SpeechMessage } from "../shared/character-state.js";
import type { DesktopFloor } from "./display.js";

const WalkSpeed = 80;
const Gravity = 1800;
const Restitution = 0.35;
const ThrowVelocityScale = 0.9;
const SettleSpeed = 140;
const SetDownSnapDistance = 8;
const MaxFallSpeed = 1400;
const MaxDeltaSeconds = 0.05;
const DragFollowSharpness = 18;
const DragMaxRotation = 35;
const DragLagRotationScale = 0.42;
const DragVelocityRotationScale = 0.075;
const DragRotationSpring = 76;
const DragRotationDamping = 7;
const MinIdleSeconds = 1.2;
const MaxIdleSeconds = 4.5;
const MinWalkSeconds = 1.2;
const MaxWalkSeconds = 3.8;
const PostThrowRestSeconds = 3;
const LandedPoseDelaySeconds = 0.2;
const DefaultTickIntervalMs = 16;
const MinTickIntervalMs = 4;
const MaxTickIntervalMs = 33;

export interface WalkerOptions {
  readonly window: BrowserWindow;
  readonly floor: DesktopFloor;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly renderOffsetX: number;
  readonly renderOffsetY: number;
  readonly grabOffsetX: number;
  readonly grabOffsetY: number;
}

export class DesktopWalker {
  private readonly window: BrowserWindow;
  private floor: DesktopFloor;
  private readonly width: number;
  private readonly height: number;
  private viewportWidth: number;
  private viewportHeight: number;
  private readonly renderOffsetX: number;
  private readonly baseRenderOffsetY: number;
  private readonly baseViewportHeight: number;
  private renderOffsetY: number;
  private readonly grabOffsetX: number;
  private readonly grabOffsetY: number;
  private timer: NodeJS.Timeout | undefined;
  private lastTickTime: number | undefined;
  private x: number;
  private y: number;
  private velocityX = WalkSpeed;
  private velocityY = 0;
  private facing: Facing = "right";
  private motion: CharacterState["motion"] = "idle";
  private nextBehaviorTime = 0;
  private readonly samples: PointerSample[] = [];
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private dragTargetX = 0;
  private dragTargetY = 0;
  private dragRotation = 0;
  private dragAngularVelocity = 0;
  private landedPoseTime: number | undefined;
  private speechTimeout: NodeJS.Timeout | undefined;
  private lastWindowBounds:
    | {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      }
    | undefined;
  private destroyed = false;

  public constructor(options: WalkerOptions) {
    this.window = options.window;
    this.floor = options.floor;
    this.width = options.width;
    this.height = options.height;
    this.viewportWidth = options.viewportWidth;
    this.viewportHeight = options.viewportHeight;
    this.renderOffsetX = options.renderOffsetX;
    this.baseRenderOffsetY = options.renderOffsetY;
    this.baseViewportHeight = options.viewportHeight;
    this.renderOffsetY = options.renderOffsetY;
    this.grabOffsetX = options.grabOffsetX;
    this.grabOffsetY = options.grabOffsetY;
    this.x = options.floor.x + 40;
    this.y = options.floor.y;
  }

  public start(): void {
    if (this.destroyed || this.window.isDestroyed()) {
      return;
    }

    if (this.timer !== undefined) {
      return;
    }

    this.startIdle();
    this.publishState();
    this.lastTickTime = performance.now();
    this.scheduleNextTick();
  }

  public stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.lastTickTime = undefined;

    if (this.speechTimeout !== undefined) {
      clearTimeout(this.speechTimeout);
      this.speechTimeout = undefined;
    }
  }

  public destroy(): void {
    this.destroyed = true;
    this.stop();
  }

  public getMotion(): CharacterState["motion"] {
    return this.motion;
  }

  public getScreenPosition(): { readonly x: number; readonly y: number } {
    return {
      x: this.x,
      y: this.y,
    };
  }

  public updateFloor(floor: DesktopFloor): void {
    if (this.destroyed || this.window.isDestroyed()) {
      return;
    }

    this.floor = floor;
    this.keepInWorkArea();
    this.moveWindow();
  }

  public updateSpeechBubbleHeight(height: number): void {
    if (this.destroyed || this.window.isDestroyed() || !Number.isFinite(height)) {
      return;
    }

    const availableAboveCharacter = Math.max(0, this.y - this.floor.top);
    const desiredRenderOffsetY = Math.ceil(height + 32 - this.height * 0.16);
    const nextRenderOffsetY = this.clamp(Math.max(this.baseRenderOffsetY, desiredRenderOffsetY), this.baseRenderOffsetY, availableAboveCharacter);

    if (nextRenderOffsetY === this.renderOffsetY) {
      return;
    }

    this.renderOffsetY = nextRenderOffsetY;
    this.viewportHeight = this.baseViewportHeight + (this.renderOffsetY - this.baseRenderOffsetY);
    this.moveWindow();
    this.publishState();
  }

  public beginDrag(_sample: PointerSample): void {
    if (this.destroyed || this.window.isDestroyed()) {
      return;
    }

    this.ensureTimer();
    this.motion = "drag";
    this.velocityX = 0;
    this.velocityY = 0;
    this.dragOffsetX = this.grabOffsetX;
    this.dragOffsetY = this.grabOffsetY;
    this.dragRotation = 0;
    this.dragAngularVelocity = 0;
    this.samples.length = 0;
    this.addCursorSample();
    this.updateDragTarget();
    this.publishState();
  }

  public drag(sample: PointerSample): void {
    if (this.destroyed || this.window.isDestroyed()) {
      return;
    }

    if (this.motion !== "drag") {
      return;
    }

    this.addCursorSample();
    this.updateDragTarget();
    this.publishState();
  }

  public endDrag(): void {
    if (this.destroyed || this.window.isDestroyed()) {
      return;
    }

    if (this.motion !== "drag") {
      return;
    }

    this.addCursorSample();
    const velocity = this.calculateReleaseVelocity();
    this.velocityX = velocity.x;
    this.velocityY = velocity.y;
    this.dragRotation = 0;
    this.dragAngularVelocity = 0;
    this.landedPoseTime = undefined;

    if (Math.abs(this.velocityX) < SettleSpeed && Math.abs(this.velocityY) < SettleSpeed) {
      if (this.floor.y - this.y <= SetDownSnapDistance) {
        this.y = this.floor.y;
        this.startIdle(PostThrowRestSeconds);
      } else {
        this.motion = "throw";
        this.velocityX = 0;
      }

      this.velocityY = 0;
      this.moveWindow();
      this.publishState();
      return;
    }

    this.motion = "throw";
    this.publishState();
  }

  public speak(message: SpeechMessage): void {
    if (this.destroyed || this.window.isDestroyed()) {
      return;
    }

    if (message.loading === true) {
      this.beginThink();
    } else {
      this.beginTalk();
    }

    this.window.webContents.send("speech", message);

    if (this.speechTimeout !== undefined) {
      clearTimeout(this.speechTimeout);
      this.speechTimeout = undefined;
    }

    if (message.loading !== true) {
      this.speechTimeout = setTimeout(() => {
        this.speechTimeout = undefined;
        if (this.motion === "talk" || this.motion === "think") {
          this.endTalk();
        }
      }, 5000);
    }
  }

  public beginTalk(): void {
    if (this.destroyed || this.window.isDestroyed()) {
      return;
    }

    this.ensureTimer();
    this.motion = "talk";
    this.velocityX = 0;
    this.velocityY = 0;
    this.publishState();
  }

  public beginThink(): void {
    if (this.destroyed || this.window.isDestroyed()) {
      return;
    }

    this.ensureTimer();
    this.motion = "think";
    this.velocityX = 0;
    this.velocityY = 0;
    this.publishState();
  }

  public endTalk(): void {
    if (this.destroyed || this.window.isDestroyed()) {
      this.stop();
      return;
    }

    if (this.speechTimeout !== undefined) {
      clearTimeout(this.speechTimeout);
      this.speechTimeout = undefined;
    }

    if (this.motion !== "talk" && this.motion !== "think") {
      return;
    }

    this.startIdle();
    this.velocityY = 0;
    this.publishState();
  }

  private tick(): void {
    if (this.destroyed || this.window.isDestroyed()) {
      this.stop();
      return;
    }

    this.timer = undefined;
    const now = performance.now();
    const previous = this.lastTickTime ?? now;
    const deltaSeconds = Math.min((now - previous) / 1000, MaxDeltaSeconds);
    this.lastTickTime = now;

    if (this.motion === "drag") {
      this.tickDrag(deltaSeconds);
      this.scheduleNextTick();
      return;
    }

    if (this.motion === "throw") {
      this.tickThrow(deltaSeconds);
      this.scheduleNextTick();
      return;
    }

    if (this.motion === "talk" || this.motion === "think") {
      this.scheduleNextTick();
      return;
    }

    if (this.motion === "idle") {
      this.tickIdle(now);
      this.scheduleNextTick();
      return;
    }

    this.tickWalk(deltaSeconds);
    this.scheduleNextTick();
  }

  private tickIdle(now: number): void {
    this.y = this.floor.y;
    this.velocityX = 0;
    this.velocityY = 0;
    this.moveWindow();
    this.publishState();

    if (now >= this.nextBehaviorTime) {
      this.startWalk();
    }
  }

  private tickWalk(deltaSeconds: number): void {
    const leftLimit = this.floor.x;
    const rightLimit = this.floor.x + this.floor.width - this.width;

    this.y = this.floor.y;
    this.x += this.velocityX * deltaSeconds;

    if (this.x <= leftLimit) {
      this.x = leftLimit;
      this.facing = "right";
      this.startIdle();
    }

    if (this.x >= rightLimit) {
      this.x = rightLimit;
      this.facing = "left";
      this.startIdle();
    }

    if (performance.now() >= this.nextBehaviorTime) {
      this.startIdle();
    }

    this.moveWindow();
    this.publishState();
  }

  private tickDrag(deltaSeconds: number): void {
    this.addCursorSample();
    this.updateDragTarget();

    const previousX = this.x;
    const previousY = this.y;
    const alpha = 1 - Math.exp(-DragFollowSharpness * deltaSeconds);
    this.x += (this.dragTargetX - this.x) * alpha;
    this.y += (this.dragTargetY - this.y) * alpha;
    this.keepInWorkArea();

    const elapsedSeconds = Math.max(deltaSeconds, 0.001);
    const followVelocityX = (this.x - previousX) / elapsedSeconds;
    const followVelocityY = (this.y - previousY) / elapsedSeconds;
    const targetRotation = this.clamp(
      (this.x - this.dragTargetX) * -DragLagRotationScale + followVelocityX * DragVelocityRotationScale,
      -DragMaxRotation,
      DragMaxRotation,
    );
    const rotationAcceleration = (targetRotation - this.dragRotation) * DragRotationSpring - this.dragAngularVelocity * DragRotationDamping;
    this.dragAngularVelocity += rotationAcceleration * deltaSeconds;
    this.dragRotation += this.dragAngularVelocity * deltaSeconds;

    if (this.dragRotation <= -DragMaxRotation || this.dragRotation >= DragMaxRotation) {
      this.dragRotation = this.clamp(this.dragRotation, -DragMaxRotation, DragMaxRotation);
      this.dragAngularVelocity *= -0.18;
    }

    this.velocityX = followVelocityX;
    this.velocityY = followVelocityY;
    this.publishState();
    this.moveWindow();
  }

  private tickThrow(deltaSeconds: number): void {
    if (this.landedPoseTime !== undefined) {
      this.x += this.velocityX * deltaSeconds;
      this.velocityX *= Math.exp(-8 * deltaSeconds);
      this.velocityY = 0;
      this.y = this.floor.y;
      this.keepInWorkArea();
      this.moveWindow();

      if (performance.now() >= this.landedPoseTime) {
        this.landedPoseTime = undefined;
        this.startIdle(PostThrowRestSeconds);
      }

      this.publishState();
      return;
    }

    const leftLimit = this.floor.x;
    const rightLimit = this.floor.x + this.floor.width - this.width;

    this.velocityY += Gravity * deltaSeconds;
    this.velocityY = Math.min(this.velocityY, MaxFallSpeed);
    this.x += this.velocityX * deltaSeconds;
    this.y += this.velocityY * deltaSeconds;

    if (this.x <= leftLimit) {
      this.x = leftLimit;
      this.velocityX = Math.abs(this.velocityX) * Restitution;
    }

    if (this.x >= rightLimit) {
      this.x = rightLimit;
      this.velocityX = -Math.abs(this.velocityX) * Restitution;
    }

    if (this.y <= this.floor.top) {
      this.y = this.floor.top;
      this.velocityY = Math.abs(this.velocityY) * Restitution;
    }

    if (this.y >= this.floor.y) {
      this.y = this.floor.y;

      if (Math.abs(this.velocityY) < SettleSpeed) {
        this.landedPoseTime = performance.now() + LandedPoseDelaySeconds * 1000;
        this.velocityY = 0;
      } else {
        this.velocityY = -this.velocityY * Restitution;
        this.velocityX *= 0.7;
      }
    }

    if (this.motion === "throw" && Math.abs(this.velocityX) > 1) {
      this.facing = this.velocityX < 0 ? "left" : "right";
    }
    this.keepInWorkArea();
    this.moveWindow();
    this.publishState();
  }

  private moveWindow(): void {
    if (this.destroyed || this.window.isDestroyed()) {
      return;
    }

    const bounds = {
      x: Math.round(this.x - this.renderOffsetX),
      y: Math.round(this.y - this.renderOffsetY),
      width: this.viewportWidth,
      height: this.viewportHeight,
    };

    if (
      this.lastWindowBounds !== undefined &&
      this.lastWindowBounds.x === bounds.x &&
      this.lastWindowBounds.y === bounds.y &&
      this.lastWindowBounds.width === bounds.width &&
      this.lastWindowBounds.height === bounds.height
    ) {
      return;
    }

    this.lastWindowBounds = bounds;
    this.window.setBounds(bounds);
  }

  private publishState(): void {
    if (this.destroyed || this.window.isDestroyed()) {
      return;
    }

    const state: CharacterState = {
      facing: this.facing,
      motion: this.motion,
      rotation: this.motion === "drag" ? this.dragRotation : 0,
      renderX: this.renderOffsetX,
      renderY: this.renderOffsetY,
    };

    this.window.webContents.send("character-state", state);
  }

  private startIdle(durationSeconds = this.randomBetween(MinIdleSeconds, MaxIdleSeconds)): void {
    this.motion = "idle";
    this.velocityX = 0;
    this.velocityY = 0;
    this.dragRotation = 0;
    this.dragAngularVelocity = 0;
    this.landedPoseTime = undefined;
    this.nextBehaviorTime = performance.now() + durationSeconds * 1000;
  }

  private startWalk(): void {
    const leftLimit = this.floor.x;
    const rightLimit = this.floor.x + this.floor.width - this.width;
    const canWalkLeft = this.x > leftLimit + 1;
    const canWalkRight = this.x < rightLimit - 1;

    if (!canWalkLeft && !canWalkRight) {
      this.startIdle();
      return;
    }

    const direction: Facing = canWalkLeft && canWalkRight ? (Math.random() < 0.5 ? "left" : "right") : canWalkLeft ? "left" : "right";
    this.facing = direction;
    this.motion = "walk";
    this.velocityX = direction === "left" ? -WalkSpeed : WalkSpeed;
    this.velocityY = 0;
    this.nextBehaviorTime = performance.now() + this.randomBetween(MinWalkSeconds, MaxWalkSeconds) * 1000;
  }

  private randomBetween(minimum: number, maximum: number): number {
    return minimum + Math.random() * (maximum - minimum);
  }

  private ensureTimer(): void {
    if (this.timer === undefined) {
      this.start();
    }
  }

  private scheduleNextTick(): void {
    if (this.destroyed || this.window.isDestroyed()) {
      this.stop();
      return;
    }

    this.timer = setTimeout(() => this.tick(), this.getTickIntervalMs());
  }

  private getTickIntervalMs(): number {
    const display = screen.getDisplayNearestPoint({ x: Math.round(this.x), y: Math.round(this.y) });
    const frequency = display.displayFrequency;

    if (!Number.isFinite(frequency) || frequency <= 0) {
      return DefaultTickIntervalMs;
    }

    return this.clamp(Math.round(1000 / frequency), MinTickIntervalMs, MaxTickIntervalMs);
  }

  private updateDragTarget(): void {
    const cursor = screen.screenToDipPoint(screen.getCursorScreenPoint());
    this.dragTargetX = this.clampX(cursor.x - this.dragOffsetX);
    this.dragTargetY = this.clampY(cursor.y - this.dragOffsetY);
  }

  private addCursorSample(): void {
    const cursor = screen.screenToDipPoint(screen.getCursorScreenPoint());
    this.samples.push({
      screenX: cursor.x,
      screenY: cursor.y,
      offsetX: this.dragOffsetX,
      offsetY: this.dragOffsetY,
      time: performance.now(),
    });

    while (this.samples.length > 8) {
      this.samples.shift();
    }
  }

  private keepInWorkArea(): void {
    this.x = this.clampX(this.x);
    this.y = this.clampY(this.y);
  }

  private clampX(value: number): number {
    const leftLimit = this.floor.x;
    const rightLimit = this.floor.x + this.floor.width - this.width;

    return this.clamp(value, leftLimit, rightLimit);
  }

  private clampY(value: number): number {
    return this.clamp(value, this.floor.top, this.floor.y);
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
  }

  private calculateReleaseVelocity(): { readonly x: number; readonly y: number } {
    const first = this.samples.at(0);
    const last = this.samples.at(-1);

    if (first === undefined || last === undefined || first.time === last.time) {
      return { x: 0, y: 0 };
    }

    const elapsedSeconds = Math.max((last.time - first.time) / 1000, 0.001);
    return {
      x: ((last.screenX - first.screenX) / elapsedSeconds) * ThrowVelocityScale,
      y: ((last.screenY - first.screenY) / elapsedSeconds) * ThrowVelocityScale,
    };
  }
}
