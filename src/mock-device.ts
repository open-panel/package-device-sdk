import type {
  DeviceCapabilities,
  DeviceEvent,
  DeviceEventListener,
  DeviceInfo,
} from "@open-panel/shared";
import type { DeckDevice, DeviceDriver, Disposable } from "./device.js";

/**
 * In-memory DeckDevice used by tests and by `openpanel devices --mock` style
 * development flows. Lets the entire stack (device-sdk, core, action-engine,
 * IPC) be exercised without physical hardware (specs.md #7 Rule 7, #26).
 */
export class MockDevice implements DeckDevice {
  readonly capabilities: DeviceCapabilities;
  private listeners = new Set<DeviceEventListener>();
  private connected = false;
  readonly buttonImages = new Map<number, Buffer>();
  readonly buttonLabels = new Map<number, string>();

  constructor(
    readonly id: string,
    capabilities: Partial<DeviceCapabilities> = {},
  ) {
    this.capabilities = {
      buttons: 15,
      hasDisplay: false,
      supportsButtonImages: true,
      supportsButtonLabels: true,
      hasEncoders: false,
      hasTouchscreen: false,
      supportsImageCalibration: false,
      ...capabilities,
    };
  }

  get info(): DeviceInfo {
    return {
      id: this.id,
      driverId: "mock",
      vendor: "OpenPanel",
      product: "Mock Device",
      capabilities: this.capabilities,
      state: this.connected ? "connected" : "disconnected",
    };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  onEvent(listener: DeviceEventListener): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async setButtonImage(position: number, image: Buffer): Promise<void> {
    this.buttonImages.set(position, image);
  }

  async setButtonLabel(position: number, label: string): Promise<void> {
    this.buttonLabels.set(position, label);
  }

  /** Test/dev helper: simulate a physical button press. */
  simulatePress(position: number): void {
    this.emit({ type: "button.press", deviceId: this.id, position, timestamp: Date.now() });
  }

  simulateRelease(position: number): void {
    this.emit({ type: "button.release", deviceId: this.id, position, timestamp: Date.now() });
  }

  private emit(event: DeviceEvent): void {
    for (const l of this.listeners) l(event);
  }
}

/** Driver that exposes a fixed set of MockDevices — used in tests and `--mock` dev mode. */
export class MockDriver implements DeviceDriver {
  readonly driverId = "mock";
  private readonly devices: MockDevice[];

  constructor(devices: MockDevice[] = [new MockDevice("mock-1")]) {
    this.devices = devices;
  }

  async discover(): Promise<DeckDevice[]> {
    return this.devices;
  }
}
