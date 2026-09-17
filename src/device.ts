import type {
  DeviceCapabilities,
  DeviceEventListener,
  DeviceInfo,
} from "@open-panel/shared";

export interface Disposable {
  dispose(): void;
}

/**
 * Hardware-agnostic device abstraction (specs.md #9).
 * Every adapter (e.g. plugins/fifine-d6) implements this — the core and
 * daemon never depend on a concrete device implementation, only on this
 * interface.
 */
export interface DeckDevice {
  readonly id: string;
  readonly info: DeviceInfo;
  readonly capabilities: DeviceCapabilities;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  onEvent(listener: DeviceEventListener): Disposable;

  /**
   * `image` is already in the format this device declared as
   * `capabilities.buttonImage` — right size, right rotation, right encoding,
   * with the user's calibration applied. An adapter writes these bytes; it
   * does not decode, resize or encode anything (see ButtonImageFormat).
   */
  setButtonImage(position: number, image: Buffer): Promise<void>;

  setButtonLabel?(position: number, label: string): Promise<void>;

  /**
   * Blanks a position's image — devices with a screen should implement this so
   * a removed/icon-less button doesn't keep showing stale art.
   *
   * `blank` is a frame of solid black in this device's declared format, for
   * hardware whose clear command does not actually overwrite every pixel; it
   * is there so producing one costs an adapter no image code of its own.
   */
  clearButtonImage?(position: number, blank?: Buffer): Promise<void>;

  /**
   * Commits a batch of `setButtonImage`/`clearButtonImage` calls. Devices
   * that need this should queue those calls instead of writing immediately,
   * and only push to the physical screen here — some hardware's internal
   * state gets confused by committing after every single button instead of
   * once per batch. Core calls this once after rendering every position.
   */
  flush?(): Promise<void>;

  // Image calibration used to be three more methods here, each adapter
  // holding the live margin/offsets and re-encoding its own cache. It is the
  // host's now (apps/daemon/src/button-image.ts): the daemon is where the
  // values are persisted, so keeping a second copy in the device only created
  // the question of what happens to it on reconnect. An adapter declares
  // `capabilities.supportsImageCalibration` and receives calibrated pixels.
}

/**
 * A driver discovers and instantiates DeckDevice instances for one hardware family.
 * One driver per adapter (e.g. "fifine-d6"). Adding a device requires only
 * implementing this interface and contributing it from a plugin's
 * `contributes.devices` — no core changes, and no edit to the daemon
 * (docs/PLUGINS.md).
 */
export interface DeviceDriver {
  readonly driverId: string;

  /** One-shot discovery, used on daemon startup and periodic rescans. */
  discover(): Promise<DeckDevice[]>;

  /**
   * Optional hot-plug watcher. When supported, the driver calls back as devices
   * appear/disappear instead of relying solely on polling.
   */
  watch?(
    onArrived: (device: DeckDevice) => void,
    onRemoved: (deviceId: string) => void,
  ): Disposable;
}
