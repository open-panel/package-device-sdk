import type { DeviceEvent, DeviceInfo } from "@open-panel/shared";
import type { DeckDevice, DeviceDriver, Disposable } from "./device.js";
import {
  DeviceConnectionManager,
  type DeviceConnectionManagerOptions,
} from "./connection-manager.js";

export interface DriverRegistryOptions extends DeviceConnectionManagerOptions {
  /** How often to poll drivers without a `watch()` implementation, in ms. Default 5000. */
  pollIntervalMs?: number;
}

type DeviceListener = (info: DeviceInfo) => void;
type EventListener = (event: DeviceEvent) => void;

/**
 * Holds every registered DeviceDriver (one per adapter, e.g. "fifine-d6") and turns
 * discovered DeckDevice instances into managed connections. Adding a new device
 * family only requires a plugin contributing a driver — no core changes
 * (specs.md #1, #9): the daemon registers what `contributes.devices` handed it
 * and knows nothing about any particular hardware (Rule 3).
 */
export class DriverRegistry {
  private readonly drivers = new Map<string, DeviceDriver>();
  private readonly managers = new Map<string, DeviceConnectionManager>();
  private readonly ownerDriverId = new Map<string, string>();
  private readonly watchers: Disposable[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Whether start() has already run. A driver can arrive afterwards now that a
   * device plugin can be installed from the UI into a running daemon, and one
   * registered late has to be brought up to where the others already are.
   */
  private started = false;
  private readonly connectedListeners = new Set<DeviceListener>();
  private readonly disconnectedListeners = new Set<DeviceListener>();
  private readonly stateChangedListeners = new Set<DeviceListener>();
  private readonly deviceEventListeners = new Set<EventListener>();

  constructor(private readonly options: DriverRegistryOptions = {}) {}

  register(driver: DeviceDriver): void {
    // Drivers arrive from plugins, so two of them can genuinely claim the same
    // id — a fork of a driver dropped in ~/.openpanel/plugins next to the
    // bundled one. The last registration wins (same rule as plugin shadowing),
    // but silently losing a driver is not something an author should have to
    // deduce from an absent device.
    if (this.drivers.has(driver.driverId)) {
      this.options.logger?.warn("driver.shadowed", { driverId: driver.driverId });
    }
    this.drivers.set(driver.driverId, driver);

    // Registered after start(): its watch() was never installed and it has
    // missed every discovery pass so far. Without this a device plugin
    // installed into a running daemon would only be found on the next poll,
    // and a watch-only driver never at all.
    if (this.started) {
      this.watchDriver(driver);
      void this.discoverDriver(driver);
    }
  }

  onDeviceConnected(listener: DeviceListener): Disposable {
    this.connectedListeners.add(listener);
    return { dispose: () => this.connectedListeners.delete(listener) };
  }

  onDeviceDisconnected(listener: DeviceListener): Disposable {
    this.disconnectedListeners.add(listener);
    return { dispose: () => this.disconnectedListeners.delete(listener) };
  }

  onDeviceStateChanged(listener: DeviceListener): Disposable {
    this.stateChangedListeners.add(listener);
    return { dispose: () => this.stateChangedListeners.delete(listener) };
  }

  onDeviceEvent(listener: EventListener): Disposable {
    this.deviceEventListeners.add(listener);
    return { dispose: () => this.deviceEventListeners.delete(listener) };
  }

  listDevices(): DeviceInfo[] {
    return [...this.managers.values()].map((m) => m.info);
  }

  /** Runs one discovery pass across every registered driver and starts watchers. */
  async start(): Promise<void> {
    this.started = true;
    for (const driver of this.drivers.values()) this.watchDriver(driver);
    await this.discoverOnce();
    const interval = this.options.pollIntervalMs ?? 5000;
    this.pollTimer = setInterval(() => void this.discoverOnce(), interval);
  }

  async discoverOnce(): Promise<void> {
    for (const driver of this.drivers.values()) await this.discoverDriver(driver);
  }

  private watchDriver(driver: DeviceDriver): void {
    if (!driver.watch) return;
    const sub = driver.watch(
      (device) => void this.adopt(device, driver.driverId),
      (deviceId) => this.remove(deviceId),
    );
    this.watchers.push(sub);
  }

  private async discoverDriver(driver: DeviceDriver): Promise<void> {
    try {
      const devices = await driver.discover();
      const seenIds = new Set(devices.map((d) => d.id));
      for (const device of devices) await this.adopt(device, driver.driverId);

      // Drivers without a watch() only get us here via polling — detect
      // disappearance ourselves so unplugging still reaches DISCONNECTED
      // (specs.md #11) instead of the manager staying CONNECTED forever.
      // Ownership is tracked by which driver adopted a device, not by the
      // device's own (adapter-reported) driverId field, since those can
      // legitimately differ (e.g. in tests, or a driver aggregating
      // multiple device families).
      if (!driver.watch) {
        for (const deviceId of this.managers.keys()) {
          if (this.ownerDriverId.get(deviceId) === driver.driverId && !seenIds.has(deviceId)) {
            this.remove(deviceId);
          }
        }
      }
    } catch (err) {
      this.options.logger?.warn("driver discovery failed", {
        driverId: driver.driverId,
        error: String(err),
      });
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const w of this.watchers) w.dispose();
    this.watchers.length = 0;
    for (const manager of this.managers.values()) {
      await manager.disconnect();
      manager.dispose();
    }
    this.managers.clear();
    this.ownerDriverId.clear();
  }

  getDevice(deviceId: string): DeviceConnectionManager | undefined {
    return this.managers.get(deviceId);
  }

  private async adopt(device: DeckDevice, driverId: string): Promise<void> {
    if (this.managers.has(device.id)) return;
    this.ownerDriverId.set(device.id, driverId);
    const manager = new DeviceConnectionManager(device, this.options);
    this.managers.set(device.id, manager);
    manager.onStateChange((info) => {
      for (const l of this.stateChangedListeners) l(info);
      if (info.state === "connected") for (const l of this.connectedListeners) l(info);
      if (info.state === "disconnected") for (const l of this.disconnectedListeners) l(info);
    });
    manager.onDeviceEvent((event) => {
      for (const l of this.deviceEventListeners) l(event);
    });
    await manager.connect();
  }

  private remove(deviceId: string): void {
    const manager = this.managers.get(deviceId);
    if (!manager) return;
    manager.notifyDisconnected();
  }
}
