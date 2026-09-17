import type { ButtonImageFormat, DeviceEvent, DeviceInfo, DeviceState } from "@open-panel/shared";
import type { DeckDevice, Disposable } from "./device.js";

/**
 * Turns an icon into the bytes one device wants. Declared here and implemented
 * by the host (apps/daemon/src/button-image.ts) so that device-sdk — which is
 * also the SDK plugins compile against — stays free of any image library.
 *
 * `image` absent asks for a blank frame: same format, solid black.
 */
export type ButtonImageEncoder = (request: {
  deviceId: string;
  position: number;
  image?: Buffer;
  format: ButtonImageFormat;
}) => Promise<Buffer>;

export interface DeviceConnectionManagerOptions {
  /** Base delay before the first reconnect attempt, in ms. Default 1000. */
  baseRetryDelayMs?: number;
  /** Cap for exponential backoff, in ms. Default 30000. */
  maxRetryDelayMs?: number;
  logger?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  /**
   * Required for any device declaring `capabilities.buttonImage`; without it
   * such a device would be handed whatever the profile happens to store and
   * would have no way to make sense of it.
   */
  encodeButtonImage?: ButtonImageEncoder;
}

type Listener<T> = (payload: T) => void;

/**
 * Wraps a single DeckDevice and enforces the required lifecycle state machine
 * (specs.md #11): DISCOVERED -> CONNECTING -> CONNECTED -> DISCONNECTED ->
 * RECONNECTING -> CONNECTED, with automatic background reconnection.
 *
 * A device failure here (connect() rejecting, or an unexpected disconnect)
 * MUST NOT throw out of this class — the daemon must never crash because a
 * USB device was unplugged.
 */
export class DeviceConnectionManager {
  private state: DeviceState = "discovered";
  private stateListeners = new Set<Listener<DeviceInfo>>();
  private eventListeners = new Set<Listener<DeviceEvent>>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private deviceEventSub: Disposable | undefined;

  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly logger: NonNullable<DeviceConnectionManagerOptions["logger"]>;
  private readonly encodeButtonImage: ButtonImageEncoder | undefined;

  constructor(
    private readonly device: DeckDevice,
    options: DeviceConnectionManagerOptions = {},
  ) {
    this.encodeButtonImage = options.encodeButtonImage;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.logger = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  get info(): DeviceInfo {
    return { ...this.device.info, state: this.state };
  }

  onStateChange(listener: Listener<DeviceInfo>): Disposable {
    this.stateListeners.add(listener);
    return { dispose: () => this.stateListeners.delete(listener) };
  }

  onDeviceEvent(listener: Listener<DeviceEvent>): Disposable {
    this.eventListeners.add(listener);
    return { dispose: () => this.eventListeners.delete(listener) };
  }

  async setButtonImage(position: number, image: Buffer): Promise<void> {
    if (this.state !== "connected") throw new Error(`Device ${this.device.id} is not connected`);
    await this.device.setButtonImage(position, await this.encode(position, image));
  }

  async setButtonLabel(position: number, label: string): Promise<void> {
    if (this.state !== "connected") throw new Error(`Device ${this.device.id} is not connected`);
    if (!this.device.setButtonLabel) return; // capability not supported — silently a no-op (specs.md #9)
    await this.device.setButtonLabel(position, label);
  }

  async clearButtonImage(position: number): Promise<void> {
    if (this.state !== "connected") throw new Error(`Device ${this.device.id} is not connected`);
    if (!this.device.clearButtonImage) return; // capability not supported — silently a no-op (specs.md #9)
    await this.device.clearButtonImage(position, await this.blank(position));
  }

  async flush(): Promise<void> {
    if (this.state !== "connected") throw new Error(`Device ${this.device.id} is not connected`);
    if (!this.device.flush) return; // capability not supported — silently a no-op (specs.md #9)
    await this.device.flush();
  }

  /**
   * The one place an icon becomes pixels. A device that declares no image
   * format is handed the bytes untouched — that is a device the host has no
   * opinion about, e.g. the mock used in tests.
   */
  private async encode(position: number, image?: Buffer): Promise<Buffer> {
    const format = this.device.capabilities.buttonImage;
    if (!format || !this.encodeButtonImage) return image ?? Buffer.alloc(0);
    return this.encodeButtonImage({ deviceId: this.device.id, position, image, format });
  }

  /** A solid black frame in this device's format, or nothing to give it. */
  private async blank(position: number): Promise<Buffer | undefined> {
    const format = this.device.capabilities.buttonImage;
    if (!format || !this.encodeButtonImage) return undefined;
    return this.encode(position);
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    this.setState("connecting");
    try {
      await this.device.connect();
      this.deviceEventSub = this.device.onEvent((event) => {
        for (const l of this.eventListeners) l(event);
      });
      this.reconnectAttempt = 0;
      this.setState("connected");
    } catch (err) {
      this.logger.warn("device connect failed", { deviceId: this.device.id, error: String(err) });
      this.setState("error");
      this.scheduleReconnect();
    }
  }

  /** Call when the adapter reports the device physically disappeared. */
  notifyDisconnected(): void {
    if (this.disposed || this.state === "disconnected" || this.state === "reconnecting") return;
    this.deviceEventSub?.dispose();
    this.deviceEventSub = undefined;
    this.setState("disconnected");
    this.scheduleReconnect();
  }

  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    this.deviceEventSub?.dispose();
    this.deviceEventSub = undefined;
    try {
      await this.device.disconnect();
    } catch (err) {
      this.logger.warn("device disconnect threw, ignoring", {
        deviceId: this.device.id,
        error: String(err),
      });
    }
    this.setState("disconnected");
  }

  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    this.deviceEventSub?.dispose();
    this.stateListeners.clear();
    this.eventListeners.clear();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.clearReconnectTimer();
    this.setState("reconnecting");
    const delay = Math.min(
      this.maxRetryDelayMs,
      this.baseRetryDelayMs * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.logger.info("scheduling device reconnect", {
      deviceId: this.device.id,
      delayMs: delay,
      attempt: this.reconnectAttempt,
    });
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private setState(state: DeviceState): void {
    this.state = state;
    const info = this.info;
    for (const l of this.stateListeners) l(info);
  }
}
